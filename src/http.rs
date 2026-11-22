use crate::proxy::{MetricsSnapshot, ProxyErrorKind, ProxyResult, SteamProxyService};
use crate::version::ProxyBuildInfo;
use axum::body::Body;
use axum::extract::State;
use axum::http::header::{HeaderName, HeaderValue, CONTENT_TYPE};
use axum::http::{Response, StatusCode, Uri};
use axum::routing::get;
use axum::Router;
use serde::Serialize;
use std::sync::Arc;

static HEADER_ALIVE: HeaderName = HeaderName::from_static("x-alive");
static HEADER_REQUESTS_PER_MINUTE: HeaderName = HeaderName::from_static("x-requests-per-minute");
static HEADER_READY: HeaderName = HeaderName::from_static("x-ready");
static HEADER_READY_STATUS: HeaderName = HeaderName::from_static("x-ready-status");
static HEADER_RATELIMIT_STATUS: HeaderName = HeaderName::from_static("x-ratelimit-status");
static HEADER_BAD_KEY: HeaderName = HeaderName::from_static("x-bad-key");
static HEADER_BACKOFF: HeaderName = HeaderName::from_static("x-backoff");
static HEADER_RETRY_IN: HeaderName = HeaderName::from_static("x-retry-in");
static HEADER_AUTH_FAILURES: HeaderName = HeaderName::from_static("x-auth-failures");
static HEADER_STATUS_MESSAGE: HeaderName = HeaderName::from_static("x-status-message");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricsPayload<'a> {
    #[serde(flatten)]
    metrics: MetricsSnapshot,
    build: &'a ProxyBuildInfo,
}

pub fn build_router(service: Arc<SteamProxyService>) -> Router {
    Router::new()
        .route("/healthz", get(healthz_handler))
        .route("/ready", get(ready_handler))
        .route("/metrics", get(metrics_handler))
        .route("/metrics/prometheus", get(prometheus_metrics_handler))
        .fallback(get(proxy_handler))
        .with_state(service)
}

async fn healthz_handler(State(service): State<Arc<SteamProxyService>>) -> Response<Body> {
    let live = service.liveness_status();
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from("ok"))
        .expect("valid healthz response");

    let headers = resp.headers_mut();
    service.build_info().apply_headers(headers);
    headers.insert(HEADER_ALIVE.clone(), HeaderValue::from_static("true"));
    headers.insert(
        HEADER_REQUESTS_PER_MINUTE.clone(),
        HeaderValue::from_str(&live.requests_per_minute.to_string()).expect("valid int header"),
    );
    resp
}

async fn ready_handler(State(service): State<Arc<SteamProxyService>>) -> Response<Body> {
    let ready = service.ready_status();
    let status = if ready.ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let body = if ready.ready { "ok" } else { ready.status };

    let mut resp = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(body))
        .expect("valid ready response");

    let headers = resp.headers_mut();
    service.build_info().apply_headers(headers);
    headers.insert(
        HEADER_READY.clone(),
        HeaderValue::from_static(if ready.ready { "true" } else { "false" }),
    );
    headers.insert(HEADER_READY_STATUS.clone(), HeaderValue::from_static(ready.status));
    headers.insert(
        HEADER_RATELIMIT_STATUS.clone(),
        HeaderValue::from_static(if ready.rate_limited { "limited" } else { "ok" }),
    );
    headers.insert(
        HEADER_BAD_KEY.clone(),
        HeaderValue::from_static(if ready.bad_key { "true" } else { "false" }),
    );
    headers.insert(
        HEADER_REQUESTS_PER_MINUTE.clone(),
        HeaderValue::from_str(&ready.requests_per_minute.to_string()).expect("valid int header"),
    );
    headers.insert(
        HEADER_BACKOFF.clone(),
        HeaderValue::from_str(&ready.backoff.to_string()).expect("valid int header"),
    );
    headers.insert(
        HEADER_RETRY_IN.clone(),
        HeaderValue::from_str(&ready.retry_in.to_string()).expect("valid int header"),
    );
    headers.insert(
        HEADER_AUTH_FAILURES.clone(),
        HeaderValue::from_str(&ready.auth_failures.to_string()).expect("valid int header"),
    );
    resp
}

async fn metrics_handler(State(service): State<Arc<SteamProxyService>>) -> Response<Body> {
    let payload = MetricsPayload {
        metrics: service.metrics(),
        build: service.build_info(),
    };
    let json = serde_json::to_vec(&payload).expect("serialize metrics payload");

    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(json))
        .expect("valid metrics response");

    service.build_info().apply_headers(resp.headers_mut());
    resp
}

async fn prometheus_metrics_handler(State(service): State<Arc<SteamProxyService>>) -> Response<Body> {
    let text = service.prometheus_metrics();
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")
        .body(Body::from(text))
        .expect("valid prometheus response");

    service.build_info().apply_headers(resp.headers_mut());
    resp
}

async fn proxy_handler(State(service): State<Arc<SteamProxyService>>, uri: Uri) -> Response<Body> {
    let path_and_query = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    match service.proxy(path_and_query).await {
        ProxyResult::Success {
            body,
            is_json,
            status_code,
        } => {
            let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);
            let content_type = if is_json {
                "application/json; charset=utf-8"
            } else {
                "text/plain; charset=utf-8"
            };
            Response::builder()
                .status(status)
                .header(CONTENT_TYPE, content_type)
                .body(Body::from(body))
                .expect("valid proxy success response")
        }
        ProxyResult::Error { error, status_code } => {
            let code = if status_code == 0 {
                error.default_status()
            } else {
                status_code
            };
            let status = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let msg = error.as_str();
            Response::builder()
                .status(status)
                .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                .header(
                    HEADER_RATELIMIT_STATUS.clone(),
                    if error == ProxyErrorKind::RateLimited {
                        "limited"
                    } else {
                        "ok"
                    },
                )
                .header(
                    HEADER_BAD_KEY.clone(),
                    if error == ProxyErrorKind::BadKey {
                        "true"
                    } else {
                        "false"
                    },
                )
                .header(HEADER_STATUS_MESSAGE.clone(), msg)
                .body(Body::from(msg))
                .expect("valid proxy error response")
        }
    }
}
