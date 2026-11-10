"""Run a real, isolated Gen 9 Random Battle through the practice server and runner."""

import argparse
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager, redirect_stdout
from datetime import datetime, timezone
import importlib.util
import json
import logging
import math
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts" / "laplace"
SPEC = importlib.util.spec_from_file_location("practice_runner", SCRIPTS / "runner.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


@asynccontextmanager
async def child(*args, stop=False):
    process = await asyncio.create_subprocess_exec(
        *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
    )
    try:
        yield process
    finally:
        if process.returncode is None:
            if stop:
                process.stdin.close()
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except asyncio.TimeoutError:
                    process.kill()
            else:
                process.kill()
        await process.wait()


async def event(process, expected=None, timeout=30):
    line = await asyncio.wait_for(process.stdout.readline(), timeout)
    assert line, f"Child exited ({process.returncode})"
    result = json.loads(line)
    assert result["type"] != "error", result
    if expected:
        assert result["type"] == expected, result
    return result


async def human_game(websocket, player, human, bot):
    client = player.ps_client
    requested = False
    client.websocket = websocket
    async for message in websocket:
        lines = message.split("\n")
        if lines[0].startswith(">battle-"):
            await player._handle_battle_message([line.split("|") for line in lines])
            room, battle = next(iter(player.battles.items()))
            if battle.finished:
                return room, "win" if battle.won else "loss" if battle.lost else "tie"
            continue
        for line in lines:
            parts = line.split("|", 4)
            if len(parts) < 2:
                continue
            if parts[1] == "challstr" and not requested:
                requested = True
                await client.send_message(f"/trn {human},0,")
            elif parts[1] == "updateuser" and len(parts) >= 4 and parts[3] == "1":
                if runner.identity_matches(parts[2], human) and not client.logged_in.is_set():
                    client.logged_in.set()
                    await client.challenge(bot.lower(), runner.FORMAT, None)
            elif parts[1] in {"nametaken", "popup"}:
                raise RuntimeError(f"Human connection received {parts[1]}")
    raise RuntimeError("Human disconnected before battle ended")


async def bot_game(process):
    turns = []
    battle = await event(process, "battle")
    while True:
        result = await event(process)
        assert result["room"] == battle["room"], result
        if result["type"] == "end":
            break
        assert result["type"] in {"thinking", "turn"}, result
        if result["type"] == "turn":
            turns.append(result)
    assert any(turn["visits"] > 0 and turn["worlds"] > 0 and not turn["fallback"] for turn in turns), turns
    return battle["room"], result["result"], turns


async def game(server_root, threads, baseline):
    from poke_env import AccountConfiguration, ServerConfiguration
    from poke_env.player import SimpleHeuristicsPlayer
    from websockets.asyncio.client import connect

    token = secrets.token_hex(24)
    bot, human = f"Laplace{secrets.token_hex(5)}", f"Player{secrets.token_hex(5)}"
    async with AsyncExitStack() as stack:
        server = await stack.enter_async_context(child(
            "node", str(SCRIPTS / "server.cjs"), "--server-root", str(server_root),
            "--port", "0", "--token", token,
        ))
        port = (await event(server, "ready"))["port"]
        assert isinstance(port, int) and 1024 <= port <= 65535, port
        process = await stack.enter_async_context(child(
            sys.executable, "-I", "-B", str(SCRIPTS / "runner.py"),
            "--port", str(port), "--token", token, "--bot", bot,
            "--human", human, "--threads", str(threads), stop=True,
        ))
        ready = await event(process, "ready")
        assert ready["bot"] == bot and ready["human"] == human and ready["threads"] == threads, ready

        url = f"ws://{runner.HOST}:{port}/showdown/websocket?token={token}"
        loop = asyncio.get_running_loop()
        opponent_ms = []
        if baseline:
            def observe(kind, **fields):
                if kind == "decision" and math.isfinite(fields["ms"]):
                    opponent_ms.append(fields["ms"])

            player = runner.build_player(*baseline, human, url, 8, observe)
        else:
            player = SimpleHeuristicsPlayer(
                account_configuration=AccountConfiguration(human, None),
                server_configuration=ServerConfiguration(url, ""),
                battle_format=runner.FORMAT, start_listening=False, loop=loop,
            )
        sock = stack.enter_context(socket.socket(socket.AF_INET, socket.SOCK_STREAM))
        sock.setblocking(False)
        await asyncio.wait_for(loop.sock_connect(sock, (runner.HOST, port)), 5)
        websocket = await stack.enter_async_context(connect(url, sock=sock, proxy=None, close_timeout=2))
        async with asyncio.timeout(900), asyncio.TaskGroup() as tasks:
            from_human = tasks.create_task(human_game(websocket, player, human, bot))
            from_bot = tasks.create_task(bot_game(process))
        room, human_result, turns = from_bot.result()
        assert (room, human_result) == from_human.result()
        process.stdin.write(b"stop\n")
        await process.stdin.drain()
        assert await asyncio.wait_for(process.wait(), 5) == 0
        return {"win": "loss", "loss": "win", "tie": "tie"}[human_result], turns, opponent_ms


def timing(samples):
    if not samples:
        return None
    samples = sorted(samples)

    def percentile(fraction):
        return round(samples[math.ceil(len(samples) * fraction) - 1], 1)

    return {"decisions": len(samples), "p50Ms": percentile(0.5), "p95Ms": percentile(0.95),
            "maxMs": round(samples[-1], 1)}


def wilson_interval(wins, total):
    if not total:
        return None
    z = 1.959963984540054
    rate = wins / total
    denominator = 1 + z * z / total
    center = (rate + z * z / (2 * total)) / denominator
    radius = z * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / denominator
    return [round(max(0, center - radius), 4), round(min(1, center + radius), 4)]


async def series(args):
    baseline = None
    runtime = None
    if args.opponent == "baseline":
        with redirect_stdout(sys.stderr):
            engine, model, runtime = runner.load_runtime(False)
        baseline = (engine, model)

    counts = {"win": 0, "loss": 0, "tie": 0}
    runner_ms, baseline_ms = [], []
    completed = []
    started = datetime.now(timezone.utc).isoformat()

    def summary(status):
        decisive = counts["win"] + counts["loss"]
        return {"type": "summary", "status": status, "opponent": args.opponent, "threads": args.threads,
                "baselineThreads": 8 if baseline else None, "plannedBattles": args.battles,
                "battles": len(completed), "wins": counts["win"], "losses": counts["loss"], "ties": counts["tie"],
                "abortedBattles": int(status == "failed"),
                "decisiveGames": decisive, "decisiveWinRate95Wilson": wilson_interval(counts["win"], decisive),
                "runnerLatency": timing(runner_ms), "baselineLatency": timing(baseline_ms)}

    def checkpoint(status):
        if args.output:
            write_report(args.output, {**summary(status), "pid": os.getpid(), "startedAt": started,
                                      "updatedAt": datetime.now(timezone.utc).isoformat(), "seedPairing": False,
                                      "runnerRole": "challenge recipient", "format": runner.FORMAT,
                                      "determinizations": runner.WORLDS, "searchMs": runner.SEARCH_MS,
                                      "modelSha256": runner.MODEL_SHA256, "runtime": runtime, "games": completed})

    checkpoint("running")
    try:
        for index in range(1, args.battles + 1):
            result, turns, opponent_ms = await game(args.server_root, args.threads, baseline)
            counts[result] += 1
            battle_ms = [turn["elapsedMs"] for turn in turns]
            runner_ms.extend(battle_ms)
            baseline_ms.extend(opponent_ms)
            report = {"battle": index, "result": result, "runnerLatency": timing(battle_ms),
                      "fallbacks": sum(turn["fallback"] for turn in turns),
                      "peakVisits": max(turn["visits"] for turn in turns),
                      "baselineLatency": timing(opponent_ms)}
            completed.append(report)
            checkpoint("complete" if index == args.battles else "running")
            print(json.dumps(report), flush=True)
    except BaseException:
        checkpoint("failed")
        raise
    print(json.dumps(summary("complete")), flush=True)


def write_report(output, payload):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent,
                                         prefix=f"{output.stem}.", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(payload, stream, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(output)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--server-root", type=Path, required=True)
    parser.add_argument("--threads", type=int, choices=(1, 2, 4, 8), default=8)
    parser.add_argument("--opponent", choices=("heuristic", "baseline"), default="heuristic")
    parser.add_argument("--battles", type=int, default=1)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.battles <= 60:
        parser.error("--battles must be between 1 and 60")
    args.server_root = args.server_root.resolve(strict=True)
    if args.output:
        args.output = args.output.resolve()
        if args.output.exists():
            parser.error("Choose a new report path")
        args.output.parent.mkdir(parents=True, exist_ok=True)
    sys.addaudithook(runner.local_socket_only)
    logging.disable(logging.CRITICAL)
    asyncio.run(series(args))


if __name__ == "__main__":
    main()
