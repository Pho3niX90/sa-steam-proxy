# sa-steam-proxy: NestJS/Fastify → Rust parity checklist

Source of truth for the rewrite of `sa-steam-proxy` (NestJS 11 + Fastify + undici, 633 LOC) to Rust (`axum` + `reqwest`/`hyper` + `moka`). Every behaviour below was audited from the NestJS source (`src/*.ts`) and downstream callers (`backend/apps/health-service/src/crons/proxy-health-check.cron.service.ts`, `backend/apps/api/src/endpoints/site-admin/steam-proxy-k8s.service.ts`, `backend/apps/api/src/endpoints/site-admin/steam-proxy-lifecycle.service.ts`, `backend/apps/api/src/endpoints/site-admin/steam-proxy-diagnostics.ts`, `backend/libs/common/src/integrations/SteamLib.ts`) and is marked:

- ✅ Ported with exact parity
- ⚠️ Ported with a deliberate, documented improvement
- ❓ Owner decision required

---

## 1. Why rewrite `sa-steam-proxy`

Observed in production (`kubectl -n steam-proxies`, 13 `hostNetwork` pods on `falk-ax41-01`, one per `/28` egress `SOURCE_IP`, 2026-11-22):

- **Memory footprint:** 13 pods × ~42 MiB live RSS = **~551 MiB live RAM**, with **1,664 MiB reserved** (`128Mi` request / `512Mi` limit per pod) for a stateless 633-LOC HTTP proxy with zero database, Redis, or Kafka dependencies.
- **Nightly self-kill workaround:** `AppController.restart()` ran `@Cron(EVERY_DAY_AT_MIDNIGHT) process.exit()` to clear V8 heap/socket state, causing 13 synchronized pod restarts every midnight.
- **Image bloat:** Node 22 Alpine + NestJS + Fastify + Express + RxJS + undici runtime layers (~180+ MB).

The Rust rewrite targets **~4–6 MiB RSS per pod** (~65 MiB across all 13 pods, freeing ~485 MiB live and ~1.45 GiB reserved), distroless non-root runtime (~25 MB image), deterministic bounded caching (`moka`), and no V8 heap restarts. Measured side-by-side numbers are in [`RESULTS.md`](./RESULTS.md).

---

## 2. Parity Inventory

### HTTP Endpoints & Reserved Paths (`src/app.controller.ts`, `src/version.ts`)

| Behaviour | Status | Notes |
|---|---|---|
| `GET /healthz`: always `200`, body `"ok"`, headers `X-Proxy-Version` (+ optional `X-Git-Sha`, `X-Image-Tag`), `X-Alive: true`, `X-Requests-Per-Minute` | ✅ | `src/http.rs` |
| `GET /ready`: `200` + `"ok"` when ready; `503` + `"rate_limited"` or `"bad_key"` when not (`rate_limited` takes precedence if both active); headers `X-Proxy-Version`, optional `X-Git-Sha` / `X-Image-Tag`, `X-Ready`, `X-Ready-Status`, `X-RateLimit-Status`, `X-Bad-Key`, `X-Requests-Per-Minute`, `X-Backoff`, `X-Retry-In`, `X-Auth-Failures` | ✅ | `src/http.rs`, matches `ProxyHealthCheckCronService.parseReadyResponse` |
| `GET /metrics`: `200` JSON `{ total, success, failure, lastDurationMs, build: { version, gitSha, imageTag } }` + version headers | ✅ | Kept as exact JSON so existing callers never break |
| `GET /metrics/prometheus`: Prometheus text exposition format (`sa_steam_proxy_*` counters & gauges) | ⚠️ | Additive endpoint; `/metrics` remains JSON |
| `GET /*` catch-all forwards exact path + query string to Steam Web API; never proxies `/healthz`, `/ready`, `/metrics` (even with query strings) | ✅ | Defense-in-depth guard in both router and `SteamProxyService::proxy` |
| `version` resolution: `APP_VERSION` → `npm_package_version` → crate version (`0.1.0`); `gitSha`: `GIT_SHA` → `GITHUB_SHA` → `COMMIT_SHA`; `imageTag`: `IMAGE_TAG` → `STEAM_PROXY_IMAGE` | ✅ | `src/version.rs`; `0.1.0` > `0.0.4` so site-admin fleet version comparisons treat Rust pods as newer |

### Networking, Egress Binding & Pooling (`src/main.ts`, `src/steam-proxy.service.ts`)

| Behaviour | Status | Notes |
|---|---|---|
| `LISTEN_HOST` (default `0.0.0.0`), `LISTEN_PORT` (default `8080`) | ✅ | `src/config.rs` |
| `SOURCE_IP` local socket binding on outbound HTTP client | ✅ | `reqwest::ClientBuilder::local_address(ip)` |
| Invalid `SOURCE_IP` handling | ⚠️ | Fails fast at startup instead of silently failing on first upstream request |
| Keep-alive HTTP connection pool (up to 100 idle connections, 60s idle timeout) | ✅ | `reqwest` / `hyper` pool (`pool_max_idle_per_host(100)`, `pool_idle_timeout(60s)`) |
| `STEAM_API_HOST` upstream base URL (default `http://api.steampowered.com`) | ⚠️ | Overridable via `STEAM_API_HOST` env var for tests and benchmarks |
| Upstream request/connect timeouts | ⚠️ | Added 15s connect timeout and 30s total request timeout (`UPSTREAM_TIMEOUT_MS` override); Nest/undici relied on 300s defaults |
| Graceful shutdown on `SIGTERM` / `SIGINT` | ⚠️ | Clean Axum graceful shutdown when Kubernetes terminates/recreates a pod |

### Caching, Compression & Response Semantics (`src/steam-proxy.service.ts`)

| Behaviour | Status | Notes |
|---|---|---|
| 60s TTL, max 5,000-entry bounded in-memory cache keyed on full path + query | ✅ | `moka::sync::Cache` (lock-free reads, automatic TTL & capacity eviction) |
| Cache HIT served before `isRateLimited` check; still counts toward `total` and `X-Requests-Per-Minute`, does not increment `success` | ✅ | Exact ordering from `steam-proxy.service.ts` L156–L173 |
| Outbound `accept-encoding: gzip` + manual gzip decompression | ✅ | `flate2::read::GzDecoder` with `reqwest` auto-decompression disabled |
| Corrupt gzip body → HTTP `502`, body `decompression_failed`, `X-Status-Message: decompression_failed`, `X-RateLimit-Status: ok`, `X-Bad-Key: false` | ✅ | Exact parity |
| JSON vs raw text response handling: `application/json` + non-empty valid JSON → `application/json; charset=utf-8`; invalid JSON logs warning and falls back to `text/plain; charset=utf-8`; non-JSON → `text/plain; charset=utf-8` | ✅ | Validated with `serde_json::from_slice::<IgnoredAny>` without re-serializing, preserving exact upstream bytes |
| Status code preservation on success (e.g., 200, 204) and errors | ✅ | Exact parity |

### Failure Classification, Latching, Backoff & Probing (`src/steam-failure.ts`, `src/steam-proxy.service.ts`)

| Behaviour | Status | Notes |
|---|---|---|
| `classifySteamFailure`: `429`, `420`, `503`, or non-empty `Retry-After` → `rate_limited` | ✅ | `src/steam_failure.rs` (all cases from `steam-failure.spec.ts` ported) |
| Body regex `/too many requests\|rate.?limit\|request limit\|try again later/i` → `rate_limited` | ✅ | Case-insensitive regex |
| `401` → `bad_key` | ✅ | Preserves `401` status |
| `403` with key-blame body (`/access is denied\|invalid.*(?:api.?)?key\|(?:api.?)?key.*(?:invalid\|denied\|revoked\|missing)\|unauthorized/i`) → `bad_key` | ✅ | Preserves `403` status (consumed by `SteamProxyLifecycleService.probeKeyViaProxy`) |
| Bare / generic `403` → `rate_limited` | ✅ | Returns `429` + `rate_limited` |
| `bad_key` latching after 3 consecutive auth failures (`BAD_KEY_FAILURE_THRESHOLD = 3`); never short-circuits proxy requests so rotated keys recover; cleared on any `<400` proxied response | ✅ | Exact parity |
| `rate_limited` short-circuits uncached requests with `429` + `rate_limited`, `X-RateLimit-Status: limited`, `X-Bad-Key: false`, `X-Status-Message: rate_limited` | ✅ | Exact parity |
| Other `>= 400` upstream responses → original status + `upstream_error` (`X-Status-Message: upstream_error`) | ✅ | Exact parity |
| Transport / network error → `502` + `nok` (`X-Status-Message: nok`) | ✅ | Exact parity |
| API key redaction in all logs (`?key=***` / `&key=***`, case-insensitive) | ✅ | Applied to paths AND upstream transport error messages (prevents `reqwest` URL key leaks) |
| Background 5-minute probe to `/ISteamWebAPIUtil/GetServerInfo/v0001/` with exponential backoff (`5s`..`300s`) and `Retry-After` parsing; probe success clears `rate_limited` but never clears `bad_key` | ✅ | `PROBE_INTERVAL_SECS` defaults to `300` |
| Sliding 1-minute RPM window pruned every 10s even under zero traffic | ✅ | `VecDeque<Instant>` with O(1) expiry pop |

### Midnight Self-Restart Cron (`src/app.controller.ts` L125–L129)

| Behaviour | Status | Notes |
|---|---|---|
| `@Cron(EVERY_DAY_AT_MIDNIGHT) process.exit()` | ❓ | **Disabled by default** in Rust; opt-in via `MIDNIGHT_RESTART=true`. See §3. |

---

## 3. Owner Decisions

1. **Midnight self-restart (`MIDNIGHT_RESTART`):** NestJS exited at midnight every day as a workaround for V8 heap growth and stale undici sockets. In Rust, memory stays flat (~4–6 MiB) and the HTTP pool evicts idle sockets after 60s, so synchronized midnight restarts across all 13 pods are unnecessary and briefly disrupt traffic. **Recommendation:** keep `MIDNIGHT_RESTART=false` (default), with `MIDNIGHT_RESTART=true` available if you ever want to re-enable it.
2. **Kubernetes resource requests/limits (`steam-proxy-k8s.service.ts` & `pod-example.yaml`):** Currently `requests: { cpu: '50m', memory: '128Mi' }`, `limits: { cpu: '500m', memory: '512Mi' }`. Based on measured Rust benchmarks in [`RESULTS.md`](./RESULTS.md), recommended sizing is `requests: { cpu: '10m', memory: '16Mi' }`, `limits: { cpu: '250m', memory: '64Mi' }` (freeing ~1.45 GiB reserved RAM across 13 pods).
3. **Pod security hardening (`steam-proxy-k8s.service.ts`):** Because the Rust image uses `gcr.io/distroless/cc-debian12:nonroot`, pods can optionally add `securityContext: { runAsNonRoot: true, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }`.
