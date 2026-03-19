use crate::agent::{
    self, agent_get_inventory_machines, agent_monitor_initialize_workspace_from_context,
    agent_prepare_hosts_env_from_context, JarvisPrepareHostsEnvInput,
};
use crate::app_context::AppContext;
use crate::event_bus::EventBus;
use crate::monitor::{
    get_monitor_agent_snapshot, get_monitor_inventory_path, get_monitor_node_details,
    get_monitor_security_state, get_monitor_snapshot, get_monitor_user_manual_markdown,
    get_monitor_workspace_path, monitor_apply_testbeta_topology_from_context,
    monitor_assign_ssh_binding, monitor_bulk_node_control, monitor_delete_operator,
    monitor_delete_ssh_profile, monitor_detect_local_vpn_identity,
    monitor_ensure_ssh_keypair_from_context, monitor_export_node_data, monitor_get_setup_status,
    monitor_initialize_workspace_from_context, monitor_mark_setup_complete, monitor_node_control,
    monitor_remove_ssh_binding, monitor_run_terminal_command, monitor_set_active_operator,
    monitor_update_local_agent_from_context, monitor_upsert_operator, monitor_upsert_ssh_profile,
    MonitorOperatorInput, MonitorSshBindingInput, MonitorSshProfileInput,
};
use crate::testnet_beta::{
    testbeta_get_catalog, testbeta_get_device_profile, testbeta_get_live_status,
    testbeta_get_state, testbeta_node_control, testbeta_remove_node, testbeta_setup_node,
    TestnetBetaNodeControlInput, TestnetBetaRemoveNodeInput, TestnetBetaSetupInput,
};
use async_stream::stream;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
struct ControlServiceState {
    token: Arc<String>,
    app_context: AppContext,
    event_bus: EventBus,
}

#[derive(Debug, Serialize)]
struct ControlServiceHealth {
    status: String,
    version: String,
    workspace_path: String,
    resource_roots: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct InvokeRequest {
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Deserialize)]
struct EventQuery {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperatorIdArgs {
    operator_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileIdArgs {
    profile_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeSlotArgs {
    node_slot_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeActionArgs {
    node_slot_id: String,
    action: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BulkActionArgs {
    action: String,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupCompleteArgs {
    physical_machine_id: String,
    node_slot_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct UpsertOperatorArgs {
    input: MonitorOperatorInput,
}

#[derive(Debug, Deserialize)]
struct UpsertProfileArgs {
    input: MonitorSshProfileInput,
}

#[derive(Debug, Deserialize)]
struct AssignBindingArgs {
    input: MonitorSshBindingInput,
}

#[derive(Debug, Deserialize)]
struct PrepareHostsArgs {
    input: JarvisPrepareHostsEnvInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalCommandArgs {
    command: String,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TestnetBetaSetupArgs {
    input: TestnetBetaSetupInput,
}

#[derive(Debug, Deserialize)]
struct TestnetBetaNodeControlArgs {
    input: TestnetBetaNodeControlInput,
}

#[derive(Debug, Deserialize)]
struct TestnetBetaRemoveNodeArgs {
    input: TestnetBetaRemoveNodeInput,
}

pub async fn serve(port: u16, token: String, app_context: AppContext) -> Result<(), String> {
    let event_bus = EventBus::new(128);
    let state = ControlServiceState {
        token: Arc::new(token),
        app_context: app_context.clone(),
        event_bus: event_bus.clone(),
    };

    match monitor_initialize_workspace_from_context(&app_context) {
        Ok(workspace) => {
            event_bus.emit_json(
                "service-startup",
                json!({ "status": "workspace-ready", "workspace": workspace }),
            );
        }
        Err(error) => {
            eprintln!("control-service workspace initialization warning: {error}");
        }
    }

    if let Err(error) = agent::ensure_local_testbeta_agent_from_context(&app_context).await {
        eprintln!("control-service local agent startup warning: {error}");
    }

    let router = Router::new()
        .route("/health", get(health_handler))
        .route("/v1/invoke", post(invoke_handler))
        .route("/v1/events/stream", get(events_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers(Any),
        )
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|error| format!("Failed to bind control-service on {addr}: {error}"))?;

    axum::serve(listener, router)
        .await
        .map_err(|error| format!("control-service server error: {error}"))
}

async fn health_handler(State(state): State<ControlServiceState>) -> impl IntoResponse {
    let workspace_path = monitor_initialize_workspace_from_context(&state.app_context)
        .unwrap_or_else(|_| String::new());

    Json(ControlServiceHealth {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        workspace_path,
        resource_roots: state
            .app_context
            .resource_roots()
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
    })
}

async fn invoke_handler(
    State(state): State<ControlServiceState>,
    headers: HeaderMap,
    Json(request): Json<InvokeRequest>,
) -> impl IntoResponse {
    if let Err(response) = authorize(&state, &headers) {
        return response;
    }

    let result = dispatch_command(&state, request).await;
    match result {
        Ok(payload) => {
            (StatusCode::OK, Json(json!({ "ok": true, "data": payload }))).into_response()
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

async fn events_handler(
    State(state): State<ControlServiceState>,
    Query(query): Query<EventQuery>,
) -> impl IntoResponse {
    if query.token != *state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let mut receiver = state.event_bus.subscribe();
    let stream = stream! {
        loop {
            match receiver.recv().await {
                Ok(message) => {
                    let event = Event::default()
                        .event(message.event)
                        .json_data(message.payload)
                        .unwrap_or_else(|_| Event::default().event("service-error").data("{\"error\":\"failed to encode event\"}"));
                    yield Ok::<Event, Infallible>(event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    yield Ok::<Event, Infallible>(
                        Event::default().event("service-warning").data("{\"warning\":\"event backlog dropped\"}")
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
        .into_response()
}

fn authorize(
    state: &ControlServiceState,
    headers: &HeaderMap,
) -> Result<(), axum::response::Response> {
    let Some(value) = headers.get(header::AUTHORIZATION) else {
        return Err(StatusCode::UNAUTHORIZED.into_response());
    };

    let Ok(value) = value.to_str() else {
        return Err(StatusCode::UNAUTHORIZED.into_response());
    };

    if value.trim() == format!("Bearer {}", state.token.as_str()) {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED.into_response())
    }
}

async fn dispatch_command(
    state: &ControlServiceState,
    request: InvokeRequest,
) -> Result<Value, String> {
    match request.command.as_str() {
        "monitor_initialize_workspace" => to_value(monitor_initialize_workspace_from_context(
            &state.app_context,
        )?),
        "monitor_apply_testbeta_topology" => to_value(monitor_apply_testbeta_topology_from_context(
            &state.app_context,
        )?),
        "monitor_get_setup_status" => to_value(monitor_get_setup_status()?),
        "get_monitor_snapshot" => to_value(get_monitor_snapshot().await?),
        "get_monitor_agent_snapshot" => to_value(get_monitor_agent_snapshot().await?),
        "get_monitor_workspace_path" => to_value(get_monitor_workspace_path()?),
        "get_monitor_inventory_path" => to_value(get_monitor_inventory_path()?),
        "get_monitor_user_manual_markdown" => to_value(get_monitor_user_manual_markdown()?),
        "get_monitor_security_state" => to_value(get_monitor_security_state()?),
        "monitor_detect_local_vpn_identity" => to_value(monitor_detect_local_vpn_identity()?),
        "monitor_ensure_ssh_keypair" => {
            to_value(monitor_ensure_ssh_keypair_from_context(&state.app_context)?)
        }
        "agent_monitor_initialize_workspace" => to_value(
            agent_monitor_initialize_workspace_from_context(&state.app_context)?,
        ),
        "agent_get_inventory_machines" => to_value(agent_get_inventory_machines()?),
        "monitor_set_active_operator" => {
            let args: OperatorIdArgs = parse_args(request.args)?;
            to_value(monitor_set_active_operator(args.operator_id)?)
        }
        "monitor_upsert_operator" => {
            let args: UpsertOperatorArgs = parse_args(request.args)?;
            to_value(monitor_upsert_operator(args.input)?)
        }
        "monitor_delete_operator" => {
            let args: OperatorIdArgs = parse_args(request.args)?;
            to_value(monitor_delete_operator(args.operator_id)?)
        }
        "monitor_upsert_ssh_profile" => {
            let args: UpsertProfileArgs = parse_args(request.args)?;
            to_value(monitor_upsert_ssh_profile(args.input)?)
        }
        "monitor_delete_ssh_profile" => {
            let args: ProfileIdArgs = parse_args(request.args)?;
            to_value(monitor_delete_ssh_profile(args.profile_id)?)
        }
        "monitor_assign_ssh_binding" => {
            let args: AssignBindingArgs = parse_args(request.args)?;
            to_value(monitor_assign_ssh_binding(args.input)?)
        }
        "monitor_remove_ssh_binding" => {
            let args: NodeSlotArgs = parse_args(request.args)?;
            to_value(monitor_remove_ssh_binding(args.node_slot_id)?)
        }
        "monitor_run_terminal_command" => {
            let args: TerminalCommandArgs = parse_args(request.args)?;
            to_value(monitor_run_terminal_command(args.command, args.cwd).await?)
        }
        "testbeta_get_state" => to_value(testbeta_get_state()?),
        "testbeta_get_live_status" => to_value(testbeta_get_live_status().await?),
        "testbeta_get_device_profile" => to_value(testbeta_get_device_profile()?),
        "testbeta_get_catalog" => to_value(testbeta_get_catalog()?),
        "testbeta_setup_node" => {
            let args: TestnetBetaSetupArgs = parse_args(request.args)?;
            to_value(testbeta_setup_node(args.input).await?)
        }
        "testbeta_node_control" => {
            let args: TestnetBetaNodeControlArgs = parse_args(request.args)?;
            to_value(testbeta_node_control(&state.app_context, args.input).await?)
        }
        "testbeta_remove_node" => {
            let args: TestnetBetaRemoveNodeArgs = parse_args(request.args)?;
            to_value(testbeta_remove_node(&state.app_context, args.input).await?)
        }
        "monitor_mark_setup_complete" => {
            let args: SetupCompleteArgs = parse_args(request.args)?;
            to_value(
                monitor_mark_setup_complete(args.physical_machine_id, args.node_slot_ids).await?,
            )
        }
        "monitor_node_control" => {
            let args: NodeActionArgs = parse_args(request.args)?;
            to_value(monitor_node_control(args.node_slot_id, args.action).await?)
        }
        "monitor_bulk_node_control" => {
            let args: BulkActionArgs = parse_args(request.args)?;
            to_value(monitor_bulk_node_control(args.action, args.scope).await?)
        }
        "get_monitor_node_details" => {
            let args: NodeSlotArgs = parse_args(request.args)?;
            to_value(get_monitor_node_details(args.node_slot_id).await?)
        }
        "monitor_export_node_data" => {
            let args: NodeSlotArgs = parse_args(request.args)?;
            to_value(monitor_export_node_data(args.node_slot_id).await?)
        }
        "monitor_update_local_agent" => {
            let args: NodeSlotArgs = parse_args(request.args)?;
            to_value(
                monitor_update_local_agent_from_context(args.node_slot_id, &state.app_context)
                    .await?,
            )
        }
        "agent_prepare_hosts_env" => {
            let args: PrepareHostsArgs = parse_args(request.args)?;
            to_value(agent_prepare_hosts_env_from_context(
                args.input,
                &state.app_context,
            )?)
        }
        other => Err(format!("Unsupported control-service command: {other}")),
    }
}

fn to_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| format!("Failed to serialize response: {error}"))
}

fn parse_args<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("Failed to decode command args: {error}"))
}
