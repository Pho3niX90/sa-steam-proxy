use crate::config::ProxyConfig;
use crate::steam_failure::{
    canonical_cache_key, classify_steam_failure, extract_key_param, is_privacy_restricted_endpoint,
    redact_keys_in_text, redact_steam_path_for_log, SteamFailure,
};
use crate::version::ProxyBuildInfo;
use bytes::Bytes;
use flate2::read::GzDecoder;
use moka::sync::Cache;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_TYPE, RETRY_AFTER};
use reqwest::Client;
use serde::Serialize;
use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tracing::{debug, error, info, warn};

pub const SAFE_PROBE_PATH: &str = "/ISteamWebAPIUtil/GetServerInfo/v0001/";
/// Deterministic public Steam profile (Gabe Newell) used to actively verify
/// whether an API key is genuinely rejected by Steam before latching `bad_key`,
/// and to self-heal `bad_key` during background probes.
pub const KEY_CANARY_PATH_PREFIX: &str = "/ISteamUser/GetPlayerSummaries/v0002/?steamids=76561197960287930&key=";
pub const RPM_WINDOW: Duration = Duration::from_secs(60);
pub const MIN_RETRY_BACKOFF_SECS: u64 = 5;
pub const MAX_RETRY_BACKOFF_SECS: u64 = 300;
/// Consecutive confirmed auth failures before marking the proxy not-ready.
pub const BAD_KEY_FAILURE_THRESHOLD: u64 = 3;
/// Cap decompressed payload size to prevent accidental OOM from corrupt/malicious streams.
const MAX_DECOMPRESSED_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
enum KeyCanaryOutcome {
    Valid,
    BadKey,
    RateLimited(Option<String>),
    Inconclusive,
}

#[derive(Debug, Clone)]
struct CachedEntry {
    body: Bytes,
    is_json: bool,
    status_code: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyErrorKind {
    RateLimited,
    BadKey,
    UpstreamError,
    DecompressionFailed,
    Nok,
}

impl ProxyErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RateLimited => "rate_limited",
            Self::BadKey => "bad_key",
            Self::UpstreamError => "upstream_error",
            Self::DecompressionFailed => "decompression_failed",
            Self::Nok => "nok",
        }
    }

    pub fn default_status(self) -> u16 {
        match self {
            Self::RateLimited => 429,
            Self::BadKey => 403,
            Self::UpstreamError | Self::DecompressionFailed | Self::Nok => 500,
        }
    }
}

#[derive(Debug, Clone)]
pub enum ProxyResult {
    Success {
        body: Bytes,
        is_json: bool,
        status_code: u16,
    },
    Error {
        error: ProxyErrorKind,
        status_code: u16,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadyReason {
    RateLimited,
    BadKey,
}

impl ReadyReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RateLimited => "rate_limited",
            Self::BadKey => "bad_key",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LivenessStatus {
    pub alive: bool,
    pub requests_per_minute: usize,
}

#[derive(Debug, Clone)]
pub struct ReadyStatus {
    pub alive: bool,
    pub ready: bool,
    pub status: &'static str,
    pub reasons: Vec<ReadyReason>,
    pub rate_limited: bool,
    pub bad_key: bool,
    pub requests_per_minute: usize,
    pub backoff: u64,
    pub retry_in: u64,
    pub auth_failures: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub total: u64,
    pub success: u64,
    pub failure: u64,
    pub last_duration_ms: u64,
}

struct ProxyState {
    request_timestamps: VecDeque<Instant>,
    is_rate_limited: bool,
    is_bad_key: bool,
    consecutive_auth_failures: u64,
    last_failure_path: String,
    /// Last key confirmed bad by the canary probe (never logged); used by
    /// `check_rate_limiting()` to self-heal if Steam stops rejecting it.
    last_bad_key: Option<String>,
    retry_backoff_secs: u64,
    rate_limit_start: Option<Instant>,
    next_probe_at: Option<Instant>,
}

impl ProxyState {
    fn new() -> Self {
        Self {
            request_timestamps: VecDeque::new(),
            is_rate_limited: false,
            is_bad_key: false,
            consecutive_auth_failures: 0,
            last_failure_path: String::new(),
            last_bad_key: None,
            retry_backoff_secs: MIN_RETRY_BACKOFF_SECS,
            rate_limit_start: None,
            next_probe_at: None,
        }
    }

    fn prune_requests(&mut self, now: Instant) {
        while let Some(&front) = self.request_timestamps.front() {
            if now.saturating_duration_since(front) >= RPM_WINDOW {
                self.request_timestamps.pop_front();
            } else {
                break;
            }
        }
    }

    fn apply_retry_after(&mut self, header_value: &str) {
        if let Some(secs) = parse_retry_after_secs(header_value) {
            self.retry_backoff_secs = secs.clamp(MIN_RETRY_BACKOFF_SECS, MAX_RETRY_BACKOFF_SECS);
            warn!("Retry-After header: {secs}s");
        }
    }

    fn schedule_next_probe(&mut self, now: Instant) {
        self.next_probe_at = Some(now + Duration::from_secs(self.retry_backoff_secs));
    }
}

pub struct SteamProxyService {
    client: Client,
    steam_api_host: String,
    build_info: ProxyBuildInfo,
    cache: Cache<String, CachedEntry>,
    state: Mutex<ProxyState>,
    total: AtomicU64,
    success: AtomicU64,
    failure: AtomicU64,
    last_duration_ms: AtomicU64,
}

impl SteamProxyService {
    pub fn new(config: &ProxyConfig, build_info: ProxyBuildInfo) -> Result<Self, reqwest::Error> {
        let mut builder = Client::builder()
            .pool_max_idle_per_host(config.pool_max_idle_per_host)
            .pool_idle_timeout(Some(config.pool_idle_timeout))
            .connect_timeout(config.connect_timeout)
            .timeout(config.upstream_timeout)
            // Handle gzip manually so corrupt gzip streams return exact 502 decompression_failed.
            .no_gzip()
            .no_brotli()
            .no_deflate();

        if let Some(source_ip) = config.source_ip {
            builder = builder.local_address(source_ip);
        }

        let client = builder.build()?;
        let cache = Cache::builder()
            .max_capacity(config.max_cache_entries)
            .time_to_live(config.cache_ttl)
            .build();

        if let Some(source_ip) = config.source_ip {
            info!(
                source_ip = %source_ip,
                upstream = %config.steam_api_host,
                "SteamProxyService initialized (SOURCE_IP={source_ip})"
            );
        } else {
            info!(
                upstream = %config.steam_api_host,
                "SteamProxyService initialized"
            );
        }

        Ok(Self {
            client,
            steam_api_host: config.steam_api_host.trim_end_matches('/').to_string(),
            build_info,
            cache,
            state: Mutex::new(ProxyState::new()),
            total: AtomicU64::new(0),
            success: AtomicU64::new(0),
            failure: AtomicU64::new(0),
            last_duration_ms: AtomicU64::new(0),
        })
    }

    pub fn build_info(&self) -> &ProxyBuildInfo {
        &self.build_info
    }

    pub fn liveness_status(&self) -> LivenessStatus {
        let mut state = self.state.lock().expect("proxy state mutex poisoned");
        state.prune_requests(Instant::now());
        LivenessStatus {
            alive: true,
            requests_per_minute: state.request_timestamps.len(),
        }
    }

    pub fn ready_status(&self) -> ReadyStatus {
        let now = Instant::now();
        let mut state = self.state.lock().expect("proxy state mutex poisoned");
        state.prune_requests(now);

        let mut reasons = Vec::new();
        if state.is_rate_limited {
            reasons.push(ReadyReason::RateLimited);
        }
        if state.is_bad_key {
            reasons.push(ReadyReason::BadKey);
        }
        let ready = reasons.is_empty();
        let status = if ready { "ok" } else { reasons[0].as_str() };

        let retry_in = match state.next_probe_at {
            Some(at) if at > now => {
                let ms = at.saturating_duration_since(now).as_millis();
                ms.div_ceil(1000) as u64
            }
            _ => 0,
        };

        ReadyStatus {
            alive: true,
            ready,
            status,
            reasons,
            rate_limited: state.is_rate_limited,
            bad_key: state.is_bad_key,
            requests_per_minute: state.request_timestamps.len(),
            backoff: state.retry_backoff_secs,
            retry_in,
            auth_failures: state.consecutive_auth_failures,
        }
    }

    pub fn metrics(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            total: self.total.load(Ordering::Relaxed),
            success: self.success.load(Ordering::Relaxed),
            failure: self.failure.load(Ordering::Relaxed),
            last_duration_ms: self.last_duration_ms.load(Ordering::Relaxed),
        }
    }

    pub fn prometheus_metrics(&self) -> String {
        let ready = self.ready_status();
        let metrics = self.metrics();
        let cache_entries = self.cache.entry_count();
        format!(
            concat!(
                "# HELP sa_steam_proxy_requests_total Total proxy requests received.\n",
                "# TYPE sa_steam_proxy_requests_total counter\n",
                "sa_steam_proxy_requests_total {total}\n",
                "# HELP sa_steam_proxy_requests_success_total Total successful upstream Steam requests.\n",
                "# TYPE sa_steam_proxy_requests_success_total counter\n",
                "sa_steam_proxy_requests_success_total {success}\n",
                "# HELP sa_steam_proxy_requests_failure_total Total failed upstream Steam requests.\n",
                "# TYPE sa_steam_proxy_requests_failure_total counter\n",
                "sa_steam_proxy_requests_failure_total {failure}\n",
                "# HELP sa_steam_proxy_last_duration_ms Duration of the last upstream Steam request in milliseconds.\n",
                "# TYPE sa_steam_proxy_last_duration_ms gauge\n",
                "sa_steam_proxy_last_duration_ms {last_duration_ms}\n",
                "# HELP sa_steam_proxy_requests_per_minute Requests received in the sliding 60s window.\n",
                "# TYPE sa_steam_proxy_requests_per_minute gauge\n",
                "sa_steam_proxy_requests_per_minute {rpm}\n",
                "# HELP sa_steam_proxy_ready Whether the proxy is ready (1 = ready, 0 = not ready).\n",
                "# TYPE sa_steam_proxy_ready gauge\n",
                "sa_steam_proxy_ready {ready_flag}\n",
                "# HELP sa_steam_proxy_rate_limited Whether the proxy is currently rate-limited (1 = yes, 0 = no).\n",
                "# TYPE sa_steam_proxy_rate_limited gauge\n",
                "sa_steam_proxy_rate_limited {rate_limited_flag}\n",
                "# HELP sa_steam_proxy_bad_key Whether the proxy has latched bad_key (1 = yes, 0 = no).\n",
                "# TYPE sa_steam_proxy_bad_key gauge\n",
                "sa_steam_proxy_bad_key {bad_key_flag}\n",
                "# HELP sa_steam_proxy_auth_failures Consecutive auth failures observed.\n",
                "# TYPE sa_steam_proxy_auth_failures gauge\n",
                "sa_steam_proxy_auth_failures {auth_failures}\n",
                "# HELP sa_steam_proxy_backoff_seconds Current rate-limit probe backoff in seconds.\n",
                "# TYPE sa_steam_proxy_backoff_seconds gauge\n",
                "sa_steam_proxy_backoff_seconds {backoff}\n",
                "# HELP sa_steam_proxy_cache_entries Approximate number of cached responses.\n",
                "# TYPE sa_steam_proxy_cache_entries gauge\n",
                "sa_steam_proxy_cache_entries {cache_entries}\n",
            ),
            total = metrics.total,
            success = metrics.success,
            failure = metrics.failure,
            last_duration_ms = metrics.last_duration_ms,
            rpm = ready.requests_per_minute,
            ready_flag = u8::from(ready.ready),
            rate_limited_flag = u8::from(ready.rate_limited),
            bad_key_flag = u8::from(ready.bad_key),
            auth_failures = ready.auth_failures,
            backoff = ready.backoff,
            cache_entries = cache_entries,
        )
    }

    pub fn cleanup_old_requests(&self) {
        let mut state = self.state.lock().expect("proxy state mutex poisoned");
        state.prune_requests(Instant::now());
    }

    pub fn run_pending_cache_tasks(&self) {
        self.cache.run_pending_tasks();
    }

    pub async fn proxy(&self, original_path: &str) -> ProxyResult {
        let path_only = original_path.split('?').next().unwrap_or("/");
        if is_reserved_path(path_only) {
            warn!("Refusing to proxy reserved path to Steam: {path_only}");
            return ProxyResult::Error {
                error: ProxyErrorKind::Nok,
                status_code: 404,
            };
        }

        let is_rate_limited = {
            let now = Instant::now();
            let mut state = self.state.lock().expect("proxy state mutex poisoned");
            state.prune_requests(now);
            state.request_timestamps.push_back(now);
            state.is_rate_limited
        };
        self.total.fetch_add(1, Ordering::Relaxed);

        let full_path = if original_path.starts_with('/') {
            original_path.to_string()
        } else {
            format!("/{original_path}")
        };
        let cache_key = canonical_cache_key(&full_path);

        if let Some(cached) = self.cache.get(&cache_key) {
            debug!("Cache HIT: {}", redact_steam_path_for_log(original_path));
            return ProxyResult::Success {
                body: cached.body,
                is_json: cached.is_json,
                status_code: cached.status_code,
            };
        }

        if is_rate_limited {
            warn!("Blocked by rate limit: {}", redact_steam_path_for_log(original_path));
            return ProxyResult::Error {
                error: ProxyErrorKind::RateLimited,
                status_code: 429,
            };
        }

        // Do not short-circuit bad_key here — allow traffic so a rotated key can recover.
        // /ready already reports not-ready while is_bad_key is set.
        let url = format!("{}{}", self.steam_api_host, full_path);
        let start = Instant::now();

        let response = match self.client.get(&url).header(ACCEPT_ENCODING, "gzip").send().await {
            Ok(resp) => resp,
            Err(err) => {
                self.failure.fetch_add(1, Ordering::Relaxed);
                self.last_duration_ms
                    .store(start.elapsed().as_millis() as u64, Ordering::Relaxed);
                error!("Steam fetch error: {}", redact_keys_in_text(&err.to_string()));
                return ProxyResult::Error {
                    error: ProxyErrorKind::Nok,
                    status_code: 502,
                };
            }
        };

        let status_code = response.status().as_u16();
        let headers = response.headers().clone();
        let content_encoding = headers
            .get(CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let content_type = headers
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let retry_after = headers.get(RETRY_AFTER).and_then(|v| v.to_str().ok());

        let raw_bytes = match response.bytes().await {
            Ok(b) => b,
            Err(err) => {
                self.last_duration_ms
                    .store(start.elapsed().as_millis() as u64, Ordering::Relaxed);
                error!("Steam body read error: {}", redact_keys_in_text(&err.to_string()));
                return self
                    .finalize_classified(original_path, status_code, retry_after, Bytes::new(), false)
                    .await;
            }
        };

        self.last_duration_ms
            .store(start.elapsed().as_millis() as u64, Ordering::Relaxed);

        let body_bytes = if content_encoding.contains("gzip") {
            match gunzip_bounded(&raw_bytes) {
                Ok(decompressed) => Bytes::from(decompressed),
                Err(err) => {
                    error!("Decompression failed: {err}");
                    return ProxyResult::Error {
                        error: ProxyErrorKind::DecompressionFailed,
                        status_code: 502,
                    };
                }
            }
        } else {
            raw_bytes
        };

        let raw_text = String::from_utf8_lossy(&body_bytes);

        let is_json = if content_type.contains("application/json") && !raw_text.trim().is_empty() {
            match serde_json::from_slice::<serde::de::IgnoredAny>(&body_bytes) {
                Ok(_) => true,
                Err(_) => {
                    warn!("Failed to parse JSON. Raw body: {}", redact_keys_in_text(&raw_text));
                    false
                }
            }
        } else {
            false
        };

        let result = self
            .finalize_classified(original_path, status_code, retry_after, body_bytes.clone(), is_json)
            .await;
        if matches!(result, ProxyResult::Success { .. }) {
            self.cache.insert(
                cache_key,
                CachedEntry {
                    body: body_bytes,
                    is_json,
                    status_code,
                },
            );
        }
        result
    }

    async fn finalize_classified(
        &self,
        original_path: &str,
        status_code: u16,
        retry_after: Option<&str>,
        body_bytes: Bytes,
        is_json: bool,
    ) -> ProxyResult {
        let raw_text = String::from_utf8_lossy(&body_bytes);
        let classified = classify_steam_failure(status_code, retry_after, &raw_text);

        if classified == Some(SteamFailure::RateLimited) {
            self.handle_rate_limit(original_path, retry_after);
            return ProxyResult::Error {
                error: ProxyErrorKind::RateLimited,
                status_code: 429,
            };
        }

        if classified == Some(SteamFailure::BadKey) {
            let Some(key) = extract_key_param(original_path) else {
                // A single caller omitting `?key=` must not poison the proxy's global bad_key state.
                self.failure.fetch_add(1, Ordering::Relaxed);
                warn!(
                    "Steam returned auth error {} on keyless request {}; not latching proxy bad_key",
                    status_code,
                    redact_steam_path_for_log(original_path)
                );
                return ProxyResult::Error {
                    error: ProxyErrorKind::BadKey,
                    status_code,
                };
            };

            // Actively verify against a deterministic public profile before counting an auth failure.
            // Prevents per-user or endpoint-specific 401/403 responses from poisoning the proxy.
            let already_canary = original_path.starts_with(KEY_CANARY_PATH_PREFIX);
            let verdict = if already_canary {
                KeyCanaryOutcome::BadKey
            } else {
                self.verify_key_with_canary(&key).await
            };

            match verdict {
                KeyCanaryOutcome::Valid => {
                    debug!(
                        "Steam returned {} on {} with auth wording, but canary GetPlayerSummaries succeeded; key is valid",
                        status_code,
                        redact_steam_path_for_log(original_path)
                    );
                    self.clear_failure_state();
                    self.failure.fetch_add(1, Ordering::Relaxed);
                    return ProxyResult::Error {
                        error: ProxyErrorKind::UpstreamError,
                        status_code,
                    };
                }
                KeyCanaryOutcome::RateLimited(ra) => {
                    self.handle_rate_limit(original_path, ra.as_deref());
                    return ProxyResult::Error {
                        error: ProxyErrorKind::RateLimited,
                        status_code: 429,
                    };
                }
                KeyCanaryOutcome::Inconclusive => {
                    self.failure.fetch_add(1, Ordering::Relaxed);
                    warn!(
                        "Key canary probe inconclusive after HTTP {} on {}; not latching bad_key",
                        status_code,
                        redact_steam_path_for_log(original_path)
                    );
                    return ProxyResult::Error {
                        error: ProxyErrorKind::UpstreamError,
                        status_code,
                    };
                }
                KeyCanaryOutcome::BadKey => {
                    self.handle_auth_failure(original_path, status_code, Some(&key));
                    return ProxyResult::Error {
                        error: ProxyErrorKind::BadKey,
                        status_code,
                    };
                }
            }
        }

        if status_code == 401 && is_privacy_restricted_endpoint(original_path) {
            // Normal Steam behavior for private profiles / friend lists (e.g. GetFriendList).
            // Do not count as a proxy failure or auth failure.
            debug!(
                "Steam returned 401 (private profile/resource) on {}",
                redact_steam_path_for_log(original_path)
            );
            return ProxyResult::Error {
                error: ProxyErrorKind::UpstreamError,
                status_code,
            };
        }

        if status_code >= 400 {
            self.failure.fetch_add(1, Ordering::Relaxed);
            warn!(
                "Steam returned {} on {}",
                status_code,
                redact_steam_path_for_log(original_path)
            );
            return ProxyResult::Error {
                error: ProxyErrorKind::UpstreamError,
                status_code,
            };
        }

        self.clear_failure_state();
        self.success.fetch_add(1, Ordering::Relaxed);

        ProxyResult::Success {
            body: body_bytes,
            is_json,
            status_code,
        }
    }

    async fn verify_key_with_canary(&self, key: &str) -> KeyCanaryOutcome {
        let url = format!("{}{}{}", self.steam_api_host, KEY_CANARY_PATH_PREFIX, key);
        let res = match self.client.get(&url).header(ACCEPT_ENCODING, "gzip").send().await {
            Ok(r) => r,
            Err(err) => {
                warn!(
                    "Key canary probe network error: {}",
                    redact_keys_in_text(&err.to_string())
                );
                return KeyCanaryOutcome::Inconclusive;
            }
        };

        let status_code = res.status().as_u16();
        let headers = res.headers().clone();
        let content_encoding = headers
            .get(CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let retry_after = headers
            .get(RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(ToOwned::to_owned);

        let raw_bytes = match res.bytes().await {
            Ok(b) => b,
            Err(_) => return KeyCanaryOutcome::Inconclusive,
        };
        let body_bytes = if content_encoding.contains("gzip") {
            match gunzip_bounded(&raw_bytes) {
                Ok(d) => Bytes::from(d),
                Err(_) => return KeyCanaryOutcome::Inconclusive,
            }
        } else {
            raw_bytes
        };
        let body_text = String::from_utf8_lossy(&body_bytes);

        match classify_steam_failure(status_code, retry_after.as_deref(), &body_text) {
            Some(SteamFailure::RateLimited) => KeyCanaryOutcome::RateLimited(retry_after),
            Some(SteamFailure::BadKey) => KeyCanaryOutcome::BadKey,
            None if status_code < 400 => KeyCanaryOutcome::Valid,
            None => KeyCanaryOutcome::Inconclusive,
        }
    }

    pub async fn check_rate_limiting(&self) {
        let (is_rate_limited, is_bad_key, last_bad_key) = {
            let now = Instant::now();
            let state = self.state.lock().expect("proxy state mutex poisoned");
            if !state.is_rate_limited && !state.is_bad_key {
                return;
            }
            if !state.next_probe_at.is_none_or(|at| now >= at) {
                return;
            }
            (state.is_rate_limited, state.is_bad_key, state.last_bad_key.clone())
        };

        if is_rate_limited {
            let url = format!("{}{}", self.steam_api_host, SAFE_PROBE_PATH);
            let res = match self.client.get(&url).header(ACCEPT_ENCODING, "gzip").send().await {
                Ok(r) => r,
                Err(err) => {
                    let mut state = self.state.lock().expect("proxy state mutex poisoned");
                    state.schedule_next_probe(Instant::now());
                    error!("Rate-limit probe error: {}", redact_keys_in_text(&err.to_string()));
                    return;
                }
            };

            let status_code = res.status().as_u16();
            let retry_after = res
                .headers()
                .get(RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .map(ToOwned::to_owned);
            // Drain body so the keep-alive connection can be reused.
            let _ = res.bytes().await;

            let now = Instant::now();
            let mut state = self.state.lock().expect("proxy state mutex poisoned");

            if let Some(ref ra) = retry_after {
                state.apply_retry_after(ra);
            }

            // GetServerInfo does not need a key; success only clears rate-limit, not bad_key.
            if status_code < 400 {
                if state.is_rate_limited {
                    state.is_rate_limited = false;
                    state.last_failure_path.clear();
                    state.retry_backoff_secs = MIN_RETRY_BACKOFF_SECS;
                    state.next_probe_at = None;
                    if let Some(started) = state.rate_limit_start.take() {
                        let duration = now.saturating_duration_since(started).as_secs_f64();
                        info!("Rate limit lifted after {duration:.1}s");
                    }
                }
            } else if classify_steam_failure(status_code, retry_after.as_deref(), "") == Some(SteamFailure::RateLimited)
            {
                if retry_after.is_none() {
                    state.retry_backoff_secs = (state.retry_backoff_secs * 2).min(MAX_RETRY_BACKOFF_SECS);
                }
                state.schedule_next_probe(now);
                warn!(
                    "Still rate-limited. Increasing backoff to {}s.",
                    state.retry_backoff_secs
                );
                return;
            } else {
                state.schedule_next_probe(now);
                warn!("Unexpected probe status: {status_code}");
                return;
            }
        }

        // If bad_key is latched, self-heal by re-verifying the last bad key via canary
        // so a pod pulled from LB rotation by health-service isn't stranded forever.
        if is_bad_key {
            if let Some(key) = last_bad_key {
                match self.verify_key_with_canary(&key).await {
                    KeyCanaryOutcome::Valid => {
                        let mut state = self.state.lock().expect("proxy state mutex poisoned");
                        state.is_bad_key = false;
                        state.consecutive_auth_failures = 0;
                        state.last_bad_key = None;
                        state.retry_backoff_secs = MIN_RETRY_BACKOFF_SECS;
                        state.next_probe_at = None;
                        info!("Cleared bad_key after canary key probe succeeded");
                    }
                    KeyCanaryOutcome::BadKey => {
                        let now = Instant::now();
                        let mut state = self.state.lock().expect("proxy state mutex poisoned");
                        state.retry_backoff_secs = (state.retry_backoff_secs * 2).min(MAX_RETRY_BACKOFF_SECS);
                        state.schedule_next_probe(now);
                        warn!(
                            "Key canary still failing; keeping bad_key (next probe in {}s)",
                            state.retry_backoff_secs
                        );
                    }
                    KeyCanaryOutcome::RateLimited(ra) => {
                        self.handle_rate_limit(KEY_CANARY_PATH_PREFIX, ra.as_deref());
                    }
                    KeyCanaryOutcome::Inconclusive => {
                        let mut state = self.state.lock().expect("proxy state mutex poisoned");
                        state.schedule_next_probe(Instant::now());
                    }
                }
            }
        }
    }

    fn handle_rate_limit(&self, path: &str, retry_after: Option<&str>) {
        self.failure.fetch_add(1, Ordering::Relaxed);
        let now = Instant::now();
        let mut state = self.state.lock().expect("proxy state mutex poisoned");
        state.last_failure_path = path.to_string();
        if !state.is_rate_limited {
            state.is_rate_limited = true;
            state.rate_limit_start = Some(now);
            warn!("Entered rate_limited state on {}", redact_steam_path_for_log(path));
        }
        if let Some(ra) = retry_after {
            state.apply_retry_after(ra);
        }
        state.schedule_next_probe(now);
    }

    fn handle_auth_failure(&self, path: &str, status_code: u16, key: Option<&str>) {
        self.failure.fetch_add(1, Ordering::Relaxed);
        let now = Instant::now();
        let mut state = self.state.lock().expect("proxy state mutex poisoned");
        state.consecutive_auth_failures += 1;
        state.last_failure_path = path.to_string();
        if let Some(k) = key {
            state.last_bad_key = Some(k.to_string());
        }
        if state.consecutive_auth_failures >= BAD_KEY_FAILURE_THRESHOLD && !state.is_bad_key {
            state.is_bad_key = true;
            state.schedule_next_probe(now);
            error!(
                "Marked bad_key after {} confirmed auth failures (last HTTP {} on {})",
                state.consecutive_auth_failures,
                status_code,
                redact_steam_path_for_log(path)
            );
        }
    }

    fn clear_failure_state(&self) {
        let mut state = self.state.lock().expect("proxy state mutex poisoned");
        state.consecutive_auth_failures = 0;
        if state.is_bad_key {
            info!("Cleared bad_key after successful Steam response");
        }
        state.is_bad_key = false;
        state.last_bad_key = None;
    }

    /// Test helper: force `next_probe_at` to the past so `check_rate_limiting()` probes immediately.
    #[doc(hidden)]
    pub fn force_probe_due_for_test(&self) {
        let mut state = self.state.lock().expect("proxy state mutex poisoned");
        state.next_probe_at = Some(Instant::now() - Duration::from_secs(1));
    }

    /// Test helper: backdate all recorded request timestamps by `age` to verify RPM sliding expiry.
    #[doc(hidden)]
    pub fn age_request_timestamps_for_test(&self, age: Duration) {
        let mut state = self.state.lock().expect("proxy state mutex poisoned");
        for ts in &mut state.request_timestamps {
            if let Some(aged) = ts.checked_sub(age) {
                *ts = aged;
            }
        }
    }
}

pub fn is_reserved_path(path_only: &str) -> bool {
    matches!(path_only, "/healthz" | "/ready" | "/metrics" | "/metrics/prometheus")
}

fn gunzip_bounded(input: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    let decoder = GzDecoder::new(input);
    let mut limited = decoder.take(MAX_DECOMPRESSED_BYTES + 1);
    let mut out = Vec::new();
    limited.read_to_end(&mut out)?;
    if out.len() as u64 > MAX_DECOMPRESSED_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "decompressed payload exceeds 32 MiB safety limit",
        ));
    }
    Ok(out)
}

/// Match JS `parseInt(headerValue, 10)` semantics for numeric Retry-After values.
fn parse_retry_after_secs(header_value: &str) -> Option<u64> {
    let trimmed = header_value.trim_start();
    let mut chars = trimmed.chars().peekable();
    let negative = match chars.peek() {
        Some('-') => {
            chars.next();
            true
        }
        Some('+') => {
            chars.next();
            false
        }
        _ => false,
    };

    let digits: String = chars.take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    if negative {
        return Some(0);
    }
    digits.parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_retry_after_like_js_parse_int() {
        assert_eq!(parse_retry_after_secs("30"), Some(30));
        assert_eq!(parse_retry_after_secs(" 120 "), Some(120));
        assert_eq!(parse_retry_after_secs("45s"), Some(45));
        assert_eq!(parse_retry_after_secs("-10"), Some(0));
        assert_eq!(parse_retry_after_secs("Wed, 21 Oct 2015 07:28:00 GMT"), None);
        assert_eq!(parse_retry_after_secs(""), None);
    }
}
