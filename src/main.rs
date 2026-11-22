use chrono::{Duration as ChronoDuration, Utc};
use sa_steam_proxy::config::ProxyConfig;
use sa_steam_proxy::http::build_router;
use sa_steam_proxy::proxy::SteamProxyService;
use sa_steam_proxy::version::ProxyBuildInfo;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

fn main() {
    let worker_threads = std::env::var("TOKIO_WORKER_THREADS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(2);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads)
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");

    runtime.block_on(async_main());
}

async fn async_main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = match ProxyConfig::from_env() {
        Ok(cfg) => cfg,
        Err(err) => {
            error!("Configuration error: {err}");
            std::process::exit(1);
        }
    };

    let build_info = ProxyBuildInfo::from_env();
    let service = match SteamProxyService::new(&config, build_info.clone()) {
        Ok(svc) => Arc::new(svc),
        Err(err) => {
            error!("Failed to initialize SteamProxyService: {err}");
            std::process::exit(1);
        }
    };

    let shutdown_notify = Arc::new(Notify::new());

    // Keep the RPM window sliding even when the pod receives no traffic (every 10s).
    {
        let svc = Arc::clone(&service);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(10));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                svc.cleanup_old_requests();
            }
        });
    }

    // Periodic rate-limit recovery probe (default every 5 minutes).
    {
        let svc = Arc::clone(&service);
        let probe_interval = config.probe_interval;
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(probe_interval);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // Skip immediate boot tick — matches Nest @Cron(EVERY_5_MINUTES).
            interval.tick().await;
            loop {
                interval.tick().await;
                svc.check_rate_limiting().await;
            }
        });
    }

    // Optional midnight restart (disabled by default; opt-in via MIDNIGHT_RESTART=true).
    if config.midnight_restart {
        let notify = Arc::clone(&shutdown_notify);
        tokio::spawn(async move {
            let sleep_dur = duration_until_next_utc_midnight();
            info!(
                seconds = sleep_dur.as_secs(),
                "MIDNIGHT_RESTART=true enabled; scheduled graceful exit at next 00:00 UTC"
            );
            tokio::time::sleep(sleep_dur).await;
            info!("[CRON] Midnight restart");
            notify.notify_waiters();
        });
    }

    let bind_addr = format!("{}:{}", config.listen_host, config.listen_port);
    let listener = match TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(err) => {
            error!("Failed to bind {bind_addr}: {err}");
            std::process::exit(1);
        }
    };

    info!(
        addr = %bind_addr,
        version = %build_info.version,
        git_sha = ?build_info.git_sha,
        "sa-steam-proxy listening"
    );

    let app = build_router(service);
    if let Err(err) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown_notify))
        .await
    {
        error!("HTTP server exited with error: {err}");
        std::process::exit(1);
    }
}

fn duration_until_next_utc_midnight() -> Duration {
    let now = Utc::now();
    let tomorrow = (now + ChronoDuration::days(1))
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("valid midnight timestamp")
        .and_utc();
    (tomorrow - now).to_std().unwrap_or_else(|_| Duration::from_secs(60))
}

async fn shutdown_signal(notify: Arc<Notify>) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => info!("Received SIGINT; shutting down"),
        _ = terminate => info!("Received SIGTERM; shutting down"),
        _ = notify.notified() => info!("Shutdown triggered by scheduler"),
    }
}
