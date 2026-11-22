# sa-steam-proxy: old (NestJS/Fastify) vs new (Rust) — measured

## Setup (identical for both)

- **Machine:** Windows 11 workstation, Docker Desktop (WSL2 Linux VM, 24 vCPU). Both containers ran on the same isolated Docker bridge network (`sa-steam-proxy-bench`), one service at a time.
- **Old (NestJS/Fastify):** `sa-steam-proxy:nest-bench` built directly from `origin/master` (`524f0df`, `node:22-alpine`, NestJS 11 + Fastify + undici, `APP_VERSION=0.0.4`).
- **New (Rust):** `sa-steam-proxy:rust-bench` built from `feat/rust-rewrite` (`Dockerfile`, `gcr.io/distroless/cc-debian12:nonroot`, `axum` + `reqwest`/`hyper` + `moka`, `APP_VERSION=0.1.0`, `TOKIO_WORKER_THREADS=2`, `MALLOC_ARENA_MAX=2`).
- **Mock Steam upstream:** `bench/mock-steam.mjs` listening on port `80` in its own container, pinned into both proxy containers via `--add-host api.steampowered.com:<mock-ip>` so neither proxy escapes to the live Steam Web API. Serves a pre-compressed ~1.1 KiB gzipped `GetPlayerSummaries` JSON payload plus failure-mode test routes.
- **Load generator:** `bench/loadgen.mjs` running in a container on the same Docker network (`32` concurrent keep-alive workers, `20 s` per load scenario):
  - **`parity`:** 12 live HTTP checks verifying `/healthz`, `/ready`, `/metrics`, gzip JSON forwarding, plain text forwarding, corrupt gzip → `502 decompression_failed`, 3× key-blame `403` → `/ready` `503 bad_key` → recovery on `200`, and bare `403` → `429 rate_limited` → `/ready` `503 rate_limited`.
  - **`idle`:** `10 s` steady-state idle after container startup and `/ready = 200`.
  - **`cache-hit`:** 50 warmed URLs hammered at 32 concurrency (99.9%+ cache hit rate).
  - **`cache-miss`:** unique `?steamids=miss_<seq>` URLs hammered at 32 concurrency, forcing gzip decompression, JSON validation, and full 5,000-entry cache fill + eviction.
- **Sampling:** `bench/sample.mjs` attached to each proxy's PID namespace (`--pid=container:<name>`) reading Linux `/proc/1/status` (`VmRSS`, `VmHWM` peak, `Threads`) and `/proc/1/stat` (`utime + stime`) every `500 ms`. CPU % = CPU-seconds / wall-seconds × 100 (`100 %` = one core).

---

## Results

### Image Size & Container Parity

| Metric | NestJS (`0.0.4`) | Rust (`0.1.0`) | Delta |
|---|---:|---:|---|
| Docker image size | `299 MB` | **`45.7 MB`** | **6.5× smaller** (`-84.7 %`) |
| Runtime base | `node:22-alpine` (shell + npm/node + 17 runtime CVEs) | `gcr.io/distroless/cc-debian12:nonroot` | Zero shell / zero OS packages |
| Live container parity suite | `12 / 12` passed | **`12 / 12` passed** | Exact parity |

### Runtime Resource & Latency Comparison

| Scenario | Impl | RSS avg | RSS peak | CPU avg | Threads | Throughput | p50 | p95 | p99 | Errors |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Idle** (10 s) | NestJS | 98.23 MiB | 98.94 MiB | 0.10 % | 7 | — | — | — | — | — |
| | **Rust** | **5.06 MiB** | **5.06 MiB** | **0.00 %** | **3** | — | — | — | — | — |
| **Cache-hit** (32 conc, 20 s) | NestJS | 140.19 MiB | 172.69 MiB | 102.25 % | 11 | 1,640.9 req/s | 19.73 ms | 35.24 ms | 57.15 ms | 0 |
| | **Rust** | **7.55 MiB** | **7.96 MiB** | **24.99 %** | **4** | **3,495.0 req/s** | **8.03 ms** | **16.50 ms** | **24.56 ms** | **0** |
| **Cache-miss + Gzip + 5k cache fill** (32 conc, 20 s) | NestJS | 148.75 MiB | 181.84 MiB | 105.17 % | 11 | 1,320.6 req/s | 21.04 ms | 46.89 ms | 59.14 ms | 0 |
| | **Rust** | **16.04 MiB** | **18.19 MiB** | **102.32 %** | **11** | **6,684.9 req/s** | **3.81 ms** | **8.80 ms** | **15.71 ms** | **0** |

### Key Takeaways

- **Idle memory:** **5.06 MiB** vs **98.23 MiB** (**19.4× reduction**; 3 threads vs 7).
- **Under heavy cache-hit load:** **7.96 MiB peak** vs **172.69 MiB peak** (**21.7× reduction**), **2.1× higher throughput**, **2.3× lower p99 latency**, and **4.1× lower CPU**.
- **Under full 5,000-entry cache saturation + gzip decompression (`133,705` unique responses in 20 s):** **18.19 MiB peak** vs **181.84 MiB peak** (**10.0× reduction**), **5.1× higher throughput**, and **3.8× lower p99 latency**. Production's Steam ceiling is ~68 RPM (**1.13 req/s**) per pod — Rust delivers **>3,000×** headroom while keeping RSS near ~5–8 MiB in steady-state production traffic.
- **Thread & allocator tuning:** Setting `TOKIO_WORKER_THREADS=2` (default, overridable via env) and `MALLOC_ARENA_MAX=2` reduced Rust idle threads from 25 → 3 (avoiding ~286 idle threads across 13 pods on `falk-ax41-01`) and cut cache-miss peak RSS from 23.05 MiB → 18.19 MiB.

---

## 13-Pod Fleet Impact & Recommended Kubernetes Sizing

Production runs **13 `hostNetwork` pods** in namespace `steam-proxies` on `falk-ax41-01` (currently ~551 MiB live RAM, 1,664 MiB reserved).

| Metric (13 pods total) | Current (NestJS) | Projected (Rust) | Savings |
|---|---:|---:|---:|
| Live RSS (steady-state production) | ~551 MiB | **~66–80 MiB** (~5–6 MiB/pod) | **~470–485 MiB (-87 %)** |
| Reserved RAM (`requests.memory`) | 1,664 MiB (`128Mi` × 13) | **208 MiB** (`16Mi` × 13) | **1,456 MiB (~1.42 GiB, -87.5 %)** |
| Max RAM limit (`limits.memory`) | 6,656 MiB (`512Mi` × 13) | **832 MiB** (`64Mi` × 13) | **5,824 MiB (-87.5 %)** |
| Reserved CPU (`requests.cpu`) | 650m (`50m` × 13) | **130m** (`10m` × 13) | **520m (-80 %)** |

### Recommended Manifest Updates (for `backend` repo after owner approval)

In `backend/apps/api/src/endpoints/site-admin/steam-proxy-k8s.service.ts` and `backend/manifests/steam-proxies/pod-example.yaml`:

```yaml
resources:
  requests:
    cpu: 10m
    memory: 16Mi
  limits:
    cpu: 250m
    memory: 64Mi
securityContext:
  runAsNonRoot: true
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
```

*(64 MiB limit provides **>3.5× headroom** above the 18.19 MiB worst-case 5,000-entry cache-saturation peak.)*

---

## Reproduce

```powershell
# Build old (NestJS) and new (Rust) images
docker build -t sa-steam-proxy:nest-bench --build-arg APP_VERSION=0.0.4 --build-arg GIT_SHA=524f0df "E:\Projects\Server Armour\sa-steam-proxy"
docker build -t sa-steam-proxy:rust-bench --build-arg APP_VERSION=0.1.0 --build-arg GIT_SHA=feat-rs "E:\Projects\Server Armour\sa-steam-proxy-rust"

# Run full side-by-side benchmark (writes raw JSON results to E:\tmp\sa-steam-proxy-rust\bench)
powershell -ExecutionPolicy Bypass -File "E:\Projects\Server Armour\sa-steam-proxy-rust\bench\run.ps1" -OutDir "E:\tmp\sa-steam-proxy-rust\bench"
```

---

## Safe Rollout Plan (gated on owner approval)

1. **Merge & publish:** Push `feat/rust-rewrite`, open PR, merge to `master`; GitHub Actions runs `cargo fmt --check`, `cargo clippy`, `cargo test --locked`, and pushes `ghcr.io/pho3nix90/sa-steam-proxy:0.1.0` and `:latest`.
2. **Canary 1 pod:** Recreate a single proxy pod via site-admin (`POST .../instances/:id/recreate`), confirm `X-Proxy-Version: 0.1.0` in site-admin overview, `/ready` = `200 ok`, `kubectl -n steam-proxies top pod`, and normal SteamLib traffic + `SOURCE_IP` egress.
3. **Roll remaining 12 pods:** Trigger **Roll fleet** (`POST .../roll`) in site-admin; monitor `health-service` availability and `kubectl -n steam-proxies top pods`.
4. **Update K8s sizing in `backend`:** Apply the `16Mi` / `64Mi` resource request/limit update in `steam-proxy-k8s.service.ts` and `pod-example.yaml` in a follow-up PR on `backend`, then roll once more to release ~1.42 GiB reserved RAM.
5. **Instant rollback:** Retag/set `STEAM_PROXY_IMAGE=ghcr.io/pho3nix90/sa-steam-proxy:0.0.4` and trigger **Roll fleet**.
