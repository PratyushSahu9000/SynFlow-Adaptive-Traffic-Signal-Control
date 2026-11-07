# SynFlow Backend — Docker & Render Deployment

This document covers the backend only. The React frontend is deployed
separately (for example as a Render Static Site).

**No credentials belong in this repository, the Docker image, or this
document.** All secrets are injected at runtime.

---

## 1. Architecture

The backend is a single Docker image that contains:

| Layer | Component |
|-------|-----------|
| Base | `ghcr.io/eclipse-sumo/sumo:v1_27_1` (Ubuntu 22.04, Python 3.10, SUMO 1.27.1) |
| Node.js | Node.js 22 + npm (installed via NodeSource) |
| Python | `/opt/venv` virtual environment, CPU-only PyTorch, scikit-learn 1.6.1, TraCI 1.27.1 |
| API | Express (`/app/server`) |
| Engine | Python/SUMO controllers (`/app/engine`) |
| Output | `/app/Result` (ephemeral, per-experiment scratch) |

One container runs both Node.js and Python so an experiment can spawn SUMO
locally. MongoDB is external (MongoDB Atlas).

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
└── Result/          (created at build/run time)
```

---

## 2. Build locally

Run from the repository root (build context must be the repo root):

```bash
docker build -f "Synflow Complete Backend/Dockerfile" -t synflow-backend:local .
```

The Dockerfile and `.dockerignore` live at the repository root / backend
folder respectively. The frontend, notebook, datasets, and all `.env` files
are excluded from the build context.

---

## 3. Run locally

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

Never pass a real URI on a shared terminal or commit it anywhere.

---

## 4. Runtime environment variables

| Name | Required | Purpose |
|------|----------|---------|
| `MONGO_URI` | **Yes** | MongoDB Atlas connection string (secret; set privately) |
| `PORT` | Render sets it | Port to listen on (defaults to `10000`) |
| `PYTHON_CMD` | No (image default) | `/opt/venv/bin/python` |
| `RUNNER_PATH` | No (image default) | `/app/engine/run_matched_experiment.py` |
| `RESULTS_DIR` | No (image default) | `/app/Result` |
| `SUMO_HOME` | No (image default) | `/usr/share/sumo` |
| `FRONTEND_ORIGIN` | Recommended | Comma-separated allowed CORS origins |

No secret is baked into the image. `MONGO_URI` must not be used as a Docker
`ARG`/`ENV` or placed in `.env.example`.

---

## 5. Render service settings

Create a **Web Service** (Docker):

| Setting | Value |
|---------|-------|
| Service type | Web Service |
| Runtime | Docker |
| Repository | `PratyushSahu9000/SynFlow-Adaptive-Traffic-Signal-Control` (or your fork) |
| Branch | `render-deploy` (after review) |
| Root Directory | *(leave blank — repository root)* |
| Dockerfile Path | `Synflow Complete Backend/Dockerfile` |
| Docker Build Context | Repository root (default) |
| Health Check Path | `/healthz` |
| Instance Type | At least 1 GB RAM (PyTorch + pandas + SUMO); 2 GB recommended |

`EXPOSE 10000` is informational; Render routes traffic to `$PORT`
automatically.

### Environment variables on Render

Add in **Dashboard → Service → Environment**:

1. `MONGO_URI` — paste the Atlas URI privately. Do **not** commit it.
2. `FRONTEND_ORIGIN` — e.g. `https://<your-frontend>.onrender.com`.
   Multiple origins can be comma-separated.
3. `PYTHON_CMD`, `RUNNER_PATH`, `RESULTS_DIR`, `SUMO_HOME` are already set in
   the image; only override if needed.
4. `PORT` is injected by Render; do not hardcode it.

---

## 6. MongoDB Atlas network access

Render services connect from dynamic egress addresses. In MongoDB Atlas:

- Add an access-list entry for the Render egress range, **or**
- Temporarily allow `0.0.0.0/0` only if you accept the risk.

Do not commit credentials. Password rotation is managed privately in Atlas.

---

## 7. Health and readiness

| Endpoint | Behavior |
|----------|----------|
| `GET /healthz` | `{ "status": "ok", "service": "synflow-backend" }` — process liveness only |
| `GET /readyz` | `200 { "status": "ready" }` when MongoDB is connected, `503` otherwise |

Neither endpoint exposes configuration, URIs, or stack traces.

---

## 8. Python / SUMO dependency details

Pinned in `requirements.txt`:

- `numpy==1.26.4`, `pandas==2.2.2`, `scipy==1.13.1`
- `joblib==1.4.2`, `scikit-learn==1.6.1` (must match `preprocessor.joblib`)
- `traci==1.27.1` (matches SUMO 1.27.1)
- `torch==2.4.1` (installed as `2.4.1+cpu` from the official PyTorch CPU index)

The Dockerfile installs CPU PyTorch **first**; the later `pip install -r`
does not replace it with a CUDA build.

---

## 9. Required SUMO assets

The simulation needs these files (tracked in Git, copied into the image):

```
Synflow Complete Backend/engine/SUMO/nets/intersection.net.xml
Synflow Complete Backend/engine/SUMO/nets/intersection_period_2_0.rou.xml
Synflow Complete Backend/engine/SUMO/nets/intersection.sumocfg
Synflow Complete Backend/engine/SUMO/vehicle_types.add.xml
```

`intersection.sumocfg` resolves the network and route files relative to its
own directory and `../vehicle_types.add.xml` relative to the config folder.

---

## 10. Experiment output and concurrency

- Each experiment writes to `RESULTS_DIR/<experiment-id>/`.
- Only **one** experiment runs at a time; additional requests receive `409`.
- `POST /api/experiments` is rate-limited to 3 requests/minute per IP.
- After results are stored in MongoDB, the scratch directory is deleted.
- A 20-minute watchdog kills a stuck simulation.

These are safeguards, not authentication.

---

## 11. Frontend API URL

The frontend uses `VITE_API_URL` (see `src/api.js`). Vite variables are
**public** and embedded in the browser bundle.

- Set `VITE_API_URL=https://<backend>.onrender.com/api` at frontend build time.
- Never place MongoDB credentials or backend secrets in `VITE_*` variables.
- Set `FRONTEND_ORIGIN` on the backend to the frontend's public origin.

---

## 12. Known limitations

- **No authentication/authorization.** The API is public; anyone can start
  experiments within the rate limit. Do not treat it as production-secure.
- **Single instance only.** The experiment lock is in-process; running
  multiple Render instances would allow concurrent simulations. Keep the
  service at one instance unless you add a distributed lock.
- **Ephemeral disk.** Results are persisted in MongoDB; files under
  `/app/Result` are temporary.
- **Compute-heavy.** A run spawns three SUMO controllers plus PyTorch; use a
  paid instance with sufficient CPU/RAM.
- **`data_generation/` is not included in the image.** It is a training-data
  utility and still contains a machine-specific `SUMO_HOME` path.
- **Legacy remote files.** `server/Readme` and `server/.env_example.example`
  are preserved from earlier commits and still mention the old runner name;
  they are documentation only.

---

## 13. Security checklist

- [x] `MONGO_URI` read only from `process.env`
- [x] No URI or token in Dockerfile / image / git
- [x] `.env` ignored by Git and excluded from the Docker context
- [x] Error responses sanitized (no stack traces / URIs)
- [x] Connection errors redacted before logging
- [x] Health endpoints expose no configuration
- [ ] Authentication — **not implemented** (see limitations)
