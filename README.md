# SynFlow — Adaptive Traffic Signal Control with Neuro-Symbolic AI

<p align="center">
  <strong>Learning traffic priorities. Enforcing explicit rules. Evaluating every decision in simulation.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/PyTorch-MLP-EE4C2C?logo=pytorch&logoColor=white" alt="PyTorch">
  <img src="https://img.shields.io/badge/SUMO-TraCI-43A047" alt="SUMO and TraCI">
  <img src="https://img.shields.io/badge/React-Vite-61DAFB?logo=react&logoColor=black" alt="React and Vite">
  <img src="https://img.shields.io/badge/Node.js-Express-339933?logo=nodedotjs&logoColor=white" alt="Node.js and Express">
  <img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/status-research%20prototype-orange" alt="Research prototype">
</p>

---

## Overview

**SynFlow** is a simulation-based adaptive traffic signal control project that investigates a hybrid **Neuro-Symbolic AI** approach to intersection management.

Conventional fixed-time signals allocate green time according to a predefined schedule. They do not directly respond to changing queue lengths, waiting times, or uneven traffic demand. A purely learned controller can adapt its decisions to observed traffic, but it may not naturally enforce operational rules such as minimum green time, maximum waiting time, or emergency-vehicle priority.

SynFlow compares three controllers under matched SUMO traffic scenarios:

1. **Fixed-time:** a deterministic baseline with predefined green and yellow durations.
2. **Neural Network (NN):** a Multi-Layer Perceptron (MLP) predicts approach-level priorities and drives adaptive signal decisions.
3. **Neuro-Symbolic (NeSy):** the same MLP recommendation is evaluated by an explicit rule engine that can accept or override it.

All three controllers are evaluated using the same SUMO random seed for a given experiment. This matched setup helps make controller comparisons more meaningful by holding the generated traffic realization constant.

> **Project status:** SynFlow is a research and engineering prototype evaluated in simulation. It is not certified or validated for deployment on public-road traffic infrastructure.

## What SynFlow includes

- A four-approach intersection model controlled through SUMO and TraCI.
- A data-generation pipeline for traffic-state observations and supervised priority targets.
- A PyTorch MLP that predicts four approach priority scores.
- Three independently implemented traffic signal controllers: Fixed, NN, and NeSy.
- A matched-experiment runner that uses a shared SUMO seed across the three controllers.
- A Node.js/Express API that launches experiments, stores their results in MongoDB, and exposes progress events.
- A React/Vite dashboard for controller-level inspection and side-by-side comparison.

## Results at a glance

### MLP test-set results

The checked-in training notebook reports evaluation on **22,349 held-out samples from 30 held-out scenarios**. The model predicts a priority score for each of the four approaches.

| Approach | MAE | RMSE | R² |
|---|---:|---:|---:|
| North | 0.006555 | 0.010329 | 0.997141 |
| South | 0.007485 | 0.012239 | 0.995089 |
| East | 0.006722 | 0.010452 | 0.997138 |
| West | 0.007378 | 0.011354 | 0.996332 |

**Top-1 priority accuracy: 95.89%.**

Top-1 priority accuracy measures how often the approach with the highest predicted score matches the approach with the highest engineered target score. MAE, RMSE, and R² measure regression against those same generated targets.

These are **ML target-prediction metrics**, not evidence of a 95.89% reduction in traffic delay or an equivalent real-world traffic improvement. Traffic-control performance must be assessed separately using matched simulation metrics.

### Training data and model

| Item | Value |
|---|---:|
| Scenarios represented in the notebook | 300 |
| Total observations | 223,160 |
| Training scenarios | 240 |
| Validation scenarios | 30 |
| Test scenarios | 30 |
| Training input after preprocessing | 42 dimensions |
| Model outputs | 4 priority scores |
| Optuna search trials | 25 |

The scenario-level split keeps observations from a scenario within one partition instead of randomly distributing rows from the same scenario across training, validation, and test sets.

## How the system works

### High-level architecture

~~~mermaid
flowchart TB
    subgraph UI["Presentation layer"]
        FE["React + Vite dashboard"]
    end

    subgraph API["Application layer"]
        BE["Node.js + Express API"]
        DB[("MongoDB experiment store")]
        SSE["Server-Sent Events"]
    end

    subgraph ENGINE["Simulation and control layer"]
        RUN["Matched experiment runner"]
        SEED["Generate one SUMO seed"]
        FIX["Fixed-time controller"]
        NN["MLP controller"]
        NESY["Neuro-Symbolic controller"]
        SUMO1["SUMO + TraCI"]
        SUMO2["SUMO + TraCI"]
        SUMO3["SUMO + TraCI"]
        JSON["fixed.json · nn.json · nesy.json"]
    end

    FE -->|"REST requests"| BE
    FE <-->|"live progress"| SSE
    BE <--> DB
    BE --> RUN
    RUN --> SEED
    SEED --> FIX
    SEED --> NN
    SEED --> NESY
    FIX --> SUMO1
    NN --> SUMO2
    NESY --> SUMO3
    SUMO1 --> JSON
    SUMO2 --> JSON
    SUMO3 --> JSON
    JSON --> BE
    BE --> SSE
~~~

A new dashboard experiment is created through the API. The backend launches the Python matched-experiment runner, which generates a seed and starts the Fixed, NN, and NeSy controllers with that same seed. Each controller runs its own SUMO process and writes a JSON result. The backend reads the three results, stores them in MongoDB, and makes the completed experiment available to the dashboard.

### Neural inference pipeline

~~~mermaid
flowchart LR
    A["SUMO traffic state"] --> B["Feature extraction"]
    B --> C["Saved sklearn preprocessor"]
    C --> D["42-dimensional tensor"]
    D --> E["PyTorch MLP"]
    E --> F["North / South / East / West scores"]
    F --> G["Controller decision"]
    G --> H["TraCI signal update"]
~~~

The controller samples traffic state every **5 simulation seconds**. The model's saved preprocessing pipeline transforms the raw inputs before inference. The MLP returns four sigmoid scores, one for each approach.

The NN controller aggregates the approach scores into the two configured signal groups and follows the higher-scoring group. The NeSy controller starts from the same MLP recommendation, then evaluates the symbolic rules described below.

## The three controllers

### 1. Fixed-time controller

The baseline alternates between the configured north-south and east-west green phases.

| Setting | Default |
|---|---:|
| Simulation horizon | 3,600 seconds |
| Green duration | 30 seconds |
| Yellow duration | 3 seconds |

The fixed controller does not use the neural model or symbolic prioritization rules. It provides a reference for comparing adaptive control.

### 2. Neural Network controller

The NN controller uses traffic-state features and MLP predictions to select the signal group. It does not apply the NeSy minimum-green, maximum-wait, fairness, or emergency-priority overrides.

The controller calculates a group score by adding the two approach scores belonging to that group. Its green duration is derived from the selected group's MLP demand. Yellow transitions are still used when changing between green groups.

### 3. Neuro-Symbolic controller

The NeSy controller uses the same learned priority estimates, but evaluates a set of explicit rules before applying the next signal decision.

| Rule | Purpose |
|---|---|
| Emergency priority | Prioritizes a group containing a stopped, waiting emergency vehicle |
| Minimum green | Prevents switching before the configured minimum green duration |
| Congestion imbalance | Overrides the MLP when queue and waiting-time imbalance crosses configured thresholds |
| Maximum waiting | Responds when the maximum observed wait on a group reaches the configured threshold |
| Fairness / starvation prevention | Prevents one group from being neglected when accumulated waiting becomes substantially higher |
| Maximum green | Forces a change when the current green reaches the configured upper bound |
| MLP recommendation | Uses the neural recommendation when no higher-priority rule requires an override |

Current NeSy parameters in the controller include:

| Parameter | Value |
|---|---:|
| Decision interval | 5 seconds |
| Minimum green | 10 seconds |
| Maximum green | 60 seconds |
| Yellow interval | 3 seconds |
| Maximum-wait threshold | 90 seconds |

Emergency vehicles are identified using the configured SUMO type IDs (ambulance, firetruck, and police) or relevant emergency/authority vehicle classes. A vehicle is considered waiting for emergency prioritization when its waiting time is at least 1 second and its speed is at most 0.5 m/s.

The NeSy controller records whether its final decision agrees with or overrides the MLP recommendation. It also records rule counts and a bounded set of human-readable override examples for inspection.

## Traffic features and priority targets

The runtime feature pipeline observes the four approaches: **north, south, east, and west**.

The model's raw input schema contains 38 numeric features plus a categorical phase feature:

| Feature group | Per approach |
|---|---|
| Queue length | 1 |
| Waiting time | 1 |
| Average speed | 1 |
| Traffic density | 1 |
| Traffic pressure | 1 |
| Arrivals | 1 |
| Departures | 1 |
| Emergency vehicle count | 1 |
| Emergency vehicle waiting time | 1 |

Global numeric features include phase time and total vehicles. The categorical phase is one-hot encoded by the fitted preprocessor. The resulting model input has **42 dimensions**.

### Engineered priority target

The training notebook constructs a normalized approach priority target from waiting time, queue, arrivals, density, speed, and pressure:

**P = 0.35W^1.4 + 0.25Q + 0.15A + 0.10D + 0.10(1 − V) + 0.05R**

Here, W, Q, A, D, V, and R are normalized waiting time, queue, arrivals, density, speed, and pressure respectively. The target is clipped to the [0,1] range and set to zero when no vehicle is present on the approach.

The notebook uses percentile-based bounds for normalization. The dataset-generation script's initial pressure calculation is:

**Pressure = queue + 0.05 × waiting time**

The MLP is trained to predict these engineered priority values. This makes the model a learned approximation of the target function; it does not by itself establish that the target function is an optimal traffic-control policy.

## Model development

The saved MLP architecture is:

~~~text
Input: 42 features
    |
Linear(42, 128) -> BatchNorm -> ReLU -> Dropout
    |
Linear(128, 64) -> BatchNorm -> ReLU -> Dropout
    |
Linear(64, 32) -> BatchNorm -> ReLU -> Dropout
    |
Linear(32, 4) -> Sigmoid
    |
Four approach priority scores
~~~

The notebook uses:

- PyTorch for model training.
- A ColumnTransformer with StandardScaler for numeric columns and OneHotEncoder for phase.
- Smooth L1 loss.
- AdamW optimization.
- Optuna for hyperparameter search.
- Early stopping based on validation loss.
- A scenario-level train/validation/test split.

The deployed model artifacts are stored under **Synflow Complete Backend/engine/Model/**:

| Artifact | Role |
|---|---|
| final_model.pt | Trained PyTorch state dictionary |
| preprocessor.joblib | Fitted scikit-learn preprocessing pipeline |
| normalization_stats.json | Percentile bounds used by the training workflow |
| best_params.json | Selected hyperparameters |

**Compatibility note:** The saved preprocessor was created with **scikit-learn 1.6.1**. The repository pins this version in requirements.txt; use the pinned version when loading the existing joblib artifact.

## Experimental methodology

The matched experiment runner is:

**Synflow Complete Backend/engine/run_matched_experiment.py**

For each run it:

1. Generates a random SUMO seed.
2. Creates a run directory named after that seed.
3. Launches the Fixed, NN, and NeSy controller scripts with the same seed and SUMO configuration.
4. Waits for all three controllers to finish.
5. Writes a manifest describing the run and the result-file locations.

The three controllers are separate SUMO processes. They are started with a short stagger to avoid TraCI port collisions, while retaining the same traffic seed.

Each controller produces a JSON result containing aggregate and directional measurements. The backend comparison service reports NN and NeSy percentage changes against the Fixed baseline.

### Metrics collected

| Metric | Interpretation | Preferred direction |
|---|---|---|
| Average waiting time | Mean vehicle waiting time from completed trip information | Lower |
| Average queue length | Mean sampled queue length | Lower |
| Average speed | Mean completed-vehicle speed derived from trip information | Higher |
| Average time loss | Mean time loss | Lower |
| Average duration | Mean trip duration | Lower |
| Throughput | Number of completed vehicles | Higher |
| Signal switches | Number of signal phase changes | Context-dependent |
| Symbolic overrides | Number of NeSy decisions that differ from the MLP recommendation | Diagnostic |
| Rule counts | Frequency of rule activation | Diagnostic |

Percentage comparisons are calculated relative to Fixed-time control. A positive percentage is treated as an improvement according to the metric's preferred direction. Traffic-control results should be reported with the number of seeds, demand settings, and scenario configuration used; a single matched run is not sufficient to establish general performance.

## Repository structure

~~~text
SynFlow-Adaptive-Traffic-Signal-Control/
|
+-- SynFlow Complete Frontend/
|   +-- src/
|   |   +-- components/
|   |   +-- pages/
|   |   +-- App.jsx
|   |   +-- ExperimentContext.jsx
|   |   +-- api.js
|   +-- video/
|   +-- package.json
|   +-- vite.config.js
|
+-- Synflow Complete Backend/
|   +-- engine/
|   |   +-- Model/
|   |   |   +-- controller_fixed_final.py
|   |   |   +-- controller_nn_final.py
|   |   |   +-- controller_nesy_final.py
|   |   |   +-- final_model.pt
|   |   |   +-- preprocessor.joblib
|   |   |   +-- normalization_stats.json
|   |   |   +-- best_params.json
|   |   +-- SUMO/
|   |   |   +-- nets/
|   |   |       +-- intersection.sumocfg
|   |   +-- run_matched_experiment.py
|   |
|   +-- server/
|       +-- models/
|       |   +-- Experiment.js
|       +-- routes/
|       |   +-- experiments.js
|       +-- services/
|       |   +-- compare.js
|       |   +-- runner.js
|       +-- .env.example
|       +-- package.json
|       +-- server.js
|
+-- data_generation/
|   +-- generate_dataset.py
|   +-- test_data_generation.py
|
+-- synflow-nn.ipynb
+-- requirements.txt
+-- DEPENDENCIES.md
+-- LICENSE
~~~

## Technology stack

| Layer | Technology | Responsibility |
|---|---|---|
| Traffic simulation | SUMO | Vehicle movement and signal simulation |
| Simulation integration | TraCI | Read traffic state and control signal phases |
| ML model | PyTorch | Four-output traffic-priority MLP |
| Preprocessing | Pandas, NumPy, scikit-learn, Joblib | Feature preparation and model input transformation |
| Hyperparameter search | Optuna | Training configuration search |
| Backend | Node.js, Express | Experiment API and Python process orchestration |
| Database | MongoDB, Mongoose | Experiment metadata and result storage |
| Frontend | React, Vite | Interactive experiment dashboard |
| Visualization | Recharts | Metric charts and controller comparisons |

## Getting started

### Important: simulation assets required

The checked-in SUMO configuration is:

**Synflow Complete Backend/engine/SUMO/nets/intersection.sumocfg**

It references these additional files:

- intersection.net.xml
- intersection_period_2_0.rou.xml
- ../vehicle_types.add.xml

These files are **not currently present in the repository tree**. A SUMO run will fail until the corresponding network, route, and vehicle-type assets are supplied at the paths expected by the configuration (or the configuration is updated to point to their actual locations).

The repository includes the controller code, trained model artifacts, and SUMO configuration, but it does not currently constitute a self-contained simulation bundle.

### Prerequisites

Install the following separately:

- Python 3.10 or later; Python 3.10/3.11 is the recommended starting point for this project.
- Node.js and npm.
- MongoDB (local instance or MongoDB Atlas).
- SUMO, including its command-line binary and tools.
- The SUMO network, route, and vehicle-type files referenced by the configuration.

Verify SUMO is available from your terminal:

~~~bash
sumo --version
~~~

On Windows, install SUMO and configure SUMO_HOME according to the [official SUMO installation guide](https://sumo.dlr.de/docs/Installing/index.html). Ensure the SUMO executable and tools are available to the environment running SynFlow.

### 1. Clone the repository

~~~bash
git clone https://github.com/PratyushSahu9000/SynFlow-Adaptive-Traffic-Signal-Control.git
cd SynFlow-Adaptive-Traffic-Signal-Control
~~~

### 2. Set up the Python environment

**Windows PowerShell:**

~~~powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
~~~

**Linux/macOS:**

~~~bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
~~~

The root requirements.txt installs the engine dependencies and pins scikit-learn to 1.6.1 for compatibility with the saved preprocessor.

### 3. Configure and start the backend

Open a new terminal with the Python environment available.

**Windows PowerShell:**

~~~powershell
cd "Synflow Complete Backend\server"
Copy-Item .env.example .env
~~~

Edit .env and provide a valid MongoDB connection string. The checked-in example also provides paths for the Python interpreter, matched-experiment runner, and result directory:

~~~dotenv
PORT=5000
MONGO_URI=your_mongodb_connection_string

PYTHON_CMD=../../.venv/Scripts/python.exe
RUNNER_PATH=../engine/run_matched_experiment.py
RESULTS_DIR=../Result
~~~

The interpreter path above is the Windows virtual-environment path for a .venv created at the repository root. Adjust PYTHON_CMD for your operating system and environment. Keep RUNNER_PATH pointed at the checked-in run_matched_experiment.py file.

Install and start the backend:

~~~powershell
npm install
npm start
~~~

The Express API listens on port **5000** by default. MongoDB must be reachable before the server starts accepting requests.

### 4. Start the frontend

In a separate terminal:

~~~powershell
cd "SynFlow Complete Frontend"
npm install
npm run dev
~~~

Open [http://localhost:5173](http://localhost:5173).

The Vite development server proxies /api requests to http://localhost:5000. When the API is hosted separately, set VITE_API_URL to the backend API base URL, including /api.

### 5. Run an experiment

Once the required SUMO network, route, and vehicle-type assets are installed in the expected locations and the backend dependencies are configured, start a new experiment from the dashboard.

The dashboard sends a request to POST /api/experiments. The backend launches the matched Python runner, stores the experiment state in MongoDB, and updates the record when the three controller result files have been read successfully.

### Run the matched experiment directly

You can also invoke the Python runner from the engine directory:

~~~powershell
cd "Synflow Complete Backend\engine"
python run_matched_experiment.py --runs 1 --output-dir Result
~~~

The runner uses the default SUMO configuration and model artifact paths relative to the engine directory. It writes a manifest.json file and a seed-specific directory containing:

~~~text
Result/
+-- manifest.json
+-- <sumo-seed>/
    +-- fixed.json
    +-- nn.json
    +-- nesy.json
~~~

Use --runs N to execute multiple matched runs. Each run gets a generated seed shared by its three controllers.

## Dashboard pages

The frontend exposes five primary routes:

| Route | Screen | Purpose |
|---|---|---|
| / | Home | Project overview and experiment entry point |
| /fixed | Fixed Traffic | Baseline controller metrics and directional results |
| /nn | Neural Network | MLP predictions and NN controller results |
| /nesy | Neuro-Symbolic AI | Rule decisions, override counts, and explanations |
| /compare | Compare | Side-by-side Fixed, NN, and NeSy metric comparison |

The selected experiment is shared across pages. When a run is active, the frontend subscribes to the backend's Server-Sent Events endpoint and refreshes the experiment when it completes or fails.

[Watch the dashboard demo video](https://github.com/PratyushSahu9000/SynFlow-Adaptive-Traffic-Signal-Control/blob/main/SynFlow%20Complete%20Frontend/video/WhatsApp%20Video%202026-10-12%20at%202.26.15%20PM.mp4)

## API reference

Base URL: http://localhost:5000/api/experiments

| Method | Endpoint | Description |
|---|---|---|
| POST | / | Create an experiment and start the matched controller run |
| GET | / | List experiments, excluding the large results payload |
| GET | /:id | Retrieve one experiment, including controller results |
| GET | /:id/compare | Retrieve comparison metrics for a completed experiment |
| GET | /:id/stream | Subscribe to live progress and terminal status using SSE |

### Experiment lifecycle

The experiment document uses the following statuses:

- **running** — the Python matched experiment is in progress.
- **completed** — all three controller outputs were read and saved.
- **failed** — the process failed, an expected result file was missing, or result parsing failed.

The comparison endpoint returns HTTP **409** while an experiment is not completed. Unknown experiment IDs return HTTP **404**. If the Node server restarts while an experiment is marked as running, startup logic marks that experiment as failed because the interrupted process cannot resume.

## Dataset generation and training

### Dataset generation

The dataset generator is located at:

**data_generation/generate_dataset.py**

It creates varied SUMO traffic scenarios, samples traffic observations at five-second intervals, and writes scenario-level CSV files plus supporting route files. The default configuration requests 300 scenarios of 3,600 seconds each, with demand levels sampled across the configured range and a 5% emergency-vehicle penetration setting.

**Portability note:** The current dataset-generation script contains a machine-specific SUMO installation path and network/vehicle-type paths that do not match the checked-in repository layout. Update those path constants for your local SUMO installation and actual asset locations before running it on another machine. The referenced network and vehicle-type assets must also be supplied.

The script accepts options including:

~~~bash
python data_generation/generate_dataset.py --help
~~~

Its default output structure is:

~~~text
dataset/
+-- routes/
+-- scenarios/
~~~

### Training notebook

The ML workflow is documented in:

**synflow-nn.ipynb**

The notebook currently reads its training CSV from a Kaggle input path. To reproduce training locally, update that data-loading cell to point to your generated or downloaded traffic_dataset.csv, then install the notebook's additional experimentation packages as needed (for example, Jupyter, Matplotlib, and Optuna).

The notebook documents preprocessing, scenario-level splitting, target construction, Optuna search, model fitting, and held-out test evaluation. The controller uses the saved final_model.pt and preprocessor.joblib artifacts; keep the model and preprocessing artifact versions aligned.

## Configuration reference

### Backend environment variables

| Variable | Purpose | Default / example |
|---|---|---|
| PORT | Express server port | 5000 |
| MONGO_URI | MongoDB connection string | Required |
| PYTHON_CMD | Python interpreter used to launch the runner | Example in server/.env.example |
| RUNNER_PATH | Path to the matched experiment runner | ../engine/run_matched_experiment.py |
| RESULTS_DIR | Directory for manifest and controller output files | ../Result |

### Frontend environment variable

| Variable | Purpose | Default |
|---|---|---|
| VITE_API_URL | Backend API base URL | /api |

Do not commit real .env files, database credentials, or other secrets.

## Limitations and reproducibility notes

- **Simulation assets:** the SUMO configuration references network, route, and vehicle-type files that are not currently included in the repository. Supply these before running an experiment.
- **Dataset-generator paths:** the generator contains machine-specific path assumptions. Update them before using it outside the original environment.
- **Notebook data path:** the notebook uses a Kaggle dataset path and requires a local path change for standalone reproduction.
- **Training versus control metrics:** high test accuracy against engineered priority targets does not guarantee lower waiting time or higher throughput. Evaluate traffic-control outcomes using matched SUMO experiments.
- **Simulation scope:** results from one modeled intersection do not establish performance on a city-wide network or at a physical signal.
- **Operational safety:** the project has not undergone field validation, formal safety certification, or integration testing with real traffic infrastructure.
- **Backend resilience:** experiments interrupted by a backend restart are marked failed; the current service does not resume an interrupted simulation automatically.

## Development and contribution

Contributions and technical feedback are welcome.

1. Fork the repository.
2. Create a focused feature branch.
3. Make the change and document any configuration or experiment impact.
4. Run the relevant checks or simulation tests where the required SUMO assets are available.
5. Open a pull request describing the implementation and validation performed.

For changes to controller behavior, include the SUMO configuration, seed strategy, demand assumptions, and metrics used for evaluation. This makes results easier to reproduce and compare.

## License

SynFlow is released under the **MIT License**. See [LICENSE](LICENSE) for the full license text.

## Acknowledgements

- [Eclipse SUMO](https://sumo.dlr.de/) — microscopic traffic simulation.
- [TraCI](https://sumo.dlr.de/docs/TraCI.html) — programmatic simulation and traffic-signal control.
- [PyTorch](https://pytorch.org/) — neural network implementation.
- [scikit-learn](https://scikit-learn.org/) — preprocessing pipeline.
- [Optuna](https://optuna.org/) — hyperparameter optimization.
- [React](https://react.dev/) and [Vite](https://vite.dev/) — frontend application.
- [Express](https://expressjs.com/) and [Mongoose](https://mongoosejs.com/) — backend API and persistence.

---

<p align="center">
  <strong>SynFlow — Adaptive decisions with explicit reasoning.</strong>
</p>
