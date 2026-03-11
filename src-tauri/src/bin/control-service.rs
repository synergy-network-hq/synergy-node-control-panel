use synergy_devnet_control_panel::app_context::AppContext;
use synergy_devnet_control_panel::control_service;

#[tokio::main]
async fn main() {
    let mut port: u16 = 47_891;
    let mut token = String::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<u16>() {
                        port = parsed;
                    }
                }
            }
            "--token" => {
                if let Some(value) = args.next() {
                    token = value;
                }
            }
            _ => {}
        }
    }

    if token.trim().is_empty() {
        eprintln!("control-service requires --token");
        std::process::exit(1);
    }

    let app_context = AppContext::from_env();
    if let Err(error) = control_service::serve(port, token, app_context).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
