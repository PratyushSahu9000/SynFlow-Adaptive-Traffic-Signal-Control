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
MIN_GREEN = 10
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

# Maps the six standard symbolic-rule report categories onto the existing,
# already-present rule names produced by SynFlowController.choose_group().
# No new rule names are invented; this only groups the existing ones for the
# compact final report.
SYMBOLIC_RULE_BUCKETS = {
    "emergency_priority": ("emergency_priority_keep", "emergency_priority_override"),
    "minimum_green": ("safety_min_green",),
    "congestion_imbalance": ("congestion_imbalance_override",),
    "maximum_waiting": ("max_wait_override",),
    "fairness": ("fairness_starvation_override",),
    "maximum_green": ("max_green_force_switch",),
}

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
        self.nesy_decisions = 0
        self.symbolic_overrides = 0

        # MLP vs final NeSy decision analysis
        self.mlp_agreement_count = 0
        self.mlp_disagreement_count = 0

        # Compact NeSy explainability: running counters per rule plus a
        # small bounded set of representative override examples, instead of
        # a full per-decision audit trail.
        self.override_rule_counts = defaultdict(int)
        self.override_examples = []
        self.max_override_examples = 8

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
    # Neuro-symbolic decision layer
    # ---------------------------

    def choose_group(self, raw_state: dict, scores: np.ndarray) -> tuple[str, str]:
        """Combine the MLP recommendation with explicit symbolic rules.

        In addition to selecting the final group, this method records a
        machine-readable explanation for every decision. This is intended
        for NeSy explainability: it shows what the neural model recommended,
        which symbolic rule was evaluated, what evidence triggered it, and
        whether the final action actually overrode the MLP.
        """
        self.nesy_decisions += 1

        now = float(self.traci.simulation.getTime())
        elapsed = self.phase_elapsed(now)
        current = self.current_green_group()

        ns_wait = max(
            raw_state["north_waiting"],
            raw_state["south_waiting"]
        )
        ew_wait = max(
            raw_state["east_waiting"],
            raw_state["west_waiting"]
        )

        ns_score = float(scores[0] + scores[1])
        ew_score = float(scores[2] + scores[3])
        mlp_recommended = "NS" if ns_score >= ew_score else "EW"

        ns_queue = (
            float(raw_state["north_queue"]) +
            float(raw_state["south_queue"])
        )
        ew_queue = (
            float(raw_state["east_queue"]) +
            float(raw_state["west_queue"])
        )
        ns_wait_total = (
            float(raw_state["north_waiting"]) +
            float(raw_state["south_waiting"])
        )
        ew_wait_total = (
            float(raw_state["east_waiting"]) +
            float(raw_state["west_waiting"])
        )

        queue_ratio_ns = ns_queue / max(ew_queue, 1.0)
        queue_ratio_ew = ew_queue / max(ns_queue, 1.0)
        wait_ratio_ns = ns_wait_total / max(ew_wait_total, 1.0)
        wait_ratio_ew = ew_wait_total / max(ns_wait_total, 1.0)

        # Emergency evidence is deliberately outside the MLP input.
        emergency_vehicles = self._current_emergency_vehicles()
        waiting_emergencies = [
            v for v in emergency_vehicles
            if v["waiting_seconds"] >= 1.0 and v["speed_mps"] <= 0.5
        ]

        def finish(final_group: str, rule: str, reason: str = "") -> tuple[str, str]:
            """Record a compact explanation before returning the decision.

            Only running counters plus a small bounded set of representative
            examples are kept -- not a full per-decision audit trail. This
            preserves the same symbolic-override accounting (which rule
            fired, whether it actually changed the MLP recommendation)
            without storing a record for every 5-second decision tick.
            """
            actual_override = final_group != mlp_recommended
            if actual_override:
                self.symbolic_overrides += 1
                self.mlp_disagreement_count += 1
                self.override_rule_counts[rule] += 1

                if len(self.override_examples) < self.max_override_examples:
                    self.override_examples.append({
                        "time_seconds": now,
                        "mlp_recommended": mlp_recommended,
                        "final_decision": final_group,
                        "rule": rule,
                        "reason": reason,
                    })
            else:
                self.mlp_agreement_count += 1        

            return final_group, rule

        # ------------------------------------------------------------
        # 1. Emergency priority
        # ------------------------------------------------------------
        if waiting_emergencies:
            priority_vehicle = max(
                waiting_emergencies,
                key=lambda v: v["waiting_seconds"]
            )
            emergency_group = priority_vehicle["group"]

            if current == emergency_group:
                self.rule_counts["emergency_priority_keep"] += 1
                return finish(
                    emergency_group,
                    "emergency_priority_keep",
                    f"Emergency vehicle {priority_vehicle.get('id', '')} "
                    f"({priority_vehicle.get('type', '')}) is waiting on "
                    f"{emergency_group}; that group is already green."
                )

            self.rule_counts["emergency_priority_override"] += 1
            return finish(
                emergency_group,
                "emergency_priority_override",
                f"Emergency vehicle {priority_vehicle.get('id', '')} "
                f"({priority_vehicle.get('type', '')}) has been waiting "
                f"{float(priority_vehicle.get('waiting_seconds', 0.0)):.1f}s "
                f"on {emergency_group}; symbolic safety priority selects "
                f"{emergency_group} instead of the MLP recommendation."
            )

        # ------------------------------------------------------------
        # 2. Minimum-green safety
        # ------------------------------------------------------------
        if current is not None and elapsed < MIN_GREEN:
            self.rule_counts["safety_min_green"] += 1
            return finish(
                current,
                "safety_min_green",
                f"Current {current} green has only lasted {elapsed:.1f}s; "
                f"minimum green is {MIN_GREEN}s, so switching is blocked."
            )

        # ------------------------------------------------------------
        # 3. Strong congestion imbalance
        # ------------------------------------------------------------
        if (
            current == "EW"
            and ns_queue - ew_queue >= 8.0
            and queue_ratio_ns >= 1.8
            and ns_wait_total - ew_wait_total >= 20.0
            and ns_wait_total >= 30.0
        ):
            self.rule_counts["congestion_imbalance_override"] += 1
            return finish(
                "NS",
                "congestion_imbalance_override",
                "NS has a strong queue/wait imbalance over EW "
                "(difference, ratio, and waiting thresholds all satisfied)."
            )

        if (
            current == "NS"
            and ew_queue - ns_queue >= 8.0
            and queue_ratio_ew >= 1.8
            and ew_wait_total - ns_wait_total >= 20.0
            and ew_wait_total >= 30.0
        ):
            self.rule_counts["congestion_imbalance_override"] += 1
            return finish(
                "EW",
                "congestion_imbalance_override",
                "EW has a strong queue/wait imbalance over NS "
                "(difference, ratio, and waiting thresholds all satisfied)."
            )

        # ------------------------------------------------------------
        # 4. Maximum waiting / fairness
        # ------------------------------------------------------------
        if ns_wait >= MAX_WAIT_THRESHOLD and current != "NS":
            self.rule_counts["max_wait_override"] += 1
            return finish(
                "NS",
                "max_wait_override",
                f"NS maximum observed waiting time reached "
                f"{ns_wait:.1f}s, exceeding the {MAX_WAIT_THRESHOLD}s limit."
            )

        if ew_wait >= MAX_WAIT_THRESHOLD and current != "EW":
            self.rule_counts["max_wait_override"] += 1
            return finish(
                "EW",
                "max_wait_override",
                f"EW maximum observed waiting time reached "
                f"{ew_wait:.1f}s, exceeding the {MAX_WAIT_THRESHOLD}s limit."
            )

        # ------------------------------------------------------------
        # 5. Starvation / fairness
        # ------------------------------------------------------------
        if (
            current == "EW"
            and ns_wait_total >= 60.0
            and ns_wait_total >= ew_wait_total * 1.7
            and wait_ratio_ns >= 1.7
        ):
            self.rule_counts["fairness_starvation_override"] += 1
            return finish(
                "NS",
                "fairness_starvation_override",
                "NS accumulated waiting is at least 60s and at least "
                "1.7x EW, so the symbolic fairness rule prevents starvation."
            )

        if (
            current == "NS"
            and ew_wait_total >= 60.0
            and ew_wait_total >= ns_wait_total * 1.7
            and wait_ratio_ew >= 1.7
        ):
            self.rule_counts["fairness_starvation_override"] += 1
            return finish(
                "EW",
                "fairness_starvation_override",
                "EW accumulated waiting is at least 60s and at least "
                "1.7x NS, so the symbolic fairness rule prevents starvation."
            )

        # ------------------------------------------------------------
        # 6. Maximum green / phase safety
        # ------------------------------------------------------------
        if current == "NS" and elapsed >= MAX_GREEN:
            self.rule_counts["max_green_force_switch"] += 1
            return finish(
                "EW",
                "max_green_force_switch",
                f"NS green reached {elapsed:.1f}s, the {MAX_GREEN}s maximum, "
                "so the symbolic safety rule forces a switch to EW."
            )

        if current == "EW" and elapsed >= MAX_GREEN:
            self.rule_counts["max_green_force_switch"] += 1
            return finish(
                "NS",
                "max_green_force_switch",
                f"EW green reached {elapsed:.1f}s, the {MAX_GREEN}s maximum, "
                "so the symbolic safety rule forces a switch to NS."
            )

        # ------------------------------------------------------------
        # 7. Neural recommendation
        # ------------------------------------------------------------
        self.rule_counts["mlp_recommendation"] += 1
        return finish(
            mlp_recommended,
            "mlp_recommendation",
            "No higher-priority symbolic rule required a different action."
        )

    def desired_green(self, raw_state: dict, scores: np.ndarray, group: str) -> int:
        if group == "NS":
            demand = (
                float(scores[0]) +
                float(scores[1]) +
                min(raw_state["north_queue"] + raw_state["south_queue"], 60.0) / 60.0
            )
        else:
            demand = (
                float(scores[2]) +
                float(scores[3]) +
                min(raw_state["east_queue"] + raw_state["west_queue"], 60.0) / 60.0
            )

        # Map demand into a stable 5..60 second range.
        # Higher demand gets more green; this avoids rapid oscillation.
        green = int(round(10.0 + 20.0 * min(demand, 2.0)))
        return max(MIN_GREEN, min(MAX_GREEN, green))

    # ---------------------------
    # Applying a decision
    # ---------------------------

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
            if remaining >= MIN_GREEN:
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

        # Aggregate the existing granular override-rule names into the six
        # symbolic rule categories, without renaming the underlying rules.
        symbolic_rule_counts = {
            bucket: sum(self.override_rule_counts.get(key, 0) for key in keys)
            for bucket, keys in SYMBOLIC_RULE_BUCKETS.items()
        }

        return {
            "controller": "nesy",
            "sumo_seed": self.sumo_seed,
            "simulation_duration_seconds": SIMULATION_DURATION,
            "total": {
                "average_queue_length": total_queue,
            },
            "directions": self.directional_metrics(),
            "signal": {"switches": self.switch_count},
            "runtime": {"wall_clock_seconds": runtime_seconds},
            "mlp": {
                "decisions": self.mlp_decisions,
                "agreement_count": self.mlp_agreement_count,
                "disagreement_count": self.mlp_disagreement_count,
                "agreement_rate": (
                    self.mlp_agreement_count / self.mlp_decisions * 100
                    if self.mlp_decisions else 0.0
                ),
            },
            "symbolic": {
                "total_overrides": self.symbolic_overrides,
                "rule_counts": symbolic_rule_counts,
                "override_rate": (
                    self.symbolic_overrides / self.mlp_decisions * 100
                    if self.mlp_decisions else 0.0
                ),
            },
            "explainability": {
                "mlp_decisions": self.mlp_decisions,
                "symbolic_overrides": self.symbolic_overrides,
                "override_reasons": symbolic_rule_counts,
                "examples": self.override_examples,
            },
            "rule_counts": dict(self.rule_counts),
            "nesy_decisions": self.nesy_decisions,
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
    print("SynFlow — Neuro-Symbolic SUMO Controller")
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
        description="SynFlow neuro-symbolic SUMO/TraCI controller"
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