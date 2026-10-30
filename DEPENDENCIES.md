# SynFlow — Project Dependencies

This document lists all dependencies across the full SynFlow project stack.

---

## 1. Python Engine (SUMO / TraCI controllers)

**File:** `requirements.txt` (project root)

| Package | Version | Purpose |
|---------|---------|---------|
| `numpy` | latest | Numerical computing for traffic state features |
| `pandas` | latest | DataFrame handling for ML input preprocessing |
| `torch` | CPU build | PyTorch neural network inference (`final_model.pt`) |
| `joblib` | latest | Loading `preprocessor.joblib` (sklearn ColumnTransformer) |
| `scikit-learn` | `==1.6.1` | Preprocessor was created with this version — must match |
| `traci` | latest | SUMO TraCI Python binding for simulation control |

**Install:**
```powershell
pip install -r requirements.txt
```

**Note:** `scikit-learn==1.6.1` is pinned because `preprocessor.joblib` was created with that exact version. A newer sklearn may fail to unpickle it.

---

## 2. SUMO (Traffic Simulator)

SUMO is **not** a pip-installable Python package. It is a standalone system binary.

### Windows
- Download from: https://sumo.dlr.de/
- Set environment variable: `SUMO_HOME` → path to SUMO installation (e.g. `E:\SUMO\`)

### Linux / Docker
- Install via apt: `apt-get install sumo sumo-tools`
- Already handled in `Dockerfile`

---

## 3. Backend (Node.js / Express)

**File:** `Synflow Complete Backend\server\package.json`

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | `^4.19.2` | Web framework / REST API |
| `mongoose` | `^8.5.0` | MongoDB ODM |
| `cors` | `^2.8.5` | Cross-origin resource sharing |
| `dotenv` | `^16.4.5` | Load environment variables from `.env` |

**Install:**
```powershell
cd "Synflow Complete Backend\server"
npm install
```

**Start:**
```powershell
npm start
```
Runs on port `5000` (configurable via `PORT` env var).

---

## 4. Frontend (React + Vite)

**File:** `SynFlow Complete Frontend\package.json`

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | `^18.3.1` | UI library |
| `react-dom` | `^18.3.1` | React DOM renderer |
| `react-router-dom` | `^6.26.0` | Client-side routing |
| `recharts` | `^2.12.7` | Charting for comparison data |

**Dev dependencies:**
| Package | Version | Purpose |
|---------|---------|---------|
| `vite` | `^5.4.0` | Build tool / dev server |
| `@vitejs/plugin-react` | `^4.3.1` | Vite React plugin |

**Install:**
```powershell
cd "SynFlow Complete Frontend"
npm install
```

**Scripts:**
- `npm run dev` — Start dev server on port `5173`
- `npm run build` — Build production static files to `dist/`
- `npm run preview` — Preview production build

---

## 5. External Services

| Service | Purpose | Configuration |
|---------|---------|---------------|
| MongoDB | Experiment result storage | `MONGO_URI` env var (set in `.env` or at runtime) |

---

## 6. Quick Setup (All Components)

```powershell
# 1. Python engine
pip install -r requirements.txt

# 2. Backend
cd "Synflow Complete Backend\server"
npm install

# 3. Frontend
cd "SynFlow Complete Frontend"
npm install

# 4. SUMO
# Windows: download from sumo.dlr.de and set SUMO_HOME
# Linux: apt-get install sumo sumo-tools
```

---

## 7. Docker

- `Dockerfile` — All-in-one image: Node.js backend + Python engine + SUMO + built frontend
- `Dockerfile.frontend` — Frontend-only image (Vite build + nginx)
- `docker-compose.yml` — Orchestrates backend + frontend + MongoDB

**Note:** `MONGO_URI` must be provided at runtime (never committed). The `.env` file with real credentials is excluded from both git and Docker via `.gitignore` and `.dockerignore`.
