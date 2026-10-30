"""
SynFlow optimized SUMO + TraCI + MLP controller.

Runtime:
    SUMO -> TraCI -> traffic features every 5 simulation seconds
         -> preprocessor.joblib -> final_model.pt
         -> congestion/timing rules -> NS/EW green timing -> SUMO

The simulation always ends at 3600 seconds unless SUMO terminates earlier.

Required files in the same project directory (or paths supplied by CLI):
    intersection.sumocfg
    final_model.pt
    preprocessor.joblib

Recommended environment:
    Python 3.10/3.11
    scikit-learn 1.6.1 (the saved preprocessor was created with 1.6.1)
    torch
    pandas
    traci
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time as walltime
import random
from pathlib import Path
from collections import defaultdict
import warnings

import numpy as np
import pandas as pd
import torch
import torch.nn as nn

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SIMULATION_DURATION = 3600
DECISION_INTERVAL = 5

YELLOW_TIME = 3
MIN_GREEN = 5
MAX_GREEN = 60
MAX_WAIT_THRESHOLD = 90

TLS_ID = "center"

APPROACHES = ("north", "south", "east", "west")
IN_EDGES = {
    "north": "north_in",
    "south": "south_in",
    "east": "east_in",
    "west": "west_in",
}

# Emergency vehicle type IDs used by the SUMO route/type files.
EMERGENCY_TYPE_IDS = {"ambulance", "firetruck", "police"}
EMERGENCY_VCLASSES = {"emergency", "authority"}

APPROACH_GROUP = {
    "north": "NS",
    "south": "NS",
    "east": "EW",
    "west": "EW",
}

# Exact raw feature order found in the saved ColumnTransformer.
NUMERIC_FEATURES = [
    "north_queue", "north_waiting", "north_speed", "north_density",
    "north_pressure", "north_arrivals", "north_departures",
    "north_emergency", "north_emergency_waiting",

    "south_queue", "south_waiting", "south_speed", "south_density",
    "south_pressure", "south_arrivals", "south_departures",
    "south_emergency", "south_emergency_waiting",

    "east_queue", "east_waiting", "east_speed", "east_density",
    "east_pressure", "east_arrivals", "east_departures",
    "east_emergency", "east_emergency_waiting",

    "west_queue", "west_waiting", "west_speed", "west_density",
    "west_pressure", "west_arrivals", "west_departures",
    "west_emergency", "west_emergency_waiting",

    "phase_time", "total_vehicles",
]

RAW_FEATURES = NUMERIC_FEATURES + ["phase"]

# Network phase mapping from intersection.net.xml.
NS_GREEN = 0
NS_YELLOW = 1
EW_GREEN = 2
EW_YELLOW = 3

GREEN_PHASES = {NS_GREEN, EW_GREEN}
YELLOW_PHASES = {NS_YELLOW, EW_YELLOW}

# ---------------------------------------------------------------------------
# MLP
# ---------------------------------------------------------------------------

class TrafficPriorityMLP(nn.Module):
    """Exact architecture matching final_model.pt."""

    def __init__(self):
        super().__init__()
        self.network = nn.Sequential(
            nn.Linear(42, 128),
            nn.BatchNorm1d(128),
            nn.ReLU(),
            nn.Dropout(0.19455273277569726),

            nn.Linear(128, 64),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.Dropout(0.1786944473354618),

            nn.Linear(64, 32),
            nn.BatchNorm1d(32),
            nn.ReLU(),
            nn.Dropout(0.04107425436374876),

            nn.Linear(32, 4),
            nn.Sigmoid(),
        )

    def forward(self, x):
        return self.network(x)


# ---------------------------------------------------------------------------
# Fast loading
# ---------------------------------------------------------------------------

def load_model(model_path: Path) -> nn.Module:
    state = torch.load(model_path, map_location="cpu", weights_only=True)

    model = TrafficPriorityMLP()
    model.load_state_dict(state, strict=True)
    model.eval()

    # For a tiny network, one CPU thread avoids thread-management overhead.
    torch.set_num_threads(1)
    return model


def load_preprocessor(preprocessor_path: Path):
    """
    Load the saved sklearn preprocessor.

    The artifact was created with sklearn 1.6.1. If a newer version is used,
    sklearn may reject the private _RemainderColsList class used by the pickle.
    """
    try:
        import joblib
    except ImportError:
        raise RuntimeError("Install joblib: pip install joblib")

    try:
        return joblib.load(preprocessor_path)
    except AttributeError as exc:
        if "_RemainderColsList" in str(exc):
            raise RuntimeError(
                "preprocessor.joblib was created with scikit-learn 1.6.1. "
                "Install that version in the runtime environment:\n"
                "    pip install scikit-learn==1.6.1"
            ) from exc
        raise


# ---------------------------------------------------------------------------
# Traffic feature extraction
# ---------------------------------------------------------------------------

class TrafficState:
    """
    Efficient feature collector.

    IMPORTANT:
    Feature extraction is performed only every DECISION_INTERVAL seconds,
    not on every SUMO step. This is the main performance optimization.
    """

    def __init__(self, traci):
        self.traci = traci

        # Cache lane IDs once. No repeated getLaneNumber/getLaneID calls.
        self.lanes = {}
        for approach, edge in IN_EDGES.items():
            self.lanes[approach] = tuple(
                f"{edge}_{i}"
                for i in range(traci.edge.getLaneNumber(edge))
            )

        # Vehicle IDs on each approach at the previous decision point.
        self.previous_vehicle_ids = {
            a: set() for a in APPROACHES
        }

        self.initialized = False

    def _lane_vehicle_ids(self, approach: str) -> set[str]:
        ids = set()
        for lane_id in self.lanes[approach]:
            ids.update(self.traci.lane.getLastStepVehicleIDs(lane_id))
        return ids

    def snapshot(self) -> dict:
        """
        Collect all 39 raw features.

        The saved preprocessor expects 38 numeric columns plus categorical
        phase. We preserve the exact column names and order.
        """
        now = float(self.traci.simulation.getTime())
        phase = int(self.traci.trafficlight.getPhase(TLS_ID))

        data = {}

        total_vehicles = len(self.traci.vehicle.getIDList())

        for approach in APPROACHES:
            queue = 0.0
            waiting = 0.0
            speed_sum = 0.0
            vehicle_count = 0
            density_sum = 0.0

            current_ids = self._lane_vehicle_ids(approach)

            for lane_id in self.lanes[approach]:
                queue += float(self.traci.lane.getLastStepHaltingNumber(lane_id))
                waiting += float(self.traci.lane.getWaitingTime(lane_id))

                n = int(self.traci.lane.getLastStepVehicleNumber(lane_id))
                vehicle_count += n

                speed = float(self.traci.lane.getLastStepMeanSpeed(lane_id))
                if n > 0:
                    speed_sum += speed * n

                density_sum += float(
                    self.traci.lane.getLastStepOccupancy(lane_id)
                )

            speed = speed_sum / vehicle_count if vehicle_count else 0.0
            density = (
                density_sum / len(self.lanes[approach])
                if self.lanes[approach] else 0.0
            )

            # Track vehicles entering/leaving the approach between decisions.
            if not self.initialized:
                arrivals = 0.0
                departures = 0.0
            else:
                previous = self.previous_vehicle_ids[approach]
                arrivals = float(len(current_ids - previous))
                departures = float(len(previous - current_ids))

            # Emergency features are kept only as zero placeholders because
            # the saved MLP/preprocessor expects these columns. Emergency data
            # is NOT used by this controller. It can be handled separately by
            # the symbolic layer.
            emergency_count = 0.0
            emergency_waiting = 0.0

            # Pressure is kept as a queue-based demand signal for this
            # single-intersection runtime. It remains non-negative.
            pressure = queue

            data[f"{approach}_queue"] = queue
            data[f"{approach}_waiting"] = waiting
            data[f"{approach}_speed"] = speed
            data[f"{approach}_density"] = density
            data[f"{approach}_pressure"] = pressure
            data[f"{approach}_arrivals"] = arrivals
            data[f"{approach}_departures"] = departures
            data[f"{approach}_emergency"] = emergency_count
            data[f"{approach}_emergency_waiting"] = emergency_waiting

            self.previous_vehicle_ids[approach] = current_ids

        data["phase_time"] = self._phase_elapsed(now)
        data["total_vehicles"] = float(total_vehicles)
        data["phase"] = phase

        self.initialized = True
        return data

    def _phase_elapsed(self, now: float) -> float:
        # This is replaced by the controller's explicit phase-start tracking.
        return 0.0


# ---------------------------------------------------------------------------
# Controller
# ---------------------------------------------------------------------------

class SynFlowController:

    def __init__(self, traci, model, preprocessor):
        self.traci = traci
        self.model = model
        self.preprocessor = preprocessor
        self.sumo_seed = None

        self.state = TrafficState(traci)

        self.phase = int(traci.trafficlight.getPhase(TLS_ID))
        self.phase_start_time = float(traci.simulation.getTime())

        self.last_prediction = np.zeros(4, dtype=np.float32)
        self.last_decision_time = -DECISION_INTERVAL

        self.switch_count = 0
        self.mlp_decisions = 0
        self.rule_counts = defaultdict(int)

        # Directional performance metrics.  Values are sampled every
        # DECISION_INTERVAL seconds and completed vehicles are counted when
        # they disappear from the simulation.
        self.metric_queue_sum = {a: 0.0 for a in APPROACHES}
        self.metric_queue_samples = 0
        self.metric_wait_sum = {a: 0.0 for a in APPROACHES}
        self.metric_completed = {a: 0 for a in APPROACHES}
        self.metric_vehicle_approach = {}
        self.metric_last_waiting = {}
        self.metric_seen_vehicles = set()

        # Emergency analysis is observational only. It NEVER affects the
        # MLP input, phase choice, or timing rules. An event is recorded when
        # an emergency vehicle is waiting/stopped on the lower-congestion
        # direction while the MLP keeps the higher-congestion direction green.
        # Only running aggregates are kept -- not a growing list of events.
        self.emergency_block_active = {}
        self.emergency_event_count = 0
        self.emergency_total_blocked_duration = 0.0
        self.emergency_events_by_type = defaultdict(int)
        self.emergency_events_by_approach = defaultdict(int)


    # ---------------------------
    # Phase timing
    # ---------------------------

    def phase_elapsed(self, now: float) -> float:
        return max(0.0, now - self.phase_start_time)

    def update_phase_tracking(self, now: float):
        current = int(self.traci.trafficlight.getPhase(TLS_ID))
        if current != self.phase:
            self.phase = current
            self.phase_start_time = now

    def current_green_group(self) -> str | None:
        if self.phase == NS_GREEN:
            return "NS"
        if self.phase == EW_GREEN:
            return "EW"
        return None

    # ---------------------------
    # MLP
    # ---------------------------

    def predict(self, raw_state: dict) -> np.ndarray:
        df = pd.DataFrame([raw_state], columns=RAW_FEATURES)

        # Saved ColumnTransformer performs StandardScaler + phase one-hot.
        transformed = self.preprocessor.transform(df)
        transformed = np.asarray(transformed, dtype=np.float32)

        tensor = torch.from_numpy(transformed)

        with torch.inference_mode():
            output = self.model(tensor).cpu().numpy()[0]

        self.last_prediction = output
        self.mlp_decisions += 1

        return output

    # ---------------------------
    # MLP-only group selection
    # ---------------------------

    def choose_group(self, raw_state: dict, scores: np.ndarray) -> tuple[str, str]:
        # The NN baseline must use only the MLP recommendation.
        # No minimum-green, maximum-wait, or maximum-green symbolic overrides.
        ns_score = float(scores[0] + scores[1])
        ew_score = float(scores[2] + scores[3])

        recommended = "NS" if ns_score >= ew_score else "EW"
        self.rule_counts["mlp_recommendation"] += 1
        return recommended, "mlp_recommendation"

    def desired_green(self, raw_state: dict, scores: np.ndarray, group: str) -> int:
        # Keep the NN controller's green duration driven by the MLP demand.
        if group == "NS":
            demand = float(scores[0]) + float(scores[1])
        else:
            demand = float(scores[2]) + float(scores[3])

        # Sigmoid MLP outputs are in [0, 1], so each group demand is [0, 2].
        # No minimum-green or maximum-green rule is applied here.
        green = int(round(10.0 + 20.0 * demand))
        return max(1, green)

    def apply_decision(self, raw_state: dict, scores: np.ndarray):
        now = float(self.traci.simulation.getTime())
        self.update_phase_tracking(now)

        current = self.current_green_group()
        target, reason = self.choose_group(raw_state, scores)

        # Observation only: identify emergency vehicles that are stopped while
        # the MLP keeps the higher-congestion direction green.
        self._update_emergency_block_analysis(
            raw_state, scores, current, target, reason
        )

        if current == target:
            # Do not constantly reset the phase duration. Only extend/shorten
            # the current green when it is still safe to do so.
            elapsed = self.phase_elapsed(now)
            desired = self.desired_green(raw_state, scores, target)

            remaining = max(0.0, desired - elapsed)
            self.traci.trafficlight.setPhaseDuration(TLS_ID, remaining)
            return

        # A change is requested. Do not jump directly from green to green:
        # use the fixed yellow phase first.
        if current == "NS" and target == "EW":
            self.traci.trafficlight.setPhase(TLS_ID, NS_YELLOW)
            self.traci.trafficlight.setPhaseDuration(TLS_ID, YELLOW_TIME)
            self.pending_target = "EW"
            self.switch_count += 1
            return

        if current == "EW" and target == "NS":
            self.traci.trafficlight.setPhase(TLS_ID, EW_YELLOW)
            self.traci.trafficlight.setPhaseDuration(TLS_ID, YELLOW_TIME)
            self.pending_target = "NS"
            self.switch_count += 1
            return

        # If already in yellow, the next green is handled by advance_phase().
        self.pending_target = target

    def advance_phase(self):
        now = float(self.traci.simulation.getTime())
        phase = int(self.traci.trafficlight.getPhase(TLS_ID))

        if phase not in YELLOW_PHASES:
            return

        # SUMO's getNextSwitch gives the scheduled end of the current phase.
        # Only switch when yellow has completed.
        if float(self.traci.trafficlight.getNextSwitch(TLS_ID)) <= now + 1e-9:
            target = getattr(self, "pending_target", None)

            if target == "NS":
                self.traci.trafficlight.setPhase(TLS_ID, NS_GREEN)
            else:
                self.traci.trafficlight.setPhase(TLS_ID, EW_GREEN)

            self.phase = int(self.traci.trafficlight.getPhase(TLS_ID))
            self.phase_start_time = now

            # Duration will be set on the next 5-second decision point.

    # ---------------------------
    # Main control tick
    # ---------------------------

    def tick(self) -> bool:
        now = float(self.traci.simulation.getTime())

        self.update_phase_tracking(now)
        self.advance_phase()

        if now - self.last_decision_time < DECISION_INTERVAL - 1e-9:
            return False

        self.last_decision_time = now

        # Feature extraction happens ONLY here.
        raw_state = self.state.snapshot()

        # Performance metrics use the same snapshot; do not collect traffic
        # state a second time at the same decision point.
        self._sample_performance_from_state(raw_state)

        # Keep TrafficState's phase_time synchronized with explicit tracking.
        raw_state["phase_time"] = self.phase_elapsed(now)

        scores = self.predict(raw_state)

        self.apply_decision(raw_state, scores)
        return True

    # ---------------------------
    # Emergency analysis (observation only)
    # ---------------------------

    def _emergency_info(self, vehicle_id: str):
        """Return (is_emergency, type_id) without influencing control."""
        try:
            type_id = str(self.traci.vehicle.getTypeID(vehicle_id))
        except self.traci.TraCIException:
            type_id = "unknown"

        if type_id in EMERGENCY_TYPE_IDS:
            return True, type_id

        try:
            vclass = str(self.traci.vehicle.getVehicleClass(vehicle_id))
        except self.traci.TraCIException:
            vclass = ""

        return vclass in EMERGENCY_VCLASSES, type_id

    def _current_emergency_vehicles(self):
        """Return emergency vehicles currently present with approach/waiting data."""
        result = []
        for vehicle_id in self.traci.vehicle.getIDList():
            is_emergency, type_id = self._emergency_info(vehicle_id)
            if not is_emergency:
                continue

            approach = self.metric_vehicle_approach.get(vehicle_id)
            if approach is None:
                approach = self._vehicle_approach(vehicle_id)
            if approach is None:
                continue

            try:
                waiting = max(0.0, float(self.traci.vehicle.getWaitingTime(vehicle_id)))
                speed = float(self.traci.vehicle.getSpeed(vehicle_id))
            except self.traci.TraCIException:
                continue

            result.append({
                "vehicle_id": vehicle_id,
                "type": type_id,
                "approach": approach,
                "group": APPROACH_GROUP[approach],
                "waiting_seconds": waiting,
                "speed_mps": speed,
            })
        return result

    def _congestion_value(self, raw_state: dict, approach: str) -> float:
        """Use the same queue/waiting scale as the dataset pressure feature."""
        return (
            float(raw_state[f"{approach}_queue"])
            + 0.05 * float(raw_state[f"{approach}_waiting"])
        )

    def _group_congestion(self, raw_state: dict, group: str) -> float:
        if group == "NS":
            return (
                self._congestion_value(raw_state, "north")
                + self._congestion_value(raw_state, "south")
            )
        return (
            self._congestion_value(raw_state, "east")
            + self._congestion_value(raw_state, "west")
        )

    def _update_emergency_block_analysis(
        self, raw_state: dict, scores: np.ndarray, current: str | None,
        target: str, reason: str
    ):
        """Record observed cases where the MLP favors the busier group
        while a stopped emergency vehicle is in the lower-congestion group.

        This is analysis only. It never changes the controller decision and
        emergency information is not added to the NN inputs.
        """
        now = float(self.traci.simulation.getTime())

        candidates = {}
        emergency_vehicles = self._current_emergency_vehicles()

        # Compare the MLP's actual group preference, independently of the
        # symbolic timing rules. This is important because safety/min-green/
        # max-green rules can otherwise hide an MLP-induced delay.
        ns_score = float(scores[0] + scores[1])
        ew_score = float(scores[2] + scores[3])
        mlp_group = "NS" if ns_score >= ew_score else "EW"

        for v in emergency_vehicles:
            # Only count an emergency that is actually waiting/stopped.
            if v["waiting_seconds"] < 1.0 or v["speed_mps"] > 0.5:
                continue

            emergency_group = v["group"]
            other_group = "EW" if emergency_group == "NS" else "NS"

            emergency_congestion = self._group_congestion(
                raw_state, emergency_group
            )
            other_congestion = self._group_congestion(raw_state, other_group)

            # The emergency must be in the genuinely less-congested group.
            if other_congestion <= emergency_congestion + 0.25:
                continue

            # The MLP must prefer the more-congested group.
            if mlp_group != other_group:
                continue

            # The more-congested group must currently be the green direction.
            # This identifies an actual observed delay rather than merely an
            # unfavorable score recommendation for a vehicle that is moving.
            if current != other_group:
                continue

            candidates[v["vehicle_id"]] = {
                "time": now,
                "vehicle_id": v["vehicle_id"],
                "emergency_type": v["type"],
                "approach": v["approach"],
                "emergency_group": emergency_group,
                "current_green": current,
                "mlp_recommended_group": mlp_group,
                "reason": reason,
                "emergency_waiting_seconds": v["waiting_seconds"],
                "emergency_speed_mps": v["speed_mps"],
                "emergency_group_congestion": emergency_congestion,
                "other_group_congestion": other_congestion,
                "ns_priority": ns_score,
                "ew_priority": ew_score,
            }

        # Start a blocking episode once the condition is first observed.
        for vehicle_id, event in candidates.items():
            if vehicle_id not in self.emergency_block_active:
                self.emergency_block_active[vehicle_id] = event

        # Close an episode when the emergency is no longer being blocked.
        # Only aggregate counters/sums are updated -- no event list is kept.
        for vehicle_id in list(self.emergency_block_active):
            if vehicle_id in candidates:
                continue

            event = self.emergency_block_active.pop(vehicle_id)
            duration = max(0.0, now - float(event["time"]))
            self.emergency_event_count += 1
            self.emergency_total_blocked_duration += duration
            self.emergency_events_by_type[event["emergency_type"]] += 1
            self.emergency_events_by_approach[event["approach"]] += 1

    def _finalize_emergency_blocks(self):
        """Close any still-active analysis events at simulation end."""
        now = float(self.traci.simulation.getTime())
        for vehicle_id, event in list(self.emergency_block_active.items()):
            duration = max(0.0, now - float(event["time"]))
            self.emergency_event_count += 1
            self.emergency_total_blocked_duration += duration
            self.emergency_events_by_type[event["emergency_type"]] += 1
            self.emergency_events_by_approach[event["approach"]] += 1
        self.emergency_block_active.clear()

    def emergency_analysis(self) -> dict:
        """Summarize observed MLP-only emergency delays (aggregate only)."""
        return {
            "definition": (
                "Emergency was waiting/stopped while its lower-congestion group "
                "was not selected by the MLP and the higher-congestion group "
                "remained green. This metric is observational only."
            ),
            "event_count": self.emergency_event_count,
            "events_by_emergency_type": dict(self.emergency_events_by_type),
            "events_by_approach": dict(self.emergency_events_by_approach),
            "total_blocked_duration_seconds": self.emergency_total_blocked_duration,
            "average_blocked_duration_seconds": (
                self.emergency_total_blocked_duration / self.emergency_event_count
                if self.emergency_event_count else 0.0
            ),
        }

    # ---------------------------
    # Directional performance metrics
    # ---------------------------

    def _vehicle_approach(self, vehicle_id: str):
        """Return the vehicle's original incoming approach, if known."""
        approach = self.metric_vehicle_approach.get(vehicle_id)
        if approach is not None:
            return approach

        try:
            route = self.traci.vehicle.getRoute(vehicle_id)
            if route:
                first_edge = route[0]
                for candidate, edge in IN_EDGES.items():
                    if first_edge == edge:
                        self.metric_vehicle_approach[vehicle_id] = candidate
                        return candidate
        except self.traci.TraCIException:
            pass
        return None

    def track_vehicle_completion(self, sample_waiting: bool = False) -> None:
        """Track completions each step and sample per-vehicle waits periodically."""
        current_ids = set(self.traci.vehicle.getIDList())

        for vehicle_id in current_ids:
            approach = self._vehicle_approach(vehicle_id)
            if approach is None or not sample_waiting:
                continue
            try:
                self.metric_last_waiting[vehicle_id] = float(
                    self.traci.vehicle.getWaitingTime(vehicle_id)
                )
            except self.traci.TraCIException:
                pass

        if self.metric_seen_vehicles:
            completed_now = self.metric_seen_vehicles - current_ids
            for vehicle_id in completed_now:
                approach = self.metric_vehicle_approach.get(vehicle_id)
                if approach is not None and vehicle_id in self.metric_last_waiting:
                    self.metric_wait_sum[approach] += self.metric_last_waiting[vehicle_id]
                    self.metric_completed[approach] += 1
                self.metric_last_waiting.pop(vehicle_id, None)
                self.metric_vehicle_approach.pop(vehicle_id, None)

        self.metric_seen_vehicles = current_ids

    def _sample_performance_from_state(self, raw_state: dict):
        """Sample directional queue length using the controller's 5-second tick."""
        for approach in APPROACHES:
            self.metric_queue_sum[approach] += float(
                raw_state[f"{approach}_queue"]
            )
        self.metric_queue_samples += 1

    def directional_metrics(self) -> dict:
        """Return per-direction performance metrics from running accumulators."""
        directions = {}
        for approach in APPROACHES:
            completed = self.metric_completed[approach]
            samples = self.metric_queue_samples
            directions[approach] = {
                "average_waiting_time": (
                    self.metric_wait_sum[approach] / completed
                    if completed else 0.0
                ),
                "average_queue_length": (
                    self.metric_queue_sum[approach] / samples
                    if samples else 0.0
                ),
                "throughput": int(completed),
            }
        return directions

    # ---------------------------
    # Results
    # ---------------------------

    def result_dict(self, runtime_seconds: float) -> dict:
        """Compact final result. Vehicle-level totals (waiting time, speed,
        time loss, duration, throughput) are filled in by run() from the
        SUMO tripinfo data once the simulation has finished."""
        total_queue = (
            sum(self.metric_queue_sum.values()) / self.metric_queue_samples
            if self.metric_queue_samples else 0.0
        )

        return {
            "controller": "nn",
            "sumo_seed": self.sumo_seed,
            "simulation_duration_seconds": SIMULATION_DURATION,
            "total": {
                "average_queue_length": total_queue,
            },
            "directions": self.directional_metrics(),
            "signal": {"switches": self.switch_count},
            "runtime": {"wall_clock_seconds": runtime_seconds},
            "mlp": {"decisions": self.mlp_decisions},
            "rule_counts": {"mlp_recommendation": int(self.rule_counts.get("mlp_recommendation", 0))},
            "last_prediction": {
                "north": float(self.last_prediction[0]),
                "south": float(self.last_prediction[1]),
                "east": float(self.last_prediction[2]),
                "west": float(self.last_prediction[3]),
            },
            "emergency": self.emergency_analysis(),
        }


# ---------------------------------------------------------------------------
# SUMO startup
# ---------------------------------------------------------------------------

def start_sumo(sumo_binary: str, sumocfg: Path, tripinfo: Path, seed: int):
    import traci

    command = [
        sumo_binary,
        "-c", str(sumocfg),
        "--begin", "0",
        "--end", str(SIMULATION_DURATION),
        "--seed", str(seed),
        "--no-step-log", "true",
        "--tripinfo-output", str(tripinfo),
        "--duration-log.disable", "true",
        "--verbose", "false",
    ]

    traci.start(command)
    return traci


# ---------------------------------------------------------------------------
# Tripinfo metrics
# ---------------------------------------------------------------------------

def parse_tripinfo(path: Path) -> dict:
    """
    Parse SUMO tripinfo XML if available.

    This gives much more reliable final travel/wait/throughput metrics than
    repeatedly scanning all vehicles during the simulation.
    """
    if not path.exists():
        return {
            "completed_vehicles": 0,
            "avg_waiting_time": 0.0,
            "avg_time_loss": 0.0,
            "avg_duration": 0.0,
            "avg_speed": 0.0,
        }

    import xml.etree.ElementTree as ET

    root = ET.parse(path).getroot()
    trips = root.findall("tripinfo")

    if not trips:
        return {
            "completed_vehicles": 0,
            "avg_waiting_time": 0.0,
            "avg_time_loss": 0.0,
            "avg_duration": 0.0,
            "avg_speed": 0.0,
        }

    def f(node, attr):
        try:
            return float(node.attrib.get(attr, 0.0))
        except (TypeError, ValueError):
            return 0.0

    durations = [f(x, "duration") for x in trips]
    waiting = [f(x, "waitingTime") for x in trips]
    time_loss = [f(x, "timeLoss") for x in trips]

    # tripinfo does not always expose average speed directly, so derive it.
    route_lengths = [f(x, "routeLength") for x in trips]
    speeds = [
        route_lengths[i] / durations[i]
        if durations[i] > 0 else 0.0
        for i in range(len(trips))
    ]

    return {
        "completed_vehicles": len(trips),
        "avg_waiting_time": float(np.mean(waiting)),
        "avg_time_loss": float(np.mean(time_loss)),
        "avg_duration": float(np.mean(durations)),
        "avg_speed": float(np.mean(speeds)),
    }


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def run(args):
    project = Path(args.project).resolve()

    sumocfg = Path(args.sumocfg)
    if not sumocfg.is_absolute():
        sumocfg = project / sumocfg

    model_path = Path(args.model)
    if not model_path.is_absolute():
        model_path = project / model_path

    preprocessor_path = Path(args.preprocessor)
    if not preprocessor_path.is_absolute():
        preprocessor_path = project / preprocessor_path

    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = project / output_path

    tripinfo_path = output_path.with_name(f"tripinfo_{output_path.stem}.xml")

    if not sumocfg.exists():
        raise FileNotFoundError(f"SUMO config not found: {sumocfg}")
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")
    if not preprocessor_path.exists():
        raise FileNotFoundError(f"Preprocessor not found: {preprocessor_path}")

    sumo_binary = args.sumo_binary
    if not sumo_binary:
        sumo_home = os.environ.get("SUMO_HOME")
        if not sumo_home:
            raise RuntimeError(
                "SUMO_HOME is not set. Set it or pass --sumo-binary."
            )
        sumo_binary = str(
            Path(sumo_home) / "bin" / ("sumo-gui.exe" if args.gui else "sumo.exe")
        )

    print("=" * 64)
    print("SynFlow — Optimized Neuro-Symbolic SUMO Controller")
    print("=" * 64)
    print(f"SUMO config : {sumocfg}")
    print(f"MLP         : {model_path}")
    print(f"Preprocessor: {preprocessor_path}")
    print(f"Duration    : {SIMULATION_DURATION} s")
    print(f"Decision    : every {DECISION_INTERVAL} s")
    print(f"GUI         : {args.gui}")
    print("=" * 64)

    print("Loading MLP...")
    model = load_model(model_path)

    print("Loading preprocessor...")
    preprocessor = load_preprocessor(preprocessor_path)

    import traci

    started = walltime.perf_counter()

    if args.seed is None:
        raise ValueError("--seed is required for matched experiments. Generate and save the seed in the experiment runner.")
    print(f"SUMO seed    : {args.seed}")

    traci.start([
        sumo_binary,
        "-c", str(sumocfg),
        "--begin", "0",
        "--end", str(SIMULATION_DURATION),
        "--seed", str(args.seed),
        "--no-step-log", "true",
        "--tripinfo-output", str(tripinfo_path),
        "--duration-log.disable", "true",
        "--verbose", "false",
    ])

    controller = SynFlowController(traci, model, preprocessor)
    controller.sumo_seed = int(args.seed)

    try:
        # last_report = -60

        # Always run the complete one-hour horizon, even if SUMO temporarily
        # has no expected vehicles. This guarantees exactly 3600 simulated seconds.
        while float(traci.simulation.getTime()) < SIMULATION_DURATION:
            traci.simulationStep()
            sample_waiting = controller.tick()
            controller.track_vehicle_completion(sample_waiting)

            # Console output only once per simulated minute.
            # Printing every decision point noticeably slows fast runs.
            # sim_time = float(traci.simulation.getTime())
            # if args.quiet is False and sim_time >= last_report + 60:
            #     print(
            #         f"[SIM {sim_time:6.0f}s] "
            #         f"phase={traci.trafficlight.getPhase(TLS_ID)} "
            #         f"MLP={controller.last_prediction.round(3).tolist()} "
            #         f"switches={controller.switch_count}"
            #     )
            #     last_report = sim_time

    finally:
        # Finalize emergency-block events while TraCI is still connected.
        try:
            controller._finalize_emergency_blocks()
        except Exception:
            pass

        try:
            traci.close()
        except Exception:
            pass

    runtime = walltime.perf_counter() - started

    trip_metrics = parse_tripinfo(tripinfo_path)
    result = controller.result_dict(runtime)
    result["total"]["average_waiting_time"] = trip_metrics["avg_waiting_time"]
    result["total"]["average_speed"] = trip_metrics["avg_speed"]
    result["total"]["avg_time_loss"] = trip_metrics["avg_time_loss"]
    result["total"]["avg_duration"] = trip_metrics["avg_duration"]
    result["total"]["throughput"] = trip_metrics["completed_vehicles"]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print("\n" + "=" * 64)
    print("Simulation finished")
    print("=" * 64)
    print(f"Simulation time : {SIMULATION_DURATION} s")
    print(f"Wall-clock time : {runtime:.2f} s")
    print(f"MLP predictions  : {controller.mlp_decisions}")
    print(f"Signal switches  : {controller.switch_count}")
    print(f"Throughput       : {trip_metrics['completed_vehicles']}")
    print(f"Avg waiting time : {trip_metrics['avg_waiting_time']:.2f} s")
    print(f"Avg duration     : {trip_metrics['avg_duration']:.2f} s")
    print(f"Avg speed        : {trip_metrics['avg_speed']:.2f} m/s")
    print(f"Results JSON     : {output_path}")
    print("=" * 64)


def main():
    parser = argparse.ArgumentParser(
        description="SynFlow SUMO/TraCI MLP-only controller"
    )

    parser.add_argument(
        "--project",
        default=".",
        help="Project directory containing SUMO/model files",
    )

    parser.add_argument(
    "--sumocfg",
    default=r"SUMO\nets\intersection.sumocfg",
    )

    parser.add_argument(
        "--model",
        default=r"Model\final_model.pt",
    )

    parser.add_argument(
        "--preprocessor",
        default=r"Model\preprocessor.joblib",
    )

    parser.add_argument(
        "--output",
        default="final_results.json",
    )

    parser.add_argument(
        "--sumo-binary",
        default=None,
        help="Full path to sumo/sumo-gui executable",
    )

    parser.add_argument(
        "--gui",
        action="store_true",
        help="Run SUMO GUI. Omit for maximum speed.",
    )

    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="SUMO random seed. Required so matched controllers can use the exact same traffic realization.",
    )

    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress periodic console progress.",
    )

    args = parser.parse_args()

    run(args)


if __name__ == "__main__":
    main()