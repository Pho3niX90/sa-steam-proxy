use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::header::{ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderMap, Request, Response, StatusCode, Uri};
use axum::routing::get;
use axum::Router;
use flate2::write::GzEncoder;
use flate2::Compression;
use http::header::HeaderValue;
use sa_steam_proxy::config::ProxyConfig;
use sa_steam_proxy::http::build_router;
use sa_steam_proxy::proxy::{ProxyErrorKind, ProxyResult, SteamProxyService, KEY_CANARY_PATH_PREFIX, SAFE_PROBE_PATH};
use sa_steam_proxy::version::ProxyBuildInfo;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tower::ServiceExt;

#[derive(Clone)]
struct MockReply {
    status: StatusCode,
    content_type: Option<String>,
    content_encoding: Option<String>,
    retry_after: Option<String>,
    body: Vec<u8>,
}

impl MockReply {
    fn json(status: StatusCode, body: &str) -> Self {
        Self {
            status,
            content_type: Some("application/json; charset=utf-8".to_string()),
            content_encoding: None,
            retry_after: None,
            body: body.as_bytes().to_vec(),
        }
    }

    fn text(status: StatusCode, body: &str) -> Self {
        Self {
            status,
            content_type: Some("text/plain".to_string()),
            content_encoding: None,
            retry_after: None,
            body: body.as_bytes().to_vec(),
        }
    }

    fn gzip_json(status: StatusCode, body: &str) -> Self {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(body.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();
        Self {
            status,
            content_type: Some("application/json; charset=utf-8".to_string()),
            content_encoding: Some("gzip".to_string()),
            retry_after: None,
            body: compressed,
        }
    }

    fn with_retry_after(mut self, val: &str) -> Self {
        self.retry_after = Some(val.to_string());
        self
    }
}

#[derive(Clone)]
struct RecordedRequest {
    path_and_query: String,
    accept_encoding: Option<String>,
    peer_ip: IpAddr,
}

type ReplyFn = Box<dyn Fn(&str) -> MockReply + Send + Sync>;

struct MockSteamState {
    hits: AtomicUsize,
    recorded: Mutex<Vec<RecordedRequest>>,
    handler: Mutex<ReplyFn>,
}

impl MockSteamState {
    fn new<F>(f: F) -> Arc<Self>
    where
        F: Fn(&str) -> MockReply + Send + Sync + 'static,
    {
        Arc::new(Self {
            hits: AtomicUsize::new(0),
            recorded: Mutex::new(Vec::new()),
            handler: Mutex::new(Box::new(f)),
        })
    }

    fn set_handler<F>(&self, f: F)
    where
        F: Fn(&str) -> MockReply + Send + Sync + 'static,
    {
        *self.handler.lock().unwrap() = Box::new(f);
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }

    fn recorded(&self) -> Vec<RecordedRequest> {
        self.recorded.lock().unwrap().clone()
    }
}

async fn mock_steam_handler(
    State(state): State<Arc<MockSteamState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Response<Body> {
    let pq = uri.path_and_query().map(|x| x.as_str()).unwrap_or("/").to_string();
    state.hits.fetch_add(1, Ordering::SeqCst);
    state.recorded.lock().unwrap().push(RecordedRequest {
        path_and_query: pq.clone(),
        accept_encoding: headers
            .get(ACCEPT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .map(ToOwned::to_owned),
        peer_ip: addr.ip(),
    });

    let reply = {
        let f = state.handler.lock().unwrap();
        f(&pq)
    };

    let mut builder = Response::builder().status(reply.status);
    if let Some(ct) = reply.content_type {
        builder = builder.header(CONTENT_TYPE, ct);
    }
    if let Some(ce) = reply.content_encoding {
        builder = builder.header(CONTENT_ENCODING, ce);
    }
    if let Some(ra) = reply.retry_after {
        builder = builder.header(RETRY_AFTER, ra);
    }
    builder.body(Body::from(reply.body)).unwrap()
}

async fn spawn_mock_steam(state: Arc<MockSteamState>) -> String {
    let app = Router::new().fallback(get(mock_steam_handler)).with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    format!("http://{addr}")
}

fn make_service(
    upstream: String,
    source_ip: Option<IpAddr>,
    cache_ttl: Duration,
    max_cache_entries: u64,
    build_info: ProxyBuildInfo,
) -> Arc<SteamProxyService> {
    let config = ProxyConfig {
        steam_api_host: upstream,
        source_ip,
        cache_ttl,
        max_cache_entries,
        ..ProxyConfig::default()
    };
    Arc::new(SteamProxyService::new(&config, build_info).unwrap())
}

async fn send_get(app: &Router, uri: &str) -> (StatusCode, HeaderMap, String) {
    let req = Request::builder().method("GET").uri(uri).body(Body::empty()).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    (status, headers, String::from_utf8_lossy(&bytes).to_string())
}

fn hdr<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v: &HeaderValue| v.to_str().ok())
}

#[tokio::test]
async fn healthz_ready_metrics_and_reserved_paths() {
    let mock = MockSteamState::new(|_| MockReply::json(StatusCode::OK, r#"{"ok":true}"#));
    let upstream = spawn_mock_steam(mock.clone()).await;
    let build = ProxyBuildInfo {
        version: "0.1.0".to_string(),
        git_sha: Some("abc1234".to_string()),
        image_tag: Some("ghcr.io/pho3nix90/sa-steam-proxy:0.1.0".to_string()),
    };
    let svc = make_service(upstream, None, Duration::from_secs(60), 5000, build);
    let app = build_router(svc.clone());

    // /healthz
    let (status, headers, body) = send_get(&app, "/healthz").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "ok");
    assert_eq!(hdr(&headers, "x-proxy-version"), Some("0.1.0"));
    assert_eq!(hdr(&headers, "x-git-sha"), Some("abc1234"));
    assert_eq!(
        hdr(&headers, "x-image-tag"),
        Some("ghcr.io/pho3nix90/sa-steam-proxy:0.1.0")
    );
    assert_eq!(hdr(&headers, "x-alive"), Some("true"));
    assert_eq!(hdr(&headers, "x-requests-per-minute"), Some("0"));

    // /ready
    let (status, headers, body) = send_get(&app, "/ready").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "ok");
    assert_eq!(hdr(&headers, "x-proxy-version"), Some("0.1.0"));
    assert_eq!(hdr(&headers, "x-git-sha"), Some("abc1234"));
    assert_eq!(
        hdr(&headers, "x-image-tag"),
        Some("ghcr.io/pho3nix90/sa-steam-proxy:0.1.0")
    );
    assert_eq!(hdr(&headers, "x-ready"), Some("true"));
    assert_eq!(hdr(&headers, "x-ready-status"), Some("ok"));
    assert_eq!(hdr(&headers, "x-ratelimit-status"), Some("ok"));
    assert_eq!(hdr(&headers, "x-bad-key"), Some("false"));
    assert_eq!(hdr(&headers, "x-requests-per-minute"), Some("0"));
    assert_eq!(hdr(&headers, "x-backoff"), Some("5"));
    assert_eq!(hdr(&headers, "x-retry-in"), Some("0"));
    assert_eq!(hdr(&headers, "x-auth-failures"), Some("0"));

    // /metrics JSON
    let (status, headers, body) = send_get(&app, "/metrics").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hdr(&headers, "x-proxy-version"), Some("0.1.0"));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["total"], 0);
    assert_eq!(json["success"], 0);
    assert_eq!(json["failure"], 0);
    assert_eq!(json["lastDurationMs"], 0);
    assert_eq!(json["build"]["version"], "0.1.0");
    assert_eq!(json["build"]["gitSha"], "abc1234");
    assert_eq!(json["build"]["imageTag"], "ghcr.io/pho3nix90/sa-steam-proxy:0.1.0");

    // /metrics/prometheus
    let (status, _, prom) = send_get(&app, "/metrics/prometheus").await;
    assert_eq!(status, StatusCode::OK);
    assert!(prom.contains("sa_steam_proxy_ready 1"));
    assert!(prom.contains("sa_steam_proxy_requests_total 0"));

    // Reserved paths with query strings never hit upstream
    let (s1, _, b1) = send_get(&app, "/healthz?probe=1").await;
    let (s2, _, b2) = send_get(&app, "/ready?probe=1").await;
    let (s3, _, _) = send_get(&app, "/metrics?probe=1").await;
    assert_eq!((s1, b1.as_str()), (StatusCode::OK, "ok"));
    assert_eq!((s2, b2.as_str()), (StatusCode::OK, "ok"));
    assert_eq!(s3, StatusCode::OK);
    assert_eq!(mock.hits(), 0);

    // Direct service guard refuses reserved paths
    match svc.proxy("/ready?foo=bar").await {
        ProxyResult::Error { error, status_code } => {
            assert_eq!(error, ProxyErrorKind::Nok);
            assert_eq!(status_code, 404);
        }
        other => panic!("expected 404 nok error, got {other:?}"),
    }
    assert_eq!(mock.hits(), 0);
}

#[tokio::test]
async fn proxy_forwarding_json_text_and_gzip_decompression() {
    let mock = MockSteamState::new(|pq| {
        if pq.starts_with("/json") {
            MockReply::json(
                StatusCode::OK,
                r#"{"response":{"players":[{"steamid":"76561197960435530"}]}}"#,
            )
        } else if pq.starts_with("/gzip") {
            MockReply::gzip_json(StatusCode::OK, r#"{"compressed":true,"id":42}"#)
        } else if pq.starts_with("/badgzip") {
            MockReply {
                status: StatusCode::OK,
                content_type: Some("application/json".to_string()),
                content_encoding: Some("gzip".to_string()),
                retry_after: None,
                body: b"not-valid-gzip-data".to_vec(),
            }
        } else if pq.starts_with("/badjson") {
            MockReply::json(StatusCode::OK, "{broken json")
        } else {
            MockReply::text(StatusCode::OK, "plain text response")
        }
    });

    let upstream = spawn_mock_steam(mock.clone()).await;
    let svc = make_service(upstream, None, Duration::from_secs(60), 5000, ProxyBuildInfo::default());
    let app = build_router(svc);

    // Valid JSON + query forwarding
    let (status, headers, body) = send_get(&app, "/json?key=SECRET123&steamids=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hdr(&headers, "content-type"), Some("application/json; charset=utf-8"));
    assert_eq!(body, r#"{"response":{"players":[{"steamid":"76561197960435530"}]}}"#);

    // Verify accept-encoding: gzip and exact query sent upstream
    let rec = mock.recorded();
    assert_eq!(rec[0].path_and_query, "/json?key=SECRET123&steamids=1");
    assert_eq!(rec[0].accept_encoding.as_deref(), Some("gzip"));

    // Valid gzip JSON
    let (status, headers, body) = send_get(&app, "/gzip?a=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hdr(&headers, "content-type"), Some("application/json; charset=utf-8"));
    assert_eq!(body, r#"{"compressed":true,"id":42}"#);

    // Corrupt gzip -> 502 decompression_failed
    let (status, headers, body) = send_get(&app, "/badgzip").await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body, "decompression_failed");
    assert_eq!(hdr(&headers, "x-status-message"), Some("decompression_failed"));
    assert_eq!(hdr(&headers, "x-ratelimit-status"), Some("ok"));
    assert_eq!(hdr(&headers, "x-bad-key"), Some("false"));

    // Invalid JSON with application/json content-type falls back to text/plain
    let (status, headers, body) = send_get(&app, "/badjson").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hdr(&headers, "content-type"), Some("text/plain; charset=utf-8"));
    assert_eq!(body, "{broken json");

    // Plain text response
    let (status, headers, body) = send_get(&app, "/plain").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hdr(&headers, "content-type"), Some("text/plain; charset=utf-8"));
    assert_eq!(body, "plain text response");
}

#[tokio::test]
async fn cache_hit_ttl_expiry_and_bounded_eviction() {
    let mock = MockSteamState::new(|pq| MockReply::json(StatusCode::OK, &format!(r#"{{"path":"{pq}"}}"#)));
    let upstream = spawn_mock_steam(mock.clone()).await;

    // Short TTL (150ms) and small capacity (3) for fast deterministic testing
    let svc = make_service(upstream, None, Duration::from_millis(150), 3, ProxyBuildInfo::default());
    let app = build_router(svc.clone());

    let (s1, _, b1) = send_get(&app, "/item?id=1").await;
    assert_eq!(s1, StatusCode::OK);
    assert_eq!(mock.hits(), 1);

    // Second request is a cache HIT (no upstream call)
    let (s2, _, b2) = send_get(&app, "/item?id=1").await;
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(b1, b2);
    assert_eq!(mock.hits(), 1);

    // Metrics: total=2 (includes hit), success=1 (only upstream)
    let m = svc.metrics();
    assert_eq!(m.total, 2);
    assert_eq!(m.success, 1);

    // Wait past TTL -> cache miss
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (s3, _, _) = send_get(&app, "/item?id=1").await;
    assert_eq!(s3, StatusCode::OK);
    assert_eq!(mock.hits(), 2);

    // Bounded capacity eviction: insert 10 distinct entries into max_capacity=3
    let svc_cap = make_service(
        spawn_mock_steam(mock.clone()).await,
        None,
        Duration::from_secs(60),
        3,
        ProxyBuildInfo::default(),
    );
    let app_cap = build_router(svc_cap.clone());
    for i in 0..10 {
        let (s, _, _) = send_get(&app_cap, &format!("/cap/{i}")).await;
        assert_eq!(s, StatusCode::OK);
    }
    svc_cap.run_pending_cache_tasks();
    // At least several of the 10 keys must have been evicted
    let hits_before = mock.hits();
    for i in 0..10 {
        let (s, _, _) = send_get(&app_cap, &format!("/cap/{i}")).await;
        assert_eq!(s, StatusCode::OK);
    }
    let misses = mock.hits() - hits_before;
    assert!(
        misses >= 7,
        "expected >=7 cache misses with max_capacity=3, got {misses}"
    );
}

#[tokio::test]
async fn rate_limit_backoff_cache_hit_and_probe_recovery() {
    let mock = MockSteamState::new(|pq| {
        if pq == "/cached" {
            MockReply::json(StatusCode::OK, r#"{"cached":true}"#)
        } else if pq == "/throttle-bare-403" {
            MockReply::text(StatusCode::FORBIDDEN, "Forbidden")
        } else if pq == SAFE_PROBE_PATH {
            MockReply::text(StatusCode::TOO_MANY_REQUESTS, "still busy")
        } else {
            MockReply::json(StatusCode::OK, r#"{"ok":true}"#)
        }
    });

    let upstream = spawn_mock_steam(mock.clone()).await;
    let svc = make_service(upstream, None, Duration::from_secs(60), 5000, ProxyBuildInfo::default());
    let app = build_router(svc.clone());

    // Prime cache for /cached
    let (s, _, _) = send_get(&app, "/cached").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(mock.hits(), 1);

    // Trigger rate_limited via bare 403 (Steam throttle)
    let (s, headers, body) = send_get(&app, "/throttle-bare-403").await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body, "rate_limited");
    assert_eq!(hdr(&headers, "x-ratelimit-status"), Some("limited"));
    assert_eq!(hdr(&headers, "x-bad-key"), Some("false"));
    assert_eq!(hdr(&headers, "x-status-message"), Some("rate_limited"));

    // /ready reports 503 rate_limited
    let (s, headers, body) = send_get(&app, "/ready").await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, "rate_limited");
    assert_eq!(hdr(&headers, "x-ready"), Some("false"));
    assert_eq!(hdr(&headers, "x-ready-status"), Some("rate_limited"));
    assert_eq!(hdr(&headers, "x-ratelimit-status"), Some("limited"));
    assert_eq!(hdr(&headers, "x-backoff"), Some("5"));
    assert!(hdr(&headers, "x-retry-in").unwrap().parse::<u64>().unwrap() >= 1);

    // Cached entry is STILL served even while rate-limited
    let hits_before = mock.hits();
    let (s, _, body) = send_get(&app, "/cached").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body, r#"{"cached":true}"#);
    assert_eq!(mock.hits(), hits_before);

    // Uncached entry is short-circuited with 429 without hitting upstream
    let (s, _, body) = send_get(&app, "/uncached").await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body, "rate_limited");
    assert_eq!(mock.hits(), hits_before);

    // Probe before nextProbeAt is a no-op
    svc.check_rate_limiting().await;
    assert_eq!(mock.hits(), hits_before);

    // Force probe due -> still 429 -> backoff doubles 5 -> 10
    svc.force_probe_due_for_test();
    svc.check_rate_limiting().await;
    assert_eq!(svc.ready_status().backoff, 10);
    assert!(svc.ready_status().rate_limited);

    // Probe returns 429 with Retry-After: 42 -> backoff becomes 42
    mock.set_handler(|_| MockReply::text(StatusCode::TOO_MANY_REQUESTS, "").with_retry_after("42"));
    svc.force_probe_due_for_test();
    svc.check_rate_limiting().await;
    assert_eq!(svc.ready_status().backoff, 42);

    // Probe returns 503 with huge Retry-After: 999 -> clamped to 300
    mock.set_handler(|_| MockReply::text(StatusCode::SERVICE_UNAVAILABLE, "").with_retry_after("999"));
    svc.force_probe_due_for_test();
    svc.check_rate_limiting().await;
    assert_eq!(svc.ready_status().backoff, 300);

    // Probe returns 200 -> rate limit lifted, backoff reset to 5, retryIn 0
    mock.set_handler(|_| MockReply::json(StatusCode::OK, r#"{"servertime":123456}"#));
    svc.force_probe_due_for_test();
    svc.check_rate_limiting().await;

    let (s, headers, body) = send_get(&app, "/ready").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body, "ok");
    assert_eq!(hdr(&headers, "x-ready"), Some("true"));
    assert_eq!(hdr(&headers, "x-backoff"), Some("5"));
    assert_eq!(hdr(&headers, "x-retry-in"), Some("0"));
}

#[tokio::test]
async fn bad_key_latching_non_short_circuit_and_recovery() {
    let mock = MockSteamState::new(|pq| {
        if pq == SAFE_PROBE_PATH {
            MockReply::json(StatusCode::OK, r#"{"servertime":1}"#)
        } else if pq.contains("key=BAD") {
            MockReply::text(
                StatusCode::FORBIDDEN,
                "<html><body>Access is denied. Please verify your <pre>key=</pre> parameter.</body></html>",
            )
        } else if pq.contains("key=UNAUTH") {
            MockReply::text(StatusCode::UNAUTHORIZED, "Invalid API key")
        } else {
            MockReply::json(StatusCode::OK, r#"{"recovered":true}"#)
        }
    });

    let upstream = spawn_mock_steam(mock.clone()).await;
    let svc = make_service(upstream, None, Duration::from_secs(60), 5000, ProxyBuildInfo::default());
    let app = build_router(svc.clone());

    // Failure 1 (401 with explicit key-blame + canary confirms BadKey) -> returns 401 bad_key, /ready still ok
    let (s, headers, body) = send_get(&app, "/p1?key=UNAUTH").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(body, "bad_key");
    assert_eq!(hdr(&headers, "x-bad-key"), Some("true"));
    assert_eq!(hdr(&headers, "x-ratelimit-status"), Some("ok"));
    assert_eq!(hdr(&headers, "x-status-message"), Some("bad_key"));
    assert!(svc.ready_status().ready);
    assert_eq!(svc.ready_status().auth_failures, 1);

    // Failure 2 (403 key-blame + canary confirms BadKey) -> returns 403 bad_key, /ready still ok
    let (s, _, body) = send_get(&app, "/p2?key=BAD").await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(body, "bad_key");
    assert!(svc.ready_status().ready);
    assert_eq!(svc.ready_status().auth_failures, 2);

    // Failure 3 -> latches bad_key!
    let (s, _, _) = send_get(&app, "/p3?key=BAD").await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    let (s, headers, body) = send_get(&app, "/ready").await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, "bad_key");
    assert_eq!(hdr(&headers, "x-ready"), Some("false"));
    assert_eq!(hdr(&headers, "x-ready-status"), Some("bad_key"));
    assert_eq!(hdr(&headers, "x-bad-key"), Some("true"));
    assert_eq!(hdr(&headers, "x-ratelimit-status"), Some("ok"));
    assert_eq!(hdr(&headers, "x-auth-failures"), Some("3"));

    // Canary probe still fails for key=BAD -> stays bad_key
    svc.force_probe_due_for_test();
    svc.check_rate_limiting().await;
    assert!(svc.ready_status().bad_key);
    assert!(!svc.ready_status().ready);

    // Traffic is NOT short-circuited while bad_key is latched -> rotated key recovers!
    let (s, _, body) = send_get(&app, "/p4?key=GOOD").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body, r#"{"recovered":true}"#);

    let (s, headers, body) = send_get(&app, "/ready").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body, "ok");
    assert_eq!(hdr(&headers, "x-bad-key"), Some("false"));
    assert_eq!(hdr(&headers, "x-auth-failures"), Some("0"));
}

#[tokio::test]
async fn private_get_friend_list_401_never_marks_bad_key_and_canary_prevents_false_positives() {
    let mock = MockSteamState::new(|pq| {
        if pq.starts_with(KEY_CANARY_PATH_PREFIX) {
            // Canary proves the API key is valid!
            MockReply::json(
                StatusCode::OK,
                r#"{"response":{"players":[{"steamid":"76561197960287930"}]}}"#,
            )
        } else if pq.starts_with("/ISteamUser/GetFriendList/") {
            // Steam's actual private friend list response: HTTP 401 with `{}`
            MockReply::json(StatusCode::UNAUTHORIZED, "{}")
        } else if pq.starts_with("/quirky-endpoint") {
            // Endpoint returns 403 with "Access is denied" even though the key is valid
            MockReply::text(StatusCode::FORBIDDEN, "Access is denied")
        } else {
            MockReply::json(StatusCode::OK, r#"{"ok":true}"#)
        }
    });

    let upstream = spawn_mock_steam(mock.clone()).await;
    let svc = make_service(upstream, None, Duration::from_secs(60), 5000, ProxyBuildInfo::default());
    let app = build_router(svc.clone());

    // 10 consecutive private GetFriendList 401s must NEVER latch bad_key or count as proxy failures
    for i in 0..10 {
        let (s, headers, body) = send_get(
            &app,
            &format!("/ISteamUser/GetFriendList/v0001?steamid=7656119912269534{i}&relationship=friend&key=GOODKEY"),
        )
        .await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert_eq!(body, "upstream_error");
        assert_eq!(hdr(&headers, "x-bad-key"), Some("false"));
    }
    assert!(svc.ready_status().ready);
    assert!(!svc.ready_status().bad_key);
    assert_eq!(svc.ready_status().auth_failures, 0);
    assert_eq!(svc.metrics().failure, 0);
    // And no canary probe was even needed for private GetFriendList 401s
    assert_eq!(mock.hits(), 10);

    // Endpoint-specific 403 with "Access is denied" triggers canary probe, which succeeds -> NOT bad_key!
    for i in 0..4 {
        let (s, headers, body) = send_get(&app, &format!("/quirky-endpoint/{i}?key=GOODKEY")).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        assert_eq!(body, "upstream_error");
        assert_eq!(hdr(&headers, "x-bad-key"), Some("false"));
    }
    assert!(svc.ready_status().ready);
    assert!(!svc.ready_status().bad_key);
    assert_eq!(svc.ready_status().auth_failures, 0);
}

#[tokio::test]
async fn bad_key_self_heals_via_canary_probe_and_cache_ignores_key_param() {
    let mock = MockSteamState::new(|pq| {
        if pq.contains("key=FLAKY") {
            MockReply::text(StatusCode::FORBIDDEN, "Access is denied")
        } else {
            MockReply::json(StatusCode::OK, r#"{"ok":true}"#)
        }
    });

    let upstream = spawn_mock_steam(mock.clone()).await;
    let svc = make_service(upstream, None, Duration::from_secs(60), 5000, ProxyBuildInfo::default());
    let app = build_router(svc.clone());

    // Confirm bad_key latch after 3 verified failures
    for i in 0..3 {
        let (s, _, _) = send_get(&app, &format!("/check/{i}?key=FLAKY")).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    assert!(svc.ready_status().bad_key);

    // Keyless caller 403 on a fresh proxy must NOT latch bad_key
    let keyless_svc = make_service(
        spawn_mock_steam(MockSteamState::new(|_| {
            MockReply::text(StatusCode::FORBIDDEN, "Access is denied")
        }))
        .await,
        None,
        Duration::from_secs(60),
        5000,
        ProxyBuildInfo::default(),
    );
    let keyless_app = build_router(keyless_svc.clone());
    for i in 0..4 {
        let (s, _, _) = send_get(&keyless_app, &format!("/nokey/{i}")).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    assert!(!keyless_svc.ready_status().bad_key);

    // Now upstream stops rejecting FLAKY -> background probe self-heals bad_key!
    mock.set_handler(|_| MockReply::json(StatusCode::OK, r#"{"response":{"players":[]}}"#));
    svc.force_probe_due_for_test();
    svc.check_rate_limiting().await;
    assert!(!svc.ready_status().bad_key);
    assert!(svc.ready_status().ready);

    // Cache key is key-agnostic across key rotations
    let hits_before = mock.hits();
    let (s1, _, _) = send_get(&app, "/ISteamUser/GetPlayerSummaries/v0002?steamids=1&key=KEY_A").await;
    let (s2, _, _) = send_get(&app, "/ISteamUser/GetPlayerSummaries/v0002?steamids=1&key=KEY_B").await;
    assert_eq!((s1, s2), (StatusCode::OK, StatusCode::OK));
    assert_eq!(mock.hits(), hits_before + 1);
}

#[tokio::test]
async fn upstream_errors_and_network_failures() {
    let mock = MockSteamState::new(|pq| {
        if pq == "/notfound" {
            MockReply::text(StatusCode::NOT_FOUND, "missing")
        } else {
            MockReply::text(StatusCode::INTERNAL_SERVER_ERROR, "boom")
        }
    });
    let upstream = spawn_mock_steam(mock).await;
    let svc = make_service(upstream, None, Duration::from_secs(60), 5000, ProxyBuildInfo::default());
    let app = build_router(svc);

    let (s, headers, body) = send_get(&app, "/notfound").await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(body, "upstream_error");
    assert_eq!(hdr(&headers, "x-status-message"), Some("upstream_error"));
    assert_eq!(hdr(&headers, "x-ratelimit-status"), Some("ok"));
    assert_eq!(hdr(&headers, "x-bad-key"), Some("false"));

    let (s, headers, body) = send_get(&app, "/err500").await;
    assert_eq!(s, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, "upstream_error");
    assert_eq!(hdr(&headers, "x-status-message"), Some("upstream_error"));

    // Unreachable upstream -> 502 nok
    let closed_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_addr = closed_listener.local_addr().unwrap();
    drop(closed_listener);

    let dead_svc = make_service(
        format!("http://{dead_addr}"),
        None,
        Duration::from_secs(60),
        5000,
        ProxyBuildInfo::default(),
    );
    let dead_app = build_router(dead_svc);
    let (s, headers, body) = send_get(&dead_app, "/test?key=SUPERSECRET").await;
    assert_eq!(s, StatusCode::BAD_GATEWAY);
    assert_eq!(body, "nok");
    assert_eq!(hdr(&headers, "x-status-message"), Some("nok"));
}

#[tokio::test]
async fn source_ip_binding_and_rpm_sliding_window() {
    let mock = MockSteamState::new(|_| MockReply::json(StatusCode::OK, r#"{"ok":true}"#));
    let upstream = spawn_mock_steam(mock.clone()).await;

    let loopback = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let svc = make_service(
        upstream,
        Some(loopback),
        Duration::from_secs(60),
        5000,
        ProxyBuildInfo::default(),
    );
    let app = build_router(svc.clone());

    let (s, _, _) = send_get(&app, "/egress-test").await;
    assert_eq!(s, StatusCode::OK);
    let rec = mock.recorded();
    assert_eq!(rec.len(), 1);
    assert_eq!(rec[0].peer_ip, loopback);

    // RPM reflects the 1 request
    let (_, headers, _) = send_get(&app, "/healthz").await;
    assert_eq!(hdr(&headers, "x-requests-per-minute"), Some("1"));

    // Aging past 60s expires the timestamp from the sliding window
    svc.age_request_timestamps_for_test(Duration::from_secs(61));
    svc.cleanup_old_requests();
    let (_, headers, _) = send_get(&app, "/healthz").await;
    assert_eq!(hdr(&headers, "x-requests-per-minute"), Some("0"));
}

#[tokio::test]
async fn combined_bad_key_and_rate_limit_precedence_and_extra_rate_limit_triggers() {
    // Verify 420, 503, Retry-After on 200, and rate-limit body text all enter rate_limited
    for (name, reply) in [
        ("420", MockReply::text(StatusCode::from_u16(420).unwrap(), "")),
        ("503", MockReply::text(StatusCode::SERVICE_UNAVAILABLE, "busy")),
        (
            "retry_after_200",
            MockReply::json(StatusCode::OK, r#"{}"#).with_retry_after("15"),
        ),
        (
            "body_text",
            MockReply::text(StatusCode::INTERNAL_SERVER_ERROR, "Too Many Requests"),
        ),
    ] {
        let reply_clone = reply.clone();
        let mock = MockSteamState::new(move |_| reply_clone.clone());
        let upstream = spawn_mock_steam(mock).await;
        let svc = make_service(upstream, None, Duration::from_secs(60), 5000, ProxyBuildInfo::default());
        let app = build_router(svc.clone());

        let (s, headers, body) = send_get(&app, &format!("/trigger/{name}")).await;
        assert_eq!(s, StatusCode::TOO_MANY_REQUESTS, "case {name}");
        assert_eq!(body, "rate_limited", "case {name}");
        assert_eq!(hdr(&headers, "x-ratelimit-status"), Some("limited"), "case {name}");
        assert!(svc.ready_status().rate_limited, "case {name}");
    }

    // Verify when both bad_key and rate_limited are active, /ready reports rate_limited
    // while setting BOTH X-RateLimit-Status: limited and X-Bad-Key: true.
    let mock = MockSteamState::new(|pq| {
        if pq.contains("key=BAD") {
            MockReply::text(StatusCode::FORBIDDEN, "Access is denied")
        } else {
            MockReply::text(StatusCode::TOO_MANY_REQUESTS, "")
        }
    });
    let upstream = spawn_mock_steam(mock).await;
    let svc = make_service(upstream, None, Duration::from_secs(60), 5000, ProxyBuildInfo::default());
    let app = build_router(svc);

    for i in 0..3 {
        let (s, _, _) = send_get(&app, &format!("/auth/{i}?key=BAD")).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    let (s, _, _) = send_get(&app, "/limit").await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);

    let (s, headers, body) = send_get(&app, "/ready").await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body, "rate_limited");
    assert_eq!(hdr(&headers, "x-ready"), Some("false"));
    assert_eq!(hdr(&headers, "x-ready-status"), Some("rate_limited"));
    assert_eq!(hdr(&headers, "x-ratelimit-status"), Some("limited"));
    assert_eq!(hdr(&headers, "x-bad-key"), Some("true"));
    assert_eq!(hdr(&headers, "x-auth-failures"), Some("3"));
}
