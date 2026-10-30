import argparse
import json
import random
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_SUMOCFG = Path('SUMO') / 'nets' / 'intersection.sumocfg'
DEFAULT_MODEL = Path('Model') / 'final_model.pt'
DEFAULT_PREPROCESSOR = Path('Model') / 'preprocessor.joblib'
DEFAULT_NN = Path('Model') / 'controller_nn_final.py'
DEFAULT_NESY = Path('Model') / 'controller_nesy_final.py'
DEFAULT_FIXED = Path('Model') / 'controller_fixed_final.py'
DEFAULT_OUTPUT_DIR = Path('Result')
DEFAULT_SEED_FILE = DEFAULT_OUTPUT_DIR / 'experiment_seeds.json'

SEED_MIN = 1
SEED_MAX = 2_000_000_000


def parse_args():
    p = argparse.ArgumentParser(description='Run matched Fixed + NN + NeSy SUMO experiments.')
    p.add_argument('--project', type=Path, default=Path('.'))
    p.add_argument('--sumocfg', type=Path, default=DEFAULT_SUMOCFG)
    p.add_argument('--model', type=Path, default=DEFAULT_MODEL)
    p.add_argument('--preprocessor', type=Path, default=DEFAULT_PREPROCESSOR)
    p.add_argument('--nn', type=Path, default=DEFAULT_NN)
    p.add_argument('--nesy', type=Path, default=DEFAULT_NESY)
    p.add_argument('--fixed', type=Path, default=DEFAULT_FIXED)
    p.add_argument('--runs', type=int, default=1)
    p.add_argument('--output-dir', type=Path, default=DEFAULT_OUTPUT_DIR)
    p.add_argument('--seed-file', type=Path, default=DEFAULT_SEED_FILE)
    p.add_argument('--base-seed', type=int, default=None)
    p.add_argument('--sumo-binary', default='sumo')
    p.add_argument('--quiet', action='store_true')
    return p.parse_args()


def resolve(project, path):
    path = Path(path)
    return path.resolve() if path.is_absolute() else (project / path).resolve()


def generate_seeds(run_ids):
    seeds = {}
    used = set()

    for rid in run_ids:
        seed = random.SystemRandom().randint(SEED_MIN, SEED_MAX)

        while seed in used:
            seed = random.SystemRandom().randint(SEED_MIN, SEED_MAX)

        seeds[rid] = seed
        used.add(seed)

    return seeds


def start_controller(name, script, seed, output, sumocfg, model, preprocessor, sumo_binary, quiet):
    """Launch one controller as a background subprocess and return its handle."""
    cmd = [
        sys.executable, str(script),
        '--sumocfg', str(sumocfg),
        '--seed', str(seed),
        '--output', str(output),
        '--sumo-binary', sumo_binary,
    ]
    if name in ('nn', 'nesy'):
        cmd += ['--model', str(model), '--preprocessor', str(preprocessor)]
    if quiet:
        cmd.append('--quiet')

    print(f'Starting {name:<5} | seed {seed} | output {output}')
    return subprocess.Popen(cmd, cwd=str(script.parent.parent))


def main():
    a = parse_args()
    if a.runs < 1:
        raise ValueError('--runs must be at least 1')

    project = a.project.resolve()
    sumocfg = resolve(project, a.sumocfg)
    model = resolve(project, a.model)
    pre = resolve(project, a.preprocessor)
    nn = resolve(project, a.nn)
    nesy = resolve(project, a.nesy)
    fixed = resolve(project, a.fixed)
    outdir = resolve(project, a.output_dir)
    seedfile = resolve(project, a.seed_file)

    required_paths = {
        'SUMO config': sumocfg,
        'NN controller': nn,
        'NeSy controller': nesy,
        'Fixed controller': fixed,
        'model': model,
        'preprocessor': pre,
    }
    for label, path in required_paths.items():
        if not path.exists():
            raise FileNotFoundError(f'{label} not found: {path}')

    run_ids = [f'run_{i:03d}' for i in range(1, a.runs + 1)]
    seeds = generate_seeds(run_ids)

    manifest = {
        'experiment_type': 'matched_three_controller',
        'controllers': ['fixed', 'nn', 'nesy'],
        'runs': a.runs,
        'seed_file': str(seedfile),
        'sumocfg': str(sumocfg),
        'model': str(model),
        'preprocessor': str(pre),
        'results': {},
    }

    for rid in run_ids:
        seed = seeds[rid]
        rundir = outdir / str(seed)
        rundir.mkdir(parents=True, exist_ok=True)

        print('\n' + '#' * 70)
        print(f'MATCHED EXPERIMENT: {rid}')
        print(f'Shared SUMO seed: {seed}')
        print('#' * 70)

        fixed_out, nn_out, nesy_out = rundir / 'fixed.json', rundir / 'nn.json', rundir / 'nesy.json'
        controllers = [
            ('fixed', fixed, fixed_out),
            ('nn', nn, nn_out),
            ('nesy', nesy, nesy_out),
        ]
        manifest['results'][rid] = {
            'seed': seed,
            'fixed': str(fixed_out),
            'nn': str(nn_out),
            'nesy': str(nesy_out),
        }

        # Start all three controllers at once (same seed) and wait for all of them.
        procs = []
        for name, script, output in controllers:
            procs.append((name, start_controller(name, script, seed, output, sumocfg, model, pre, a.sumo_binary, a.quiet)))
            time.sleep(1)  # small stagger so TraCI picks distinct free ports

        failed = []
        for name, proc in procs:
            code = proc.wait()
            if code != 0:
                failed.append(f'{name} (exit code {code})')
        if failed:
            raise RuntimeError('Controller(s) failed: ' + ', '.join(failed))

    manifest_path = outdir / 'manifest.json'
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')

    print('\n' + '=' * 70)
    print('MATCHED EXPERIMENT COMPLETE')
    print('=' * 70)
    print(f'Seed file : {seedfile}')
    print(f'Manifest  : {manifest_path}')
    for rid in run_ids:
        seed = seeds[rid]
        r = outdir / str(seed)
        print(f'  {rid}: Fixed={r / "fixed.json"}  NN={r / "nn.json"}  NeSy={r / "nesy.json"}')


if __name__ == '__main__':
    main()