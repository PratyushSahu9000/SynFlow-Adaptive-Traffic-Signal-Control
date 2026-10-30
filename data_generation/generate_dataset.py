# !/usr/bin/env python3
"""
NeSy Traffic Dataset Generator for the uploaded 4-lane SUMO intersection.

Network assumptions from intersection.net.xml:
- traffic light id: center
- incoming edges: south_in, east_in, north_in, west_in
- 2 incoming lanes per approach
- static signal phases:
    phase 0: south/east movement group green
    phase 1: yellow
    phase 2: north/west movement group green
    phase 3: yellow

This script:
1. Generates many varied route files.
2. Runs SUMO headlessly through TraCI.
3. Samples traffic state every SAMPLE_INTERVAL seconds.
4. Collects queue, waiting time, speed, density, arrivals,
   departures, pressure and signal-state features.
5. Creates a teacher target_action for the first MLP dataset.
6. Writes one CSV per scenario and a combined CSV.

Install:
    pip install traci sumolib pandas

Run:
    python generate_dataset.py
"""

import argparse
import csv
import random
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pandas as pd

try:
    import traci
except ImportError:
    print("Install TraCI first: pip install traci sumolib")
    raise


# -----------------------------
# Configuration
# -----------------------------

BASE_DIR = Path(__file__).resolve().parent.parent
SUMO_HOME = Path(r"E:\SUMO")
NET_FILE = BASE_DIR / "SUMO" / "nets" / "intersection.net.xml"
VEHICLE_TYPES_FILE = BASE_DIR / "SUMO" / "vehicle_types.add.xml"
RANDOM_TRIPS = SUMO_HOME / "tools" / "randomTrips.py"
TLS_ID = "center"

INCOMING = {
    "north": "north_in",
    "south": "south_in",
    "east": "east_in",
    "west": "west_in",
}

# Existing network has 2 incoming lanes per approach.
LANES = {
    direction: [f"{edge}_0", f"{edge}_1"]
    for direction, edge in INCOMING.items()
}

# Valid non-U-turn movements observed in the supplied route files.
ROUTES = {
    "north": ["south", "east", "west"],
    "south": ["north", "east", "west"],
    "east": ["north", "south", "west"],
    "west": ["north", "south", "east"],
}

# The supplied signal has two green groups:
# phase 0 -> south + east
# phase 2 -> north + west
GREEN_GROUPS = {
    0: {"south", "east"},
    2: {"north", "west"},
}

YELLOW_PHASES = {1, 3}

# Dataset sampling.
SAMPLE_INTERVAL = 5.0

# A vehicle is considered queued when its speed is below this value.
QUEUE_SPEED = 1.0

# Teacher-policy parameters.
MIN_GREEN = 10.0
MAX_GREEN = 60.0
SWITCH_RATIO = 1.15

# Route generation ranges.
MIN_DEMAND = 900
MAX_DEMAND = 3600

EMERGENCY_PENETRATION = 0.05
EMERGENCY_TYPE_WEIGHTS = {
    "ambulance": 0.50,
    "firetruck": 0.25,
    "police": 0.25,
}


# -----------------------------
# Route generation
# -----------------------------

def generate_routes(output_file, duration, seed, demand_level):
    """Generate SUMO-routed traffic using randomTrips.py.

    The demand level controls the approximate vehicle arrival rate; SUMO
    generates valid trips from the actual network and duarouter validates
    and routes them. Emergency types are assigned after route generation.
    """
    if not RANDOM_TRIPS.is_file():
        raise FileNotFoundError(f"randomTrips.py not found: {RANDOM_TRIPS}")
    if not Path(NET_FILE).is_file():
        raise FileNotFoundError(f"Network not found: {NET_FILE}")

    period = 3600.0 / max(float(demand_level), 1.0)

    cmd = [
        sys.executable,
        str(RANDOM_TRIPS),
        "-n", str(NET_FILE),
        "-b", "0",
        "-e", str(duration),
        "-p", f"{period:.6f}",
        "--route-file", str(output_file),
        "--trip-attributes",
        'departLane="best" departSpeed="max" departPos="random"',
        "--vehicle-class", "passenger",
        "--seed", str(seed),
        "--validate",
    ]

    print(f"    SUMO randomTrips: demand≈{demand_level}/h period={period:.3f}s")

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr)
        raise RuntimeError(f"randomTrips.py failed with exit code {result.returncode}")

    assign_vehicle_types(output_file, EMERGENCY_PENETRATION, seed)

    tree = ET.parse(output_file)
    return len(tree.getroot().findall("vehicle"))


def assign_vehicle_types(route_file, emergency_penetration, seed):
    """Assign passenger/emergency types to SUMO-generated vehicles."""
    tree = ET.parse(route_file)
    root = tree.getroot()
    vehicles = root.findall("vehicle")

    if not vehicles:
        print(f"    WARNING: No vehicles found in {route_file}")
        return

    rng = random.Random(seed)
    emergency_count = round(len(vehicles) * emergency_penetration)
    emergency_indices = set(rng.sample(range(len(vehicles)),
                                       min(emergency_count, len(vehicles))))

    emergency_types = list(EMERGENCY_TYPE_WEIGHTS.keys())
    emergency_weights = list(EMERGENCY_TYPE_WEIGHTS.values())
    counts = {name: 0 for name in emergency_types}

    for index, vehicle in enumerate(vehicles):
        if index in emergency_indices:
            vehicle_type = rng.choices(emergency_types,
                                       weights=emergency_weights, k=1)[0]
            counts[vehicle_type] += 1
        else:
            vehicle_type = "passenger"
        vehicle.set("type", vehicle_type)

    tree.write(route_file, encoding="UTF-8", xml_declaration=True)

    print(
        f"    Vehicle composition: {len(vehicles) - emergency_count} passenger, "
        f"{counts.get('ambulance', 0)} ambulance, "
        f"{counts.get('firetruck', 0)} firetruck, "
        f"{counts.get('police', 0)} police"
    )


# -----------------------------
# Traffic measurements
# -----------------------------

def vehicle_direction(veh_id):
    """
    Determine the approach currently associated with a vehicle.

    We use its current lane/edge. Vehicles on internal edges are ignored
    for approach-level aggregation.
    """
    try:
        lane = traci.vehicle.getLaneID(veh_id)
    except traci.TraCIException:
        return None

    for direction, edge in INCOMING.items():
        if lane == f"{edge}_0" or lane == f"{edge}_1":
            return direction

    return None


def approach_metrics(direction):
    edge = INCOMING[direction]
    lanes = LANES[direction]

    vehicle_ids = traci.edge.getLastStepVehicleIDs(edge)

    count = len(vehicle_ids)

    if count == 0:
        return {
            "vehicles": 0,
            "queue": 0,
            "waiting": 0.0,
            "speed": 0.0,
            "density": 0.0,
            "emergency": 0,
            "ambulance": 0,
            "firetruck": 0,
            "police": 0,
            "emergency_waiting": 0.0,
            "max_emergency_waiting": 0.0,
        }

    speeds = []
    waits = []
    queued = 0

    emergency_count = 0
    ambulance_count = 0
    firetruck_count = 0
    police_count = 0
    emergency_waits = []

    for vid in vehicle_ids:
        try:
            speed = traci.vehicle.getSpeed(vid)
            wait = traci.vehicle.getAccumulatedWaitingTime(vid)
            vehicle_type = traci.vehicle.getTypeID(vid)

            speeds.append(speed)
            waits.append(wait)

            if speed < QUEUE_SPEED:
                queued += 1

            if vehicle_type in EMERGENCY_TYPE_WEIGHTS:
                emergency_count += 1
                emergency_waits.append(wait)

                if vehicle_type == "ambulance":
                    ambulance_count += 1
                elif vehicle_type == "firetruck":
                    firetruck_count += 1
                elif vehicle_type == "police":
                    police_count += 1

        except traci.TraCIException:
            pass

    # 2 lanes x 289.6 m = 0.5792 km lane-length.
    lane_km = (2 * 289.6) / 1000.0
    density = count / lane_km if lane_km > 0 else 0.0

    return {
        "vehicles": count,
        "queue": queued,
        "waiting": sum(waits) / len(waits) if waits else 0.0,
        "speed": sum(speeds) / len(speeds) if speeds else 0.0,
        "density": density,
        "emergency": emergency_count,
        "ambulance": ambulance_count,
        "firetruck": firetruck_count,
        "police": police_count,
        "emergency_waiting": (
            sum(emergency_waits) / len(emergency_waits)
            if emergency_waits else 0.0
        ),
        "max_emergency_waiting": max(emergency_waits) if emergency_waits else 0.0,
    }


def count_edge_arrivals_departures():
    """
    Use TraCI's last-step vehicle IDs to estimate arrivals/departures
    on the four incoming edges.
    """
    result = {}

    for direction, edge in INCOMING.items():
        try:
            result[f"{direction}_arrivals"] = len(
                traci.edge.getLastStepVehicleIDs(edge)
            )
        except traci.TraCIException:
            result[f"{direction}_arrivals"] = 0

    return result


def calculate_pressure(metrics):
    pressure = {}

    for direction in INCOMING:
        # Simple incoming pressure. Later we can replace this with
        # lane/turn-specific pressure.
        pressure[direction] = (
            metrics[direction]["queue"]
            + 0.05 * metrics[direction]["waiting"]
        )

    return pressure


def teacher_action(phase, phase_time, pressure):
    """
    First-generation teacher label.

    0 = keep current phase
    1 = switch to the other green phase

    This is deliberately a simple teacher. It is NOT the final NeSy
    policy. It gives the MLP an initial supervised-learning target.
    """
    if phase not in GREEN_GROUPS:
        return 0

    if phase_time < MIN_GREEN:
        return 0

    current_group = GREEN_GROUPS[phase]
    other_group = set(INCOMING) - current_group

    current_pressure = sum(pressure[d] for d in current_group)
    other_pressure = sum(pressure[d] for d in other_group)

    if phase_time >= MAX_GREEN:
        return 1

    if other_pressure > max(current_pressure * SWITCH_RATIO, 1.0):
        return 1

    return 0


# -----------------------------
# Simulation
# -----------------------------

def run_scenario(
    scenario_id,
    route_file,
    net_file,
    output_csv,
    duration,
    seed,
    sumo_binary,
):
    rows = []

    cmd = [
        sumo_binary,
        "-n",
        str(net_file),
        "-r",
        str(route_file),
        "--additional-files",
        str(VEHICLE_TYPES_FILE),
        "--seed",
        str(seed),
        "--no-step-log",
        "true",
        "--duration-log.disable",
        "true",
    ]

    traci.start(cmd)

    last_phase = None
    phase_start_time = 0.0
    previous_counts = {d: 0 for d in INCOMING}

    try:
        step = 0.0
        next_sample = 0.0

        while traci.simulation.getMinExpectedNumber() > 0:
            traci.simulationStep()

            step = traci.simulation.getTime()

            if step < next_sample:
                continue

            next_sample += SAMPLE_INTERVAL

            phase = traci.trafficlight.getPhase(TLS_ID)

            if phase != last_phase:
                phase_start_time = step
                last_phase = phase

            phase_time = step - phase_start_time

            metrics = {
                d: approach_metrics(d)
                for d in INCOMING
            }

            pressure = calculate_pressure(metrics)

            current_counts = {
                d: metrics[d]["vehicles"]
                for d in INCOMING
            }

            # Approximate changes in vehicles present on each incoming edge.
            arrivals = {
                d: max(current_counts[d] - previous_counts[d], 0)
                for d in INCOMING
            }

            departures = {
                d: max(previous_counts[d] - current_counts[d], 0)
                for d in INCOMING
            }

            previous_counts = current_counts

            action = teacher_action(
                phase,
                phase_time,
                pressure,
            )

            row = {
                "scenario_id": scenario_id,
                "seed": seed,
                "time": step,
                "phase": phase,
                "phase_time": phase_time,
                "target_action": action,
            }

            for direction in INCOMING:
                row[f"{direction}_vehicles"] = metrics[direction]["vehicles"]
                row[f"{direction}_queue"] = metrics[direction]["queue"]
                row[f"{direction}_waiting"] = metrics[direction]["waiting"]
                row[f"{direction}_speed"] = metrics[direction]["speed"]
                row[f"{direction}_density"] = metrics[direction]["density"]
                row[f"{direction}_pressure"] = pressure[direction]
                row[f"{direction}_arrivals"] = arrivals[direction]
                row[f"{direction}_departures"] = departures[direction]

                # Emergency-vehicle state observed directly from SUMO.
                row[f"{direction}_emergency"] = metrics[direction]["emergency"]
                row[f"{direction}_emergency_waiting"] = (
                    metrics[direction]["emergency_waiting"]
                )
                row[f"{direction}_max_emergency_waiting"] = (
                    metrics[direction]["max_emergency_waiting"]
                )

            # Global emergency composition, derived from SUMO vehicle types.
            row["total_emergency"] = sum(
                metrics[d]["emergency"] for d in INCOMING
            )
            row["ambulance_count"] = sum(
                metrics[d]["ambulance"] for d in INCOMING
            )
            row["firetruck_count"] = sum(
                metrics[d]["firetruck"] for d in INCOMING
            )
            row["police_count"] = sum(
                metrics[d]["police"] for d in INCOMING
            )
            row["total_emergency_waiting"] = sum(
                metrics[d]["emergency_waiting"] for d in INCOMING
            )
            row["max_emergency_waiting"] = max(
                metrics[d]["max_emergency_waiting"] for d in INCOMING
            )

            row["total_queue"] = sum(
                metrics[d]["queue"] for d in INCOMING
            )

            row["total_vehicles"] = sum(
                metrics[d]["vehicles"] for d in INCOMING
            )

            row["total_waiting"] = sum(
                metrics[d]["waiting"] for d in INCOMING
            )

            row["max_queue"] = max(
                metrics[d]["queue"] for d in INCOMING
            )

            row["queue_imbalance"] = max(
                metrics[d]["queue"] for d in INCOMING
            ) - min(
                metrics[d]["queue"] for d in INCOMING
            )

            rows.append(row)

    finally:
        traci.close()

    if rows:
        pd.DataFrame(rows).to_csv(
            output_csv,
            index=False,
        )

    return len(rows)


# -----------------------------
# Main dataset generation
# -----------------------------

def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--net",
        default=NET_FILE,
    )

    parser.add_argument(
        "--output",
        default=str(BASE_DIR / "dataset"),
    )

    parser.add_argument(
        "--scenarios",
        type=int,
        default=300,
    )

    parser.add_argument(
        "--duration",
        type=float,
        default=3600.0,
    )

    parser.add_argument(
        "--seed",
        type=int,
        default=1000,
    )

    parser.add_argument(
        "--sumo",
        default="sumo",
        help="SUMO binary. Use sumo-gui if you want to inspect a run.",
    )

    args = parser.parse_args()

    output_dir = Path(args.output)
    route_dir = output_dir / "routes"
    data_dir = output_dir / "scenarios"

    route_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    all_files = []
    summary = []

    rng = random.Random(args.seed)

    for i in range(args.scenarios):
        scenario_seed = args.seed + i

        # Cover light -> heavy traffic rather than producing only one demand.
        demand = rng.randint(MIN_DEMAND, MAX_DEMAND)

        route_file = route_dir / f"scenario_{i:04d}.rou.xml"
        output_csv = data_dir / f"scenario_{i:04d}.csv"

        n_vehicles = generate_routes(
            route_file,
            args.duration,
            scenario_seed,
            demand,
        )

        print(
            f"[{i + 1}/{args.scenarios}] "
            f"scenario={i:04d} "
            f"demand={demand}/h "
            f"vehicles={n_vehicles}"
        )

        samples = run_scenario(
            scenario_id=i,
            route_file=route_file,
            net_file=args.net,
            output_csv=output_csv,
            duration=args.duration,
            seed=scenario_seed,
            sumo_binary=args.sumo,
        )

        all_files.append(output_csv)

        summary.append({
            "scenario_id": i,
            "seed": scenario_seed,
            "demand_per_hour": demand,
            "vehicles": n_vehicles,
            "samples": samples,
        })

    summary_df = pd.DataFrame(summary)
    summary_df.to_csv(
        output_dir / "scenario_summary.csv",
        index=False,
    )

    if all_files:
        combined = pd.concat(
            [pd.read_csv(f) for f in all_files],
            ignore_index=True,
        )

        combined.to_csv(
            output_dir / "traffic_dataset.csv",
            index=False,
        )

        print("\nDataset complete.")
        print(f"Rows: {len(combined):,}")
        print(f"Columns: {len(combined.columns)}")
        print(f"Saved: {output_dir / 'traffic_dataset.csv'}")


if __name__ == "__main__":
    main()