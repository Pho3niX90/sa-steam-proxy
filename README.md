# sa-steam-proxy (Rust)

Rate-limit-aware HTTP proxy for the [Steam Web API](https://partner.steamgames.com/doc/webapi), rewritten from NestJS/Fastify to Rust (`axum` + `reqwest`/`hyper` + `moka`) for minimal memory footprint across the `/28` `hostNetwork` egress fleet.

See [`PARITY.md`](./PARITY.md) for the complete NestJS → Rust parity checklist and [`RESULTS.md`](./RESULTS.md) for side-by-side Docker benchmarks.

## Endpoints

| Path | Behaviour |
|---|---|
| `GET /healthz` | Liveness probe: always `200` + `"ok"` with `X-Proxy-Version` (+ optional `X-Git-Sha`, `X-Image-Tag`), `X-Alive: true`, `X-Requests-Per-Minute`. |
| `GET /ready` | Readiness probe: `200` + `"ok"` when ready; `503` + `"rate_limited"` or `"bad_key"` when not, with `X-Ready`, `X-Ready-Status`, `X-RateLimit-Status`, `X-Bad-Key`, `X-Requests-Per-Minute`, `X-Backoff`, `X-Retry-In`, `X-Auth-Failures`, and version headers. |
| `GET /metrics` | JSON metrics: `{ total, success, failure, lastDurationMs, build: { version, gitSha, imageTag } }` + version headers. |
| `GET /metrics/prometheus` | Prometheus text exposition format (`sa_steam_proxy_*`). |
| `GET /*` | Proxies path + query verbatim to `STEAM_API_HOST` (default `http://api.steampowered.com`) with 60s / 5,000-entry response cache, gzip decompression, rate-limit detection/backoff, and `bad_key` latching. |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LISTEN_HOST` | `0.0.0.0` | HTTP bind address |
| `LISTEN_PORT` | `8080` | HTTP listen port |
| `SOURCE_IP` | *(unset)* | Local egress IP bound on outbound HTTP sockets |
| `STEAM_API_HOST` | `http://api.steampowered.com` | Upstream Steam API base URL |
| `CACHE_TTL_MS` | `60000` | Response cache TTL in milliseconds |
| `MAX_CACHE_ENTRIES` | `5000` | Maximum cached responses |
| `PROBE_INTERVAL_SECS` | `300` | Rate-limit recovery probe interval (`/ISteamWebAPIUtil/GetServerInfo/v0001/`) |
| `CONNECT_TIMEOUT_MS` | `15000` | Upstream TCP connect timeout |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Upstream total request timeout |
| `MIDNIGHT_RESTART` | `false` | Opt-in graceful exit at 00:00 UTC (replaces Nest's midnight `process.exit()`) |
| `TOKIO_WORKER_THREADS` | `2` | Tokio runtime worker thread count (bounded for low per-pod RSS across 13 hostNetwork pods) |
| `APP_VERSION` | `Cargo.toml` version | Version reported in `X-Proxy-Version` and `/metrics` |
| `GIT_SHA` | *(unset)* | Git commit SHA reported in `X-Git-Sha` and `/metrics` |
| `IMAGE_TAG` | *(unset)* | Image tag reported in `X-Image-Tag` and `/metrics` |
| `RUST_LOG` | `info` | `tracing` log filter |

## Development

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo run --release
```
