# Steam API Proxy Service

A **high-performance**, **rate-limit-aware** proxy service for the [Steam Web API](https://partner.steamgames.com/doc/webapi), built using **NestJS** and **Fastify**, powered by **undici**.

---

## 🚀 Features

- ⚡ **Efficient Proxying** – Forwards requests with minimal overhead
- 🧠 **Caching** – 10-second in-memory cache to reduce Steam load
- 🛡️ **Rate Limit Protection** – Detects Steam throttling (429, unofficial 420, 503, bare 403, Retry-After, rate-limit body text — Steam often skips 429)
- 🔁 **Adaptive Backoff** – Exponential delay between retries after rate-limiting
- ❤️ **Health Monitoring** – `/healthz` (liveness), `/ready` (rate limit / bad key), `/metrics`
- 🧵 **High Performance** – Uses Fastify and `undici.Pool` for ultra-low latency
- ♻️ **Automatic Recovery** – Periodically probes Steam to detect rate-limit lift
- 🕛 **Scheduled Restart** – Optional daily restart at midnight to ensure stability

---

## 📦 Installation

```bash
npm install
```

---

## ▶️ Running the Application

```bash
# Development mode
npm run start

# Watch mode (auto-reload on changes)
npm run start:dev

# Production mode
npm run start:prod
```

The service listens on **port 8080** by default.

---

## 🌐 API Endpoints

### 🔄 Steam Proxy

All unmatched paths are forwarded directly to the Steam API:

```
GET /*  →  http://api.steampowered.com/*
```

#### Example:
```
GET /ISteamUser/GetPlayerSummaries/v0002/?key=YOURKEY&steamids=76561197960435530
```

---

### Liveness — `/healthz`

Process is up. Always `200` + `ok` when the HTTP server answers.

Headers include `X-Proxy-Version` (and optional `X-Git-Sha` / `X-Image-Tag`).

Use for Kubernetes **livenessProbe**.

### Readiness — `/ready`

Real ability to serve Steam traffic:

| HTTP | Body | Meaning |
|------|------|---------|
| 200 | `ok` | Ready |
| 503 | `rate_limited` | Throttled / backing off (429, 420, 503, bare 403, Retry-After) |
| 503 | `bad_key` | Steam rejecting the key (401 / explicit invalid-key 403); clears on keyed success |

Headers include `X-Ready`, `X-Ready-Status`, `X-RateLimit-Status`, `X-Bad-Key`, `X-Requests-Per-Minute`, `X-Backoff`, `X-Retry-In`, `X-Proxy-Version`, optional `X-Git-Sha` / `X-Image-Tag`.

Use for Kubernetes **readinessProbe** and health-service checks.

### 📊 Metrics

```
GET /metrics
```

Returns JSON with:

```json
{
  "total": 543,
  "success": 521,
  "failure": 22,
  "lastDurationMs": 118,
  "build": {
    "version": "0.0.4",
    "gitSha": "abc123",
    "imageTag": "ghcr.io/pho3nix90/sa-steam-proxy:latest"
  }
}
```

Version also available via `X-Proxy-Version` on `/healthz` and `/ready`.

---

## ⚙️ Configuration

Constants in `steam-proxy.service.ts`:

| Name             | Description                           | Default                         |
|------------------|---------------------------------------|---------------------------------|
| `STEAM_API_HOST` | Steam API base URL                    | `'http://api.steampowered.com'` |
| `CACHE_TTL_MS`   | Response cache time-to-live (in ms)   | `60000`                         |
| `ONE_MINUTE`     | Time window for rate tracking (in ms) | `60000`                         |

Env for build identity (set in Docker / k8s):

| Name | Description |
|------|-------------|
| `APP_VERSION` | Semver override (defaults to `package.json`) |
| `GIT_SHA` | Commit hash |
| `IMAGE_TAG` | Image ref used to launch the pod |

---

## 📝 License

This project is [MIT licensed](LICENSE).

---

## 📌 Tips

- Use a reverse proxy like **Nginx** or **Cloudflare Tunnel** for TLS and access control.
- Deploy behind a **Kubernetes HPA** or **PM2 cluster mode** if under high traffic.
- Monitor rate-limiting via `/healthz` or logs tagged with `[RateLimit]`.
