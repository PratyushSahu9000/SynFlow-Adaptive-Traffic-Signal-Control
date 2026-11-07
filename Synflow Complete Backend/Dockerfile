# syntax=docker/dockerfile:1
# =============================================================================
# SynFlow backend image
#   Express API + Python/PyTorch/SUMO simulation engine
#
# Build from the repository root (build context must be the repo root):
#   docker build -f "Synflow Complete Backend/Dockerfile" -t synflow-backend:local .
#
# The image contains NO secrets. MONGO_URI is injected at runtime only
# (Render Environment Variables / local -e flag).
# =============================================================================
FROM ghcr.io/eclipse-sumo/sumo:v1_27_1

ENV DEBIAN_FRONTEND=noninteractive \
    SUMO_HOME=/usr/share/sumo \
    NODE_ENV=production \
    PYTHON_CMD=/opt/venv/bin/python \
    RUNNER_PATH=/app/engine/run_matched_experiment.py \
    RESULTS_DIR=/app/Result

# -----------------------------------------------------------------------------
# Node.js 22 (base image has no Node.js)
# Installed from the official binary tarball: the base image ships
# libnode-dev, which conflicts with the NodeSource apt package.
# -----------------------------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=22.23.4

RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm -f /tmp/node.tar.xz \
    && node --version \
    && npm --version

# -----------------------------------------------------------------------------
# Isolated Python environment (base image: Python 3.10.12)
# -----------------------------------------------------------------------------
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip

COPY ["requirements.txt", "/app/requirements.txt"]

# CPU-only PyTorch first. `+cpu` guarantees no CUDA wheel is installed.
# requirements.txt pins torch==2.4.1, which accepts the installed 2.4.1+cpu,
# so the later `pip install -r` does not replace it.
RUN /opt/venv/bin/pip install --no-cache-dir \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        "torch==2.4.1+cpu" \
    && /opt/venv/bin/pip install --no-cache-dir -r /app/requirements.txt \
    && /opt/venv/bin/pip freeze > /opt/venv/requirements.lock \
    && /opt/venv/bin/python -c "import torch, sklearn, traci, numpy, pandas, joblib; print('torch', torch.__version__); print('sklearn', sklearn.__version__); print('numpy', numpy.__version__)"

# -----------------------------------------------------------------------------
# Backend (Node.js / Express) — production dependencies only
# -----------------------------------------------------------------------------
WORKDIR /app/server

COPY ["Synflow Complete Backend/server/package.json", "Synflow Complete Backend/server/package-lock.json", "/app/server/"]
RUN npm ci --omit=dev && npm cache clean --force

COPY ["Synflow Complete Backend/server/server.js", "/app/server/"]
COPY ["Synflow Complete Backend/server/models/", "/app/server/models/"]
COPY ["Synflow Complete Backend/server/routes/", "/app/server/routes/"]
COPY ["Synflow Complete Backend/server/services/", "/app/server/services/"]

# -----------------------------------------------------------------------------
# Python / SUMO engine (model artifacts + SUMO network/route assets)
# -----------------------------------------------------------------------------
COPY ["Synflow Complete Backend/engine/", "/app/engine/"]

RUN mkdir -p /app/Result

EXPOSE 10000

# Render also performs its own health check at /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
