"""Measure the pinned stock Laplace decision path on Windows without a battle server."""

import argparse
import ctypes as c
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
from importlib import metadata
import json
import logging
import os
from pathlib import Path
import platform
import random
import statistics
import subprocess
import sys
import time


LAPLACE_REVISION = "8b4173dfdabff12e9228310ba25e3fd2ed5117df"
CHECKPOINT_SHA256 = "502a47a59a6f87786c56b835e972828bc8cbab8e75028b5ddf90b49b8b5d2861"
WORLDS = 8
WORLD_MS = 150
THREAD_COUNTS = (1, 2, 4, 8)
AFFINITY_COUNTS = (0, 4, 2)
SCENARIOS = ("opening", "hazards-and-setup", "forced-switch")
TEAM = ("garchomp", "rotomwash", "corviknight", "greattusk", "meowscarada", "sylveon")
OUTPUT = Path(__file__).resolve().parents[2] / "out" / "laplace" / "benchmark.json"


class MemoryCounters(c.Structure):
    _fields_ = [
        ("size", wintypes.DWORD),
        ("faults", wintypes.DWORD),
        ("peak_working_set", c.c_size_t),
        ("working_set", c.c_size_t),
        ("peak_paged_pool", c.c_size_t),
        ("paged_pool", c.c_size_t),
        ("peak_nonpaged_pool", c.c_size_t),
        ("nonpaged_pool", c.c_size_t),
        ("pagefile", c.c_size_t),
        ("peak_pagefile", c.c_size_t),
    ]


class WindowsProcess:
    def __init__(self):
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        self.kernel.GetCurrentProcess.restype = wintypes.HANDLE
        self.handle = self.kernel.GetCurrentProcess()
        self.kernel.GetProcessAffinityMask.argtypes = [
            wintypes.HANDLE, c.POINTER(c.c_size_t), c.POINTER(c.c_size_t),
        ]
        self.kernel.SetProcessAffinityMask.argtypes = [wintypes.HANDLE, c.c_size_t]
        self.kernel.K32GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE, c.POINTER(MemoryCounters), wintypes.DWORD,
        ]

    def set_affinity(self, count):
        process_mask, system_mask = c.c_size_t(), c.c_size_t()
        if not self.kernel.GetProcessAffinityMask(self.handle, c.byref(process_mask),
                                                 c.byref(system_mask)):
            raise c.WinError(c.get_last_error())
        available = [i for i in range(c.sizeof(c.c_size_t) * 8) if process_mask.value & (1 << i)]
        if count:
            if count > len(available):
                raise RuntimeError(f"Need {count} logical CPUs, have {len(available)}")
            available = available[:count]
            if not self.kernel.SetProcessAffinityMask(self.handle, sum(1 << i for i in available)):
                raise c.WinError(c.get_last_error())
        return available

    def memory(self):
        counters = MemoryCounters(size=c.sizeof(MemoryCounters))
        if not self.kernel.K32GetProcessMemoryInfo(self.handle, c.byref(counters), counters.size):
            raise c.WinError(c.get_last_error())
        return {
            "working_set_mib": round(counters.working_set / (1024 ** 2), 2),
            "peak_working_set_mib": round(counters.peak_working_set / (1024 ** 2), 2),
        }


def deny_external_sockets(event, args):
    # The poke-env event loop may use a Windows loopback socket pair internally.
    if event in ("socket.connect", "socket.bind"):
        address = args[1]
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
            raise RuntimeError(f"External sockets are disabled ({event})")
    elif event in ("socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyname_ex"):
        if args[0] not in ("127.0.0.1", "::1"):
            raise RuntimeError(f"External DNS is disabled ({event})")


def elapsed_ms(start):
    return (time.perf_counter_ns() - start) / 1_000_000


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git(root, *args):
    return subprocess.check_output(
        ["git", "--no-optional-locks", "-C", str(root), *args], text=True, timeout=15,
    ).strip()


def own_team(joint_sets):
    from poke_env.battle import Pokemon
    from laplace.agent.knowledge import _estimate_stat

    team = []
    for species in TEAM:
        sets = joint_sets[species]
        modal_set = max(sets, key=lambda key: (sets[key], key))
        level, item, ability, *moves, tera = modal_set.split(",")
        mon = Pokemon(gen=9, species=species)
        mon._level = int(level)
        hp = _estimate_stat(mon, "hp")
        team.append({
            "ident": f"p1: {species}",
            "details": f"{species}, L{level}, tera:{tera}",
            "condition": f"{hp}/{hp}",
            "active": species == TEAM[0],
            "moves": moves,
            "item": item,
            "baseAbility": ability,
            "stats": {stat: _estimate_stat(mon, stat) for stat in ("atk", "def", "spa", "spd", "spe")},
        })
    return team


def fixture(name, joint_sets):
    from poke_env.battle import Battle

    battle = Battle(f"benchmark-{name}", "OfflineBenchmark", logging.getLogger(__name__), 9)
    team = own_team(joint_sets)
    request = {"side": {"id": "p1", "pokemon": team}}
    battle.parse_request(request)

    def event(line):
        battle.parse_message(line.split("|"))

    if name == "opening":
        event("|switch|p2a: Kilowattrel|Kilowattrel, L84|100/100")
        event("|turn|1")
    else:
        event("|turn|12")
        event("|switch|p2a: Clodsire|Clodsire, L83|54/100")
        event("|switch|p2a: Tinkaton|Tinkaton, L85|70/100")
        event("|switch|p2a: Dragonite|Dragonite, L77|75/100")
        event("|-boost|p2a: Dragonite|atk|1")
        event("|-boost|p2a: Dragonite|spe|1")
        event("|-sidestart|p1: OfflineBenchmark|move: Stealth Rock")
        event("|-sidestart|p2: OfflineOpponent|move: Spikes")
        team[2]["condition"] = "0 fnt"

    if name == "forced-switch":
        team[0]["condition"] = "0 fnt"
        request["forceSwitch"] = [True]
    else:
        if name == "hazards-and-setup":
            _, hp = team[0]["condition"].split("/")
            team[0]["condition"] = f"{int(hp) // 2}/{hp}"
        request["active"] = [{
            "moves": [{"id": move, "disabled": False} for move in team[0]["moves"]],
            "canTerastallize": team[0]["details"].split("tera:", 1)[1],
        }]
    battle.parse_request(request)
    return battle


def summarize(samples):
    return {"min": round(min(samples), 3), "median": round(statistics.median(samples), 3),
            "max": round(max(samples), 3)}


def run_worker(root, threads, affinity_count, repeats, launch_ns):
    sys.addaudithook(deny_external_sockets)
    process = WindowsProcess()
    affinity = process.set_affinity(affinity_count)
    initial_memory = process.memory()

    start = time.perf_counter_ns()
    import poke_engine
    from laplace import paths
    from laplace.agent.engine_search import EnginePlayer
    from poke_env import AccountConfiguration, ServerConfiguration
    from poke_env.battle import Move, Pokemon
    from poke_env.player.battle_order import SingleBattleOrder
    agent_import_ms = elapsed_ms(start)
    if Path(paths.ROOT).resolve() != root or metadata.version("poke-engine") != "0.0.47":
        raise RuntimeError("Use the requested Laplace checkout and stock poke-engine 0.0.47")
    native = next(Path(poke_engine.__file__).parent.glob("*.pyd"))
    engine_binary = native.read_bytes()
    if b"LAPLACE_VALUE_NET" in engine_binary:
        raise RuntimeError("The installed poke-engine binary is the Laplace fork")
    engine_hash = hashlib.sha256(engine_binary).hexdigest()
    del engine_binary
    if sha256(Path(paths.VALUE_NET)) != CHECKPOINT_SHA256:
        raise RuntimeError("The value checkpoint does not match the pinned Laplace revision")

    start = time.perf_counter_ns()
    import torch
    from laplace.value.value_features import featurize
    torch_import_ms = elapsed_ms(start)
    if torch.version.cuda is not None:
        raise RuntimeError("Use the CPU-only Torch build")

    class MeasuredPlayer(EnginePlayer):
        def _value_rerank(self, ranked, battle=None):
            start = time.perf_counter_ns()
            result = super()._value_rerank(ranked, battle)
            self.value_rerank_ms = elapsed_ms(start)
            return result

    worlds = []
    decisions = []
    value_batches = []
    forwards = []
    forward_start = 0

    def observe(event, **data):
        if event == "world":
            worlds.append((data["state"], data["res"], data["ms"]))
        elif event == "decision":
            decisions.append(data)
        elif event == "value":
            value_batches.append(data["branches"])

    def start_forward(_model, _inputs):
        nonlocal forward_start
        forward_start = time.perf_counter_ns()

    def finish_forward(_model, _inputs, _output):
        forwards.append(elapsed_ms(forward_start))

    start = time.perf_counter_ns()
    player = MeasuredPlayer(
        account_configuration=AccountConfiguration("OfflineBenchmark", None),
        server_configuration=ServerConfiguration("ws://127.0.0.1:1", "http://127.0.0.1:1"),
        start_listening=False, battle_format="gen9randombattle",
        n_determinizations=WORLDS, search_time_ms=WORLD_MS, threads=threads,
        value_model_path=paths.VALUE_NET, value_boost_margin=0,
        robust_vote=False, mix_root=True, mix_frac=0.9, observer=observe,
    )
    agent_init_ms = elapsed_ms(start)
    startup_ms = elapsed_ms(launch_ns)
    after_model = process.memory()
    with Path(paths.JOINT_SETS).open(encoding="utf-8") as stream:
        joint_sets = json.load(stream)
    pre_hook = player._value_model.register_forward_pre_hook(start_forward)
    post_hook = player._value_model.register_forward_hook(finish_forward)

    def decision(name, seed):
        battle = fixture(name, joint_sets)
        worlds.clear()
        decisions.clear()
        value_batches.clear()
        forwards.clear()
        player.value_rerank_ms = 0.0
        player._futility_hist.clear()
        diagnostics = player.diag.copy()
        random.seed(seed)
        cpu_start = time.process_time_ns()
        start = time.perf_counter_ns()
        order = player.choose_move(battle)
        wall = elapsed_ms(start)
        cpu = (time.process_time_ns() - cpu_start) / 1_000_000
        legal = isinstance(order, SingleBattleOrder) and (
            (isinstance(order.order, Move) and order.order in battle.available_moves
             and (not order.terastallize or battle.can_tera) and not battle.force_switch)
            or (isinstance(order.order, Pokemon) and order.order in battle.available_switches
                and not order.terastallize)
        )
        if not legal or len(decisions) != 1 or decisions[0]["fallback"] or len(worlds) != WORLDS:
            raise RuntimeError(f"Incomplete or illegal {name} decision: {order}, {player.diag}")
        if any(player.diag.get(key, 0) != diagnostics.get(key, 0)
               for key in ("value_roll_fail", "value_err", "observer_err")):
            raise RuntimeError(f"Decision instrumentation or value rerank failed: {player.diag}")
        visits = [result.total_visits for _, result, _ in worlds]
        if min(visits) <= 0:
            raise RuntimeError(f"Search returned an empty world in {name}")
        if name == "opening" and not any(
            option.move_choice.endswith("-tera") for option in worlds[0][1].side_one
        ):
            raise RuntimeError("The installed stock engine lacks the Gen 9 Tera search options")
        states = "\n".join(state.to_string() for state, _, _ in worlds)
        return {
            "scenario": name, "seed": seed, "worlds_sha256": hashlib.sha256(states.encode()).hexdigest(),
            "wall_ms": round(wall, 3), "cpu_ms": round(cpu, 3),
            "build_and_search_ms": round(sum(ms for _, _, ms in worlds), 3),
            "visits_by_world": visits, "total_visits": sum(visits),
            "value_stage_ms": round(player.value_rerank_ms, 3),
            "value_branches": sum(value_batches),
            "model_forward_ms": round(sum(forwards), 6), "model_forward_calls": len(forwards),
            "order": order.message, "memory": process.memory(),
        }

    first = decision(SCENARIOS[0], 4100)
    rows = []
    rerank_worlds = None
    rerank_choices = None
    for repeat in range(repeats):
        for index in range(len(SCENARIOS)):
            scenario_index = (index + repeat) % len(SCENARIOS)
            name = SCENARIOS[scenario_index]
            rows.append(decision(name, 4200 + 10 * repeat + scenario_index))
            if name == "hazards-and-setup":
                rerank_worlds = player._worlds
                rerank_choices = [(move.id, 0.25) for move in fixture(name, joint_sets).available_moves[:3]]

    final_memory = process.memory()
    # A controlled tie measures an active value stage even when natural decisions skip it.
    # The scores here are injected only for this probe, after all measured decisions.
    player._worlds = rerank_worlds
    rerank_timings = []
    rerank_forwards = []
    value_batches.clear()
    for _ in range(10):
        forwards.clear()
        player._value_rerank(rerank_choices)
        if len(forwards) != 1:
            raise RuntimeError("The controlled rerank did not reach the model")
        rerank_timings.append(player.value_rerank_ms)
        rerank_forwards.extend(forwards)
    if len(value_batches) != len(rerank_timings):
        raise RuntimeError("The controlled rerank failed after model evaluation")
    rerank_probe = {
        "stage_ms": summarize(rerank_timings), "forward_ms": summarize(rerank_forwards),
        "successor_count": summarize(value_batches),
    }

    pre_hook.remove()
    post_hook.remove()
    from laplace.agent.poke_engine_adapter import build_state
    state = build_state(fixture(SCENARIOS[1], joint_sets), use_joint=True)
    features = torch.from_numpy(featurize(state)).unsqueeze(0)
    model_probe = {}
    with torch.no_grad():
        for size in (1, 32, 128):
            batch = features.repeat(size, 1)
            player._value_model(batch).sigmoid()
            timings = []
            for _ in range(100):
                start = time.perf_counter_ns()
                probs = player._value_model(batch).sigmoid()
                timings.append(elapsed_ms(start))
            if not ((probs >= 0) & (probs <= 1)).all().item():
                raise RuntimeError("The value model did not return probabilities")
            model_probe[str(size)] = summarize(timings)

    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                        r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
        processor = winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
    return {
        "threads": threads, "affinity_count": affinity_count, "logical_cpu_ids": affinity,
        "python": platform.python_version(), "windows": platform.version(), "processor": processor,
        "versions": {name: metadata.version(name) for name in ("laplace", "poke-engine", "poke-env", "numpy")}
                    | {"torch": torch.__version__},
        "engine_binary_sha256": engine_hash,
        "startup": {
            "spawn_to_agent_ready_ms": round(startup_ms, 3),
            "agent_import_ms": round(agent_import_ms, 3),
            "torch_and_feature_import_ms": round(torch_import_ms, 3),
            "agent_init_and_checkpoint_load_ms": round(agent_init_ms, 3),
            "before_imports": initial_memory, "after_model": after_model,
            "first_decision": first,
        },
        "model_probe_ms": model_probe, "rerank_probe": rerank_probe,
        "decisions": rows, "final_memory": final_memory,
    }


def run_benchmark(args):
    root = args.laplace_root
    if git(root, "rev-parse", "HEAD") != LAPLACE_REVISION:
        raise RuntimeError(f"Laplace must be checked out at {LAPLACE_REVISION}")
    if git(root, "status", "--porcelain", "--untracked-files=no", "--", "src", "models", "data"):
        raise RuntimeError("Laplace source, models or data differ from the pinned revision")
    server = root / "server"
    if not (server / "data/random-battles/gen9/sets.json").is_file():
        raise RuntimeError("The local Showdown set sheet is required. A running server is unnecessary.")

    report = {
        "schema": 1, "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "laplace_revision": LAPLACE_REVISION, "set_sheet_repo_revision": git(server, "rev-parse", "HEAD"),
        "set_sheet_sha256": sha256(server / "data/random-battles/gen9/sets.json"),
        "value_checkpoint_sha256": CHECKPOINT_SHA256,
        "worlds_per_decision": WORLDS, "milliseconds_per_world": WORLD_MS,
        "warm_repeats_per_scenario": args.repeats, "conditions": [],
    }
    expected_worlds = {}
    env = os.environ.copy()
    env.update({"PYTHONHASHSEED": "0", "CUDA_VISIBLE_DEVICES": "-1", "PYTHONNOUSERSITE": "1"})
    conditions = [(threads, affinity) for affinity in AFFINITY_COUNTS for threads in THREAD_COUNTS]
    random.Random(37).shuffle(conditions)
    for threads, affinity in conditions:
        print(f"Measuring {threads} thread(s), affinity {affinity or 'unrestricted'}", flush=True)
        command = [
            sys.executable, "-B", str(Path(__file__).resolve()), "--laplace-root", str(root),
            "--repeats", str(args.repeats), "--worker", str(threads), str(affinity),
            str(time.perf_counter_ns()),
        ]
        worker = subprocess.run(command, env=env, capture_output=True, text=True,
                                timeout=180, check=False)
        if worker.returncode:
            raise RuntimeError(worker.stderr.strip() or f"Worker exited {worker.returncode}")
        result = json.loads(worker.stdout)
        for row in result["decisions"]:
            key = (row["scenario"], row["seed"])
            if expected_worlds.setdefault(key, row["worlds_sha256"]) != row["worlds_sha256"]:
                raise RuntimeError(f"Determinized states drifted across conditions for {key}")
        print(f"  median {statistics.median(r['wall_ms'] for r in result['decisions']):.0f} ms, "
              f"{statistics.median(r['total_visits'] for r in result['decisions']):,.0f} visits",
              flush=True)
        report["conditions"].append(result)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--laplace-root", type=lambda value: Path(value).resolve(), required=True)
    parser.add_argument("--repeats", type=int, default=5, help="warm decisions per scenario (1–8)")
    parser.add_argument("--worker", nargs=3, type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if os.name != "nt" or c.sizeof(c.c_size_t) != 8:
        parser.error("The affinity and memory measurements require 64-bit Windows.")
    if sys.version_info[:2] != (3, 12):
        parser.error("Use the Laplace environment's Python 3.12 interpreter.")
    if not 1 <= args.repeats <= 8:
        parser.error("--repeats must be between 1 and 8.")
    if args.worker:
        threads, affinity, launch_ns = args.worker
        if threads not in THREAD_COUNTS or affinity not in AFFINITY_COUNTS:
            parser.error("Unsupported worker condition.")
        print(json.dumps(run_worker(args.laplace_root, threads, affinity, args.repeats, launch_ns)))
    else:
        run_benchmark(args)


if __name__ == "__main__":
    main()
