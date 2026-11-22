use std::net::IpAddr;
use std::time::Duration;

pub const DEFAULT_LISTEN_HOST: &str = "0.0.0.0";
pub const DEFAULT_LISTEN_PORT: u16 = 8080;
pub const DEFAULT_STEAM_API_HOST: &str = "http://api.steampowered.com";
pub const DEFAULT_CACHE_TTL_MS: u64 = 60_000;
pub const DEFAULT_MAX_CACHE_ENTRIES: u64 = 5_000;
pub const DEFAULT_PROBE_INTERVAL_SECS: u64 = 300;
pub const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 15_000;
pub const DEFAULT_UPSTREAM_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_POOL_MAX_IDLE_PER_HOST: usize = 100;
pub const DEFAULT_POOL_IDLE_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub listen_host: String,
    pub listen_port: u16,
    pub source_ip: Option<IpAddr>,
    pub steam_api_host: String,
    pub cache_ttl: Duration,
    pub max_cache_entries: u64,
    pub probe_interval: Duration,
    pub connect_timeout: Duration,
    pub upstream_timeout: Duration,
    pub pool_max_idle_per_host: usize,
    pub pool_idle_timeout: Duration,
    pub midnight_restart: bool,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            listen_host: DEFAULT_LISTEN_HOST.to_string(),
            listen_port: DEFAULT_LISTEN_PORT,
            source_ip: None,
            steam_api_host: DEFAULT_STEAM_API_HOST.to_string(),
            cache_ttl: Duration::from_millis(DEFAULT_CACHE_TTL_MS),
            max_cache_entries: DEFAULT_MAX_CACHE_ENTRIES,
            probe_interval: Duration::from_secs(DEFAULT_PROBE_INTERVAL_SECS),
            connect_timeout: Duration::from_millis(DEFAULT_CONNECT_TIMEOUT_MS),
            upstream_timeout: Duration::from_millis(DEFAULT_UPSTREAM_TIMEOUT_MS),
            pool_max_idle_per_host: DEFAULT_POOL_MAX_IDLE_PER_HOST,
            pool_idle_timeout: Duration::from_secs(DEFAULT_POOL_IDLE_TIMEOUT_SECS),
            midnight_restart: false,
        }
    }
}

impl ProxyConfig {
    pub fn from_env() -> Result<Self, String> {
        let listen_host = env_trimmed("LISTEN_HOST").unwrap_or_else(|| DEFAULT_LISTEN_HOST.to_string());
        let listen_port = env_trimmed("LISTEN_PORT")
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|&p| p > 0)
            .unwrap_or(DEFAULT_LISTEN_PORT);

        let source_ip = match env_trimmed("SOURCE_IP") {
            Some(raw) => {
                let ip = raw
                    .parse::<IpAddr>()
                    .map_err(|e| format!("Invalid SOURCE_IP '{raw}': {e}"))?;
                Some(ip)
            }
            None => None,
        };

        let steam_api_host = env_trimmed("STEAM_API_HOST")
            .unwrap_or_else(|| DEFAULT_STEAM_API_HOST.to_string())
            .trim_end_matches('/')
            .to_string();

        let cache_ttl_ms = env_u64("CACHE_TTL_MS").unwrap_or(DEFAULT_CACHE_TTL_MS);
        let max_cache_entries = env_u64("MAX_CACHE_ENTRIES").unwrap_or(DEFAULT_MAX_CACHE_ENTRIES);
        let probe_interval_secs = env_u64("PROBE_INTERVAL_SECS").unwrap_or(DEFAULT_PROBE_INTERVAL_SECS);
        let connect_timeout_ms = env_u64("CONNECT_TIMEOUT_MS").unwrap_or(DEFAULT_CONNECT_TIMEOUT_MS);
        let upstream_timeout_ms = env_u64("UPSTREAM_TIMEOUT_MS").unwrap_or(DEFAULT_UPSTREAM_TIMEOUT_MS);
        let midnight_restart = env_bool("MIDNIGHT_RESTART").unwrap_or(false);

        Ok(Self {
            listen_host,
            listen_port,
            source_ip,
            steam_api_host,
            cache_ttl: Duration::from_millis(cache_ttl_ms),
            max_cache_entries,
            probe_interval: Duration::from_secs(probe_interval_secs.max(1)),
            connect_timeout: Duration::from_millis(connect_timeout_ms.max(100)),
            upstream_timeout: Duration::from_millis(upstream_timeout_ms.max(100)),
            pool_max_idle_per_host: DEFAULT_POOL_MAX_IDLE_PER_HOST,
            pool_idle_timeout: Duration::from_secs(DEFAULT_POOL_IDLE_TIMEOUT_SECS),
            midnight_restart,
        })
    }
}

fn env_trimmed(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn env_u64(key: &str) -> Option<u64> {
    env_trimmed(key).and_then(|v| v.parse::<u64>().ok())
}

fn env_bool(key: &str) -> Option<bool> {
    env_trimmed(key).map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}
