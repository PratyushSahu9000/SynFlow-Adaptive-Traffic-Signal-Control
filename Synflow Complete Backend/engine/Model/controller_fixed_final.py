"""
Fixed-time SUMO traffic signal controller (optimized final version).

Purpose:
    Baseline controller using ONLY SUMO/TraCI traffic-signal control.
    No neural network, no model, no preprocessor, and no NeSy rules.

The controller alternates:
    NS green -> NS yellow -> EW green -> EW yellow

The green durations are fixed and do not depend on traffic state.
Traffic is still simulated by SUMO and all measurements/statistics are
collected through TraCI for comparison with the other controllers.

This is the optimized final version used for the matched experiments. The
fixed-time control logic (phase order, phase-change conditions, durations)
is unchanged from the original controller. The only changes are:
    - per-step metric histories are replaced with running accumulators
    - per-direction (north/south/east/west) queue/waiting/throughput are
      reported using the incoming lane and tripinfo data
    - the final JSON matches the compact schema shared with the NN and
      NeSy controllers so the three can be compared directly

Matched-experiment usage:
    python controller_fixed_final.py --seed 1253739331

Arguments:
    --sumocfg       SUMO configuration file
    --seed          SUMO random seed
    --duration      simulation duration in seconds
    --green-time    fixed green duration for each direction
    --yellow-time   yellow duration
    --output        output JSON path
    --sumo-binary   sumo or sumo-gui
    --quiet         suppress SUMO console output
"""

import argparse
import json
import os
import time
from pathlib import Path

import traci


TLS_ID = "center"

NS_GREEN = 0
NS_YELLOW = 1
EW_GREEN = 2
EW_YELLOW = 3

# Direction label for each incoming edge; SUMO lane IDs have an index suffix.
LANE_DIRECTION = {
    "north_in": "north",
    "south_in": "south",
    "east_in": "east",
    "west_in": "west",
}
DIRECTIONS = ("north", "south", "east", "west")

SIMULATION_DURATION = 3600
FIXED_GREEN_TIME = 30
YELLOW_TIME = 3


def parse_args():
    parser = argparse.ArgumentParser(description="Fixed-time SUMO controller")
    parser.add_argument(
        "--sumocfg",
        default=os.path.join("SUMO", "nets", "intersection.sumocfg"),
    )
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--duration", type=int, default=SIMULATION_DURATION)
    parser.add_argument("--green-time", type=int, default=FIXED_GREEN_TIME)
    parser.add_argument("--yellow-time", type=int, default=YELLOW_TIME)
    parser.add_argument("--output", default=None)
    parser.add_argument("--tripinfo-output", default=None)
    parser.add_argument("--sumo-binary", default="sumo")
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args()


def safe_lane_value(fn, lane_id, default=0.0):
    try:
        return float(fn(lane_id))
    except Exception:
        return default


def lane_direction(lane_id):
    for edge_id, direction in LANE_DIRECTION.items():
        if lane_id.startswith(f"{edge_id}_"):
            return direction
    return None


def get_metrics():
    """Collect one step's traffic measurements from SUMO only.

    Returns a small fixed-size dict (never accumulated into a growing
    history) so the caller can fold the values into running sums.
    """
    try:
        lanes = list(traci.lane.getIDList())
    except Exception:
        return None

    valid_lanes = [lane for lane in lanes if lane_direction(lane) is not None]
    if not valid_lanes:
        # Fall back to all incoming lanes if the configured names differ.
        valid_lanes = lanes

    total_queue = 0.0
    total_waiting = 0.0
    speed_sum = 0.0
    speed_count = 0
    dir_queue = {d: 0.0 for d in DIRECTIONS}

    for lane in valid_lanes:
        queue = safe_lane_value(traci.lane.getLastStepHaltingNumber, lane)
        waiting = safe_lane_value(traci.lane.getWaitingTime, lane)
        speed = safe_lane_value(traci.lane.getLastStepMeanSpeed, lane)

        total_queue += queue
        total_waiting += waiting

        if speed > 0:
            speed_sum += speed
            speed_count += 1

        direction = lane_direction(lane)
        if direction is not None:
            dir_queue[direction] += queue

    return {
        "queue": total_queue,
        "waiting": total_waiting,
        "mean_speed": speed_sum / speed_count if speed_count else 0.0,
        "dir_queue": dir_queue,
    }


def calculate_trip_metrics(tripinfo_path):
    """Calculate the same vehicle-level metrics used by the NN/NeSy controllers."""
    import xml.etree.ElementTree as ET
    import numpy as np

    direction_waiting = {d: [] for d in DIRECTIONS}

    if not tripinfo_path.exists():
        return {
            "completed_vehicles": 0,
            "avg_waiting_time": 0.0,
            "avg_time_loss": 0.0,
            "avg_duration": 0.0,
            "avg_speed": 0.0,
            "throughput": 0,
            "directions": {
                d: {"average_waiting_time": 0.0, "throughput": 0}
                for d in DIRECTIONS
            },
        }

    root = ET.parse(tripinfo_path).getroot()
    trips = root.findall(".//tripinfo")

    def f(element, attr):
        try:
            return float(element.attrib.get(attr, 0.0))
        except (TypeError, ValueError):
            return 0.0

    waiting = [f(x, "waitingTime") for x in trips]
    time_loss = [f(x, "timeLoss") for x in trips]
    durations = [f(x, "duration") for x in trips]
    route_lengths = [f(x, "routeLength") for x in trips]

    for trip in trips:
        direction = lane_direction(trip.attrib.get("departLane", ""))
        if direction is not None:
            direction_waiting[direction].append(f(trip, "waitingTime"))

    speeds = [
        route_lengths[i] / durations[i]
        if durations[i] > 0 else 0.0
        for i in range(len(trips))
    ]

    return {
        "completed_vehicles": len(trips),
        "avg_waiting_time": float(np.mean(waiting)) if trips else 0.0,
        "avg_time_loss": float(np.mean(time_loss)) if trips else 0.0,
        "avg_duration": float(np.mean(durations)) if trips else 0.0,
        "avg_speed": float(np.mean(speeds)) if trips else 0.0,
        "throughput": len(trips),
        "directions": {
            d: {
                "average_waiting_time": (
                    float(np.mean(direction_waiting[d])) if direction_waiting[d] else 0.0
                ),
                "throughput": len(direction_waiting[d]),
            }
            for d in DIRECTIONS
        },
    }


def run(args):
    sumo_binary = args.sumo_binary

    if not Path(args.sumocfg).exists():
        raise FileNotFoundError(f"SUMO config not found: {args.sumocfg}")

    if args.green_time <= 0:
        raise ValueError("--green-time must be greater than 0")
    if args.yellow_time < 0:
        raise ValueError("--yellow-time cannot be negative")

    # Seed is supplied by the matched experiment runner so all controllers
    # receive exactly the same SUMO seed.
    seed = int(args.seed)

    sumo_cmd = [
        sumo_binary,
        "-c",
        args.sumocfg,
        "--seed",
        str(seed),
        "--no-step-log",
        "true",
        "--duration-log.disable",
        "true",
    ]

    tripinfo_path = Path(args.tripinfo_output) if args.tripinfo_output else Path("tripinfo_runtime.xml")
    tripinfo_path.parent.mkdir(parents=True, exist_ok=True)
    sumo_cmd += ["--tripinfo-output", str(tripinfo_path), "--tripinfo-output.write-unfinished", "false"]

    if args.quiet:
        sumo_cmd += ["--verbose", "false"]

    print("=" * 60)
    print("FIXED-TIME CONTROLLER")
    print("=" * 60)
    print(f"SUMO config : {args.sumocfg}")
    print(f"SUMO seed   : {seed}")
    print(f"Green time  : {args.green_time}s")
    print(f"Yellow time : {args.yellow_time}s")
    print(f"Duration    : {args.duration}s")
    print()

    traci.start(sumo_cmd)

    start_time = time.time()

    # Force a known starting phase.
    traci.trafficlight.setPhase(TLS_ID, NS_GREEN)

    current_phase = NS_GREEN
    phase_start = 0.0
    phase_changes = 0

    # Running accumulators only -- no per-step metric history is stored.
    step_count = 0
    queue_sum = 0.0
    waiting_sum = 0.0
    dir_queue_sum = {d: 0.0 for d in DIRECTIONS}

    try:
        sim_time = 0.0

        while sim_time < args.duration:
            traci.simulationStep()
            sim_time = float(traci.simulation.getTime())
            sample_waiting = int(sim_time) % 5 == 0

            # Collect measurements, but NEVER use them to control the signal.
            if sample_waiting:
                metrics = get_metrics()
                if metrics is not None:
                    step_count += 1
                    queue_sum += metrics["queue"]
                    waiting_sum += metrics["waiting"]

                    for d in DIRECTIONS:
                        dir_queue_sum[d] += metrics["dir_queue"][d]

            elapsed = sim_time - phase_start

            if current_phase == NS_GREEN and elapsed >= args.green_time:
                traci.trafficlight.setPhase(TLS_ID, NS_YELLOW)
                current_phase = NS_YELLOW
                phase_start = sim_time
                phase_changes += 1

            elif current_phase == NS_YELLOW and elapsed >= args.yellow_time:
                traci.trafficlight.setPhase(TLS_ID, EW_GREEN)
                current_phase = EW_GREEN
                phase_start = sim_time
                phase_changes += 1

            elif current_phase == EW_GREEN and elapsed >= args.green_time:
                traci.trafficlight.setPhase(TLS_ID, EW_YELLOW)
                current_phase = EW_YELLOW
                phase_start = sim_time
                phase_changes += 1

            elif current_phase == EW_YELLOW and elapsed >= args.yellow_time:
                traci.trafficlight.setPhase(TLS_ID, NS_GREEN)
                current_phase = NS_GREEN
                phase_start = sim_time
                phase_changes += 1

    finally:
        try:
            traci.close()
        except Exception:
            pass

    runtime = time.time() - start_time

    average_queue = queue_sum / step_count if step_count else 0.0

    trip_metrics = calculate_trip_metrics(tripinfo_path)

    directions = {}
    for d in DIRECTIONS:
        direction_trip_metrics = trip_metrics["directions"][d]
        directions[d] = {
            "average_waiting_time": direction_trip_metrics["average_waiting_time"],
            "average_queue_length": dir_queue_sum[d] / step_count if step_count else 0.0,
            "throughput": direction_trip_metrics["throughput"],
        }

    result = {
        "controller": "fixed",
        "simulation_duration_seconds": args.duration,
        "total": {
            "average_waiting_time": trip_metrics["avg_waiting_time"],
            "average_queue_length": average_queue,
            "average_speed": trip_metrics["avg_speed"],
            "avg_time_loss": trip_metrics["avg_time_loss"],
            "avg_duration": trip_metrics["avg_duration"],
            "throughput": trip_metrics["throughput"],
        },
        "directions": directions,
        "signal": {"switches": phase_changes},
        "runtime": {"wall_clock_seconds": runtime},
        "fixed_green_time": args.green_time,
        "yellow_time": args.yellow_time,
        "sumo_seed": seed,
    }

    output = args.output
    if output is None:
        output = os.path.join("matched_experiments", "fixed.json")

    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print()
    print("=" * 60)
    print("FIXED-TIME RESULT")
    print("=" * 60)
    print(f"Simulation time : {args.duration} s")
    print(f"Throughput      : {result['total']['throughput']}")
    print(f"Avg waiting     : {result['total']['average_waiting_time']:.2f} s")
    print(f"Avg duration    : {result['total']['avg_duration']:.2f} s")
    print(f"Avg speed       : {result['total']['average_speed']:.2f} m/s")
    print(f"Avg queue       : {result['total']['average_queue_length']:.3f} vehicles")
    print(f"Phase changes   : {result['signal']['switches']}")
    print(f"Output          : {output_path.resolve()}")
    print("=" * 60)
    print()


if __name__ == "__main__":
    args = parse_args()
    run(args)
