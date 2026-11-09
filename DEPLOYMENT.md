# SynFlow — Public Docker & Render Deployment

This document covers the backend container and the public frontend. SynFlow is
intentionally **public**: visitors need no account, login, cookie, token, or API
key. Abuse protection is provided by per-IP limits, a persistent global daily
quota, a single-experiment lock, SSE connection caps, and process timeouts.

**No credentials belong in this repository, the Docker image, or this
document.** `MONGO_URI` is injected privately at runtime.

---

## 1. Architecture

The backend is a single Docker image that contains:

| Layer | Component |
|-------|-----------|
| Base | `ghcr.io/eclipse-sumo/sumo:v1_27_1` (Ubuntu 22.04, Python 3.10, SUMO 1.27.1) |
| Node.js | Node.js 22 + npm (installed from the official binary tarball) |
| Python | `/opt/venv`, CPU-only PyTorch 2.4.1, scikit-learn 1.6.1, TraCI 1.27.1 |
| API | Express (`/app/server`) |
| Engine | Python/SUMO controllers (`/app/engine`) |
| Output | `/app/Result` (ephemeral, per-experiment scratch) |

One container runs both Node.js and Python so an experiment can spawn SUMO
locally. MongoDB is external (MongoDB Atlas) and stores experiments plus the
persistent daily quota.

```
/app
├── engine/
│   ├── Model/
│   ├── SUMO/
│   └── run_matched_experiment.py
├── server/
│   ├── models/ routes/ services/
│   ├── server.js
│   └── package.json
└── Result/          (created at run time, cleaned after each experiment)
```

---

## 2. Public access rules

No authentication exists anywhere in the application.

| Item | Value |
|------|-------|
| Login / registration / accounts | None |
| API keys / JWTs / auth cookies / sessions | None |
| Dashboard and all controller pages | Public |
| Existing experiment results and comparisons | Public |
| Starting a new experiment | Public, subject to the limits below |

Protection is resource-oriented, not identity-oriented:

| Limit | Default |
|-------|---------|
| General API reads | 120 requests per IP per 15 minutes |
| Experiment cooldown | 1 start per IP per 2 minutes |
| Experiment hourly | 5 starts per IP per hour |
| Experiment daily | 10 starts per IP per 24 hours |
| Global experiment starts | 25 per UTC day (all visitors, persistent) |
| Simultaneous experiments | 1 (no waiting queue) |
| SSE streams per IP | 2 |
| Total SSE streams | 50 |
| Experiment timeout | 20 minutes |

`/healthz` and `/readyz` are never rate-limited. Long-lived SSE streams are not
counted by the general API limiter; they have their own connection caps.

CORS restricts which browser origins may read responses. It is **not**
authentication and does not stop non-browser clients; the server-side rate
limits and quota are the actual abuse protection.

### HTTP responses

| Situation | Status | Body highlights |
|-----------|--------|-----------------|
| Per-IP cooldown/hourly/daily exceeded | `429` | `error`, `retryAfterSeconds`, `Retry-After` header |
| Global daily capacity reached | `429` | `error`, `limit`, dynamic `resetAt` (next UTC midnight) |
| Another experiment is running | `409` | friendly `error`; no Python process, no quota use |
| MongoDB unavailable | `503` | sanitized `error`; experiments fail closed |
| Unexpected start field, e.g. `{"seed":1}` | `400` | `error`; nothing is spawned |

The frontend never retries `409`, `429`, or `503` automatically.

---

## 3. Global daily quota semantics

- One MongoDB document per UTC day in the `experiment_usage` collection:
  `{ _id: "YYYY-MM-DD", count: Number, createdAt: Date }`.
- A start is reserved with one conditional atomic update:
  `findOneAndUpdate({ _id: day, count: { $lt: limit } }, { $inc: { count: 1 } }, { upsert: true })`.
- Concurrent requests cannot overshoot the limit. A duplicate-key race on the
  first request of the day is retried once without `upsert`.
- The quota survives backend restarts and is shared by every visitor and IP.
- If MongoDB is unreachable, reservation fails and the request receives `503`.
  The quota is never bypassed.
- Reservations are taken **after** request validation, the concurrency slot,
  and the per-IP checks. A `409` or per-IP `429` never consumes quota.
- If the Python process cannot be spawned at all, the reservation is rolled
  back. Once a process has actually started, the start is counted even if the
  simulation later fails or times out.

---

## 4. Runtime environment variables

Only `MONGO_URI` is secret. All limits are configurable and non-secret.

```dotenv
# Required (private)
MONGO_URI=<private MongoDB Atlas URI>

# Public origin(s) allowed to call the API from a browser
FRONTEND_ORIGIN=https://YOUR-FRONTEND.onrender.com

# General API reads
API_RATE_LIMIT_WINDOW_MS=900000
API_RATE_LIMIT_MAX=120

# Experiment starts per IP
EXPERIMENT_IP_WINDOW_MS=120000
EXPERIMENT_IP_MAX=1

EXPERIMENT_IP_HOURLY_WINDOW_MS=3600000
EXPERIMENT_IP_HOURLY_MAX=5

EXPERIMENT_IP_DAILY_WINDOW_MS=86400000
EXPERIMENT_IP_DAILY_MAX=10

# Global persistent quota and compute protection
GLOBAL_DAILY_EXPERIMENT_LIMIT=25
MAX_CONCURRENT_EXPERIMENTS=1
EXPERIMENT_TIMEOUT_MS=1200000

# SSE connection caps (heartbeat remains 15 s)
SSE_MAX_PER_IP=2
SSE_MAX_TOTAL=50
SSE_HEARTBEAT_MS=15000

# Trust exactly one reverse-proxy hop (Render). Use a number, never `true`.
TRUST_PROXY_HOPS=1
```

Image defaults already set:

```dotenv
PORT=10000            # Render injects its own PORT
PYTHON_CMD=/opt/venv/bin/python
RUNNER_PATH=/app/engine/run_matched_experiment.py
RESULTS_DIR=/app/Result
SUMO_HOME=/usr/share/sumo
```

Changing quotas: edit the variables in Render and redeploy/restart. Per-IP
counters are in memory and reset on restart. The global daily counter is in
MongoDB and does not reset. Setting a limit to `0` disables that action
(useful for emergency lock-down).

---

## 5. Build locally

Run from the repository root (build context must be the repo root):

```bash
docker build -f "Synflow Complete Backend/Dockerfile" -t synflow-backend:local .
```

The frontend, notebook, datasets, test files, and all `.env` files are excluded
from the image context by `.dockerignore`. There are no Docker `ARG`s or `ENV`s
containing credentials.

---

## 6. Run locally

```bash
docker run --rm -p 10000:10000 \
  -e PORT=10000 \
  -e MONGO_URI="<your-local-or-atlas-uri>" \
  -e FRONTEND_ORIGIN="http://localhost:5173" \
  synflow-backend:local
```

Then:

- Liveness: `GET http://localhost:10000/healthz`
- Readiness (MongoDB): `GET http://localhost:10000/readyz`
- API base: `http://localhost:10000/api/experiments`

Never paste a real URI into a shared terminal, commit, or screenshot.

---

## 7. Render backend service settings

Create a **Web Service** (Docker):

| Setting | Value |
|---------|-------|
| Service type | Web Service |
| Runtime | Docker |
| Repository | Your SynFlow fork |
| Branch | `render-deploy` (after you review and push it) |
| Root Directory | Repository root (leave blank) |
| Dockerfile Path | `Synflow Complete Backend/Dockerfile` |
| Docker Build Context | Repository root |
| Health Check Path | `/healthz` |
| Instance Count | **1** |
| Instance Type | At least 2 GB RAM recommended (PyTorch + SUMO) |

`EXPOSE 10000` is informational; Render routes to `$PORT` automatically.

### Environment variables on Render

1. `MONGO_URI` — add privately as an environment variable. Never commit it.
2. `FRONTEND_ORIGIN` — the deployed frontend origin, e.g.
   `https://your-frontend.onrender.com`. Multiple origins can be comma-separated.
3. Add the rate-limit variables above if you want values other than the
   documented defaults.
4. `PORT` is injected by Render; do not hardcode it.

---

## 8. MongoDB Atlas networking

Render services connect from dynamic egress addresses. In MongoDB Atlas:

- Prefer a dedicated database user with access only to this database.
- Add the Render egress range to the Atlas access list, **or**
- Temporarily allow `0.0.0.0/0` only if you accept the risk.
- Keep the URI out of Git, Docker build args, logs, and the frontend.

---

## 9. Frontend deployment

The React app is deployed separately, for example as a Render Static Site.

Build-time configuration (public, embedded in the browser bundle):

```text
VITE_API_URL=https://YOUR-BACKEND.onrender.com/api
```

Then set the backend `FRONTEND_ORIGIN` to the frontend's exact public origin.
Vite variables are public: never place backend secrets in `VITE_*` values.

Every page — Home, Fixed Traffic, Neural Network, Neuro-Symbolic AI, Compare —
opens without authentication. Only starting a **new** experiment is limited by
the quotas. Existing experiments and comparisons remain accessible after the
daily capacity is exhausted.

---

## 10. Health and readiness

| Endpoint | Behavior |
|----------|----------|
| `GET /healthz` | `{ "status": "ok", "service": "synflow-backend" }` — process liveness only |
| `GET /readyz` | `200 { "status": "ready" }` when MongoDB is connected, `503` otherwise |

Neither endpoint exposes configuration, URIs, or stack traces, and neither is
rate-limited.

---

## 11. Experiment execution safeguards

- Fixed, Neural Network, and Neuro-Symbolic controllers run with the **same
  seed** and the same matched SUMO traffic. This methodology is unchanged.
- The Python executable, script path, SUMO config, output directory, run count,
  and seed are fixed server-side. Clients may not supply any of them.
- `POST /api/experiments` accepts only an empty JSON object; unknown fields are
  rejected.
- The child process receives a cleaned environment with `MONGO_URI` removed.
- On timeout, the whole process group is killed (Python and every SUMO child).
  On Windows, `taskkill /T /F` is used.
- Results are persisted to MongoDB **before** the per-experiment scratch
  directory is removed.
- A client disconnecting from SSE does not cancel a running experiment.
- There is no waiting queue. A second concurrent request gets `409`.

---

## 12. Known limitations

- **Single instance only.** The concurrency lock, per-IP counters, and SSE
  registry are in-process. Running multiple Render instances would allow more
  than one simulation and separate per-IP windows. Adding instances requires a
  distributed lock/lease (for example in MongoDB).
- **In-memory per-IP limits reset on restart.** The MongoDB global daily quota
  does not reset and remains authoritative.
- **Ephemeral disk.** Results live in MongoDB; files under `/app/Result` are
  temporary.
- **Compute-heavy.** A run spawns three SUMO controllers plus PyTorch; use a
  paid instance with sufficient CPU/RAM.
- **No authentication by design.** The API and completed results are public.
- **`data_generation/` is not in the image.** It is a training-data utility
  with a machine-specific `SUMO_HOME`.
- **Legacy remote files.** `server/Readme` and `server/.env_example.example`
  are documentation-only historical files.

---

## 13. Tests

From `Synflow Complete Backend/server`:

```bash
npm ci
npm test
npm audit
```

The unit suite covers layered per-IP windows, atomic quota logic, route
rejection ordering, concurrency slots, spawn failure rollback, timeout process
kills, SSE caps, validation, and privacy hashing.

Real MongoDB quota tests (disposable database):

```bash
TEST_MONGO_URI=mongodb://127.0.0.1:27017/synflow_quota_test npm test
```

From `SynFlow Complete Frontend`:

```bash
npm test
npm run build
```

---

## 14. Security checklist

- [x] Public app with no login, registration, JWT, cookie, session, or API key
- [x] `MONGO_URI` read only from `process.env`
- [x] No URI or token in Dockerfile / image / Git / frontend bundle
- [x] `.env` ignored by Git and excluded from the Docker context
- [x] Error responses sanitized (no stack traces, URIs, paths, or stderr)
- [x] Connection errors redacted before logging
- [x] Health endpoints expose no configuration
- [x] Helmet security headers enabled; explicit CORS allowlist
- [x] Request body limit kept at 32 KB
- [x] Client-controlled execution fields rejected
- [x] Atomic persistent global daily quota (fails closed)
- [x] One active simulation, no queue, process-tree timeout cleanup
- [x] SSE connection caps and unbounded-buffer protection
