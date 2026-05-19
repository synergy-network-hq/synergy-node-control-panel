use synergy_node_control_panel::testnet::testnet_diagnose_onboarding_sync;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("synergy-control failed closed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let command = args.first().map(String::as_str).unwrap_or("help");
    match command {
        "diagnose-onboarding-sync" => {
            let node_id = arg_value(&args, "--node-id");
            let payload = testnet_diagnose_onboarding_sync(node_id).await?;
            let rendered = serde_json::to_string_pretty(&payload)
                .map_err(|error| format!("failed to render diagnostic JSON: {error}"))?;
            println!("{rendered}");
        }
        _ => {
            println!("Commands:");
            println!("  synergy-control diagnose-onboarding-sync [--node-id <node-id>]");
        }
    }
    Ok(())
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}
