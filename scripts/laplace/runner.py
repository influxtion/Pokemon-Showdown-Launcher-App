"""Drive one local Showdown practice session with the shipped stock Laplace engine."""

import argparse
import asyncio
from contextlib import redirect_stdout
import hashlib
from importlib.metadata import version
import json
import logging
import math
import os
import platform
import re
import signal
import socket
import sys
import threading


FORMAT = "gen9randombattle"
PROTOCOL = 1
HOST = "127.0.0.1"
WORLDS = 8
SEARCH_MS = 150
MODEL_SHA256 = "502a47a59a6f87786c56b835e972828bc8cbab8e75028b5ddf90b49b8b5d2861"
BOT_NAME = re.compile(r"Laplace(?:[0-9a-f]{10})?")
HUMAN_NAME = re.compile(r"Player(?:[0-9a-f]{10})?")
TOKEN = re.compile(r"[0-9a-f]{32,128}")
ROOM = re.compile(rf"battle-{FORMAT}-[0-9]{{1,16}}(?:-[a-z0-9]{{1,32}}pw)?")


def arguments(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--port", type=int)
    parser.add_argument("--token")
    parser.add_argument("--bot")
    parser.add_argument("--human")
    parser.add_argument("--threads", type=int, choices=(1, 2, 4, 8))
    args = parser.parse_args(argv)
    session = (args.port, args.token, args.bot, args.human, args.threads)
    if args.check:
        if any(value is not None for value in session):
            parser.error("--check takes no session options")
    elif not (
        args.port is not None and 1024 <= args.port <= 65535
        and TOKEN.fullmatch(args.token or "")
        and BOT_NAME.fullmatch(args.bot or "")
        and HUMAN_NAME.fullmatch(args.human or "")
        and args.threads is not None
    ):
        parser.error("Expected a loopback port, session token, local names, and supported thread count")
    return args


def local_socket_only(event, args):
    # Windows asyncio uses an internal socket pair on loopback too.
    if event in {"socket.bind", "socket.connect", "socket.sendto", "socket.sendmsg", "socket.getnameinfo"}:
        address = args[0] if event == "socket.getnameinfo" else args[1]
        if isinstance(address, tuple) and len(address) == 2 and address[0] == HOST:
            return
    elif event in {
        "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyname_ex",
        "socket.gethostbyaddr",
    }:
        if args[0] == HOST:
            return
    else:
        return
    raise PermissionError("Laplace practice requires IPv4 loopback")


def load_runtime(check):
    import numpy as np
    import poke_engine
    import torch
    import websockets  # Load the same client in the offline check.
    from laplace import paths
    from laplace.agent.engine_search import EnginePlayer
    from laplace.value.net import ValueNet
    from laplace.value.value_features import N_VALUE_FEATURES, featurize

    if version("poke-env") != "0.15.0" or version("poke-engine") != "0.0.47" or hasattr(poke_engine, "featurize_state"):
        raise ValueError("Unsupported engine or client")
    for path in (paths.JOINT_SETS, paths.RANDBATS_STATS, paths.RANDBATS_SETS):
        with open(path, encoding="utf-8") as stream:
            data = json.load(stream)
        if not isinstance(data, dict) or not data:
            raise ValueError("Missing random battle data")

    with open(paths.VALUE_NET, "rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != MODEL_SHA256:
            raise ValueError("Unsupported value model")
        stream.seek(0)
        checkpoint = torch.load(stream, map_location="cpu", weights_only=True)
    if checkpoint["n_in"] != N_VALUE_FEATURES:
        raise ValueError("Unsupported value model features")
    model = ValueNet(checkpoint["n_in"], hidden=tuple(checkpoint.get("hidden", (256, 128))),
                     dropout=checkpoint.get("dropout", 0.1))
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    torch.set_num_threads(1)

    runtime = {
        "python": platform.python_version(),
        "laplace": version("laplace"),
        "pokeEnv": version("poke-env"),
        "pokeEngine": version("poke-engine"),
        "torch": version("torch"),
        "numpy": version("numpy"),
        "websockets": websockets.__version__,
        "modelSha256": MODEL_SHA256,
    }
    if not all(re.fullmatch(r"[0-9A-Za-z.+-]{1,64}", value) for value in runtime.values()):
        raise ValueError("Invalid runtime version")
    if check:
        state = poke_engine.State()
        if poke_engine.monte_carlo_tree_search(state, duration_ms=20, threads=1).total_visits < 1:
            raise ValueError("Engine search failed")
        features = featurize(state)
        if len(features) != N_VALUE_FEATURES or not np.isfinite(features).all():
            raise ValueError("Invalid model features")
        with torch.no_grad():
            probability = model(torch.from_numpy(features).unsqueeze(0)).sigmoid().item()
        if not 0 <= probability <= 1:
            raise ValueError("Invalid model result")
    return EnginePlayer, model, runtime


class SessionError(Exception):
    pass


def identity_matches(identity, name):
    # Showdown prefixes the rank and appends an optional status to identities.
    return identity[1:].split("@", 1)[0].lower() == name.lower()


def build_player(engine, model, username, url, threads, observer):
    from poke_env import AccountConfiguration, ServerConfiguration

    # Match the stock ladder search configuration without importing its online entry point.
    player = engine(
        account_configuration=AccountConfiguration(username, None),
        server_configuration=ServerConfiguration(url, ""),
        battle_format=FORMAT,
        start_listening=False,
        start_timer_on_battle_start=False,
        loop=asyncio.get_running_loop(),
        n_determinizations=WORLDS,
        search_time_ms=SEARCH_MS,
        threads=threads,
        value_boost_margin=0,
        robust_vote=False,
        mix_root=True,
        mix_frac=0.9,
        observer=observer,
    )
    # Reuse the verified weights loaded by the runtime check.
    player._value_model = model
    return player


class PracticeSession:
    def __init__(self, args, engine, model, emit):
        self.args = args
        self.emit = emit
        self.url = f"ws://{HOST}:{args.port}/showdown/websocket?token={args.token}"
        self.room = None
        self.pending_until = 0
        self.login_requested = False
        self.player = build_player(engine, model, args.bot, self.url, args.threads, self.observe_search)
        self.client = self.player.ps_client
        self.worlds = 0
        self.visits = 0

    def observe_search(self, event, **details):
        if event == "world":
            self.worlds = min(WORLDS, self.worlds + 1)
            self.visits = min(2_147_483_647, self.visits + details["res"].total_visits)
            return
        if event not in {"turn_start", "decision"} or not self.room:
            return
        battle = details["battle"]
        turn = min(10_000, max(0, battle.turn))
        if event == "turn_start":
            self.worlds = 0
            self.visits = 0
            self.emit("thinking", room=self.room, turn=turn)
        else:
            elapsed = details["ms"]
            elapsed = round(min(120_000, max(0, elapsed))) if math.isfinite(elapsed) else 0
            self.emit("turn", room=self.room, turn=turn, elapsedMs=elapsed,
                      visits=self.visits, worlds=self.worlds, fallback=details["fallback"])

    async def receive(self, message):
        if not isinstance(message, str):
            raise SessionError("invalid-message")
        lines = message.split("\n")
        if lines and lines[0].startswith(">"):
            await self.receive_battle(lines)
            return
        for line in lines:
            parts = line.split("|", 7)
            if len(parts) < 2 or parts[0]:
                continue
            kind = parts[1]
            if kind == "challstr" and not self.login_requested:
                self.login_requested = True
                # The dedicated development server accepts unregistered local names.
                await self.client.send_message(f"/trn {self.args.bot},0,")
            elif kind == "updateuser" and len(parts) >= 4 and self.login_requested:
                if parts[3] == "1" and identity_matches(parts[2], self.args.bot):
                    if not self.client.logged_in.is_set():
                        self.client.logged_in.set()
                        self.emit("ready", protocol=PROTOCOL, bot=self.args.bot,
                                  human=self.args.human, format=FORMAT, threads=self.args.threads,
                                  determinizations=WORLDS, searchMs=SEARCH_MS)
                elif self.client.logged_in.is_set():
                    raise SessionError("login-lost")
            elif kind == "nametaken":
                raise SessionError("login-rejected")
            elif kind == "pm" and self.client.logged_in.is_set():
                await self.receive_challenge(parts)

    async def receive_challenge(self, parts):
        now = asyncio.get_running_loop().time()
        if (
            self.room is None and now >= self.pending_until and len(parts) >= 6
            and identity_matches(parts[2], self.args.human)
            and identity_matches(parts[3], self.args.bot)
            and parts[4] == f"/challenge {FORMAT}" and parts[5] == FORMAT
        ):
            self.pending_until = now + 15
            await self.client.accept_challenge(self.args.human.lower(), None)

    async def receive_battle(self, lines):
        room = lines[0][1:]
        if not ROOM.fullmatch(room) or not self.client.logged_in.is_set():
            return
        if self.room is None:
            if asyncio.get_running_loop().time() >= self.pending_until:
                return
            titles = {f"|title|{self.args.human} vs. {self.args.bot}",
                      f"|title|{self.args.bot} vs. {self.args.human}"}
            if len(lines) < 3 or lines[1] != "|init|battle" or lines[2] not in titles:
                return
            self.room = room
            self.pending_until = 0
            self.emit("battle", room=room)
        if self.room != room:
            return
        if "|deinit" in lines:
            raise SessionError("battle-lost")
        await self.player._handle_battle_message([line.split("|") for line in lines])
        battle = self.player.battles[room]
        if battle.finished:
            result = "loss" if battle.won else "win" if battle.lost else "tie"
            self.emit("end", room=room, result=result)
            self.player.reset_battles()
            self.room = None

    async def listen(self):
        from websockets.asyncio.client import connect

        # A preconnected socket prevents proxies and HTTP redirects from dialing elsewhere.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as transport:
            transport.setblocking(False)
            await asyncio.wait_for(
                asyncio.get_running_loop().sock_connect(transport, (HOST, self.args.port)), 5,
            )
            async with connect(self.url, sock=transport, proxy=None, open_timeout=5,
                               close_timeout=2, max_size=2**20) as websocket:
                self.client.websocket = websocket
                async with asyncio.timeout(8):
                    while not self.client.logged_in.is_set():
                        await self.receive(await websocket.recv())
                async for message in websocket:
                    await self.receive(message)
        raise SessionError("disconnected")


def watch_stdin(stop):
    # Read the pipe directly so an idle daemon does not hold a buffered stdin lock at exit.
    try:
        pending = b""
        while True:
            data = os.read(sys.stdin.fileno(), 64)
            if not data:
                break
            pending += data
            if pending in {b"stop\n", b"stop\r\n"} or len(pending) >= 64:
                break
    except (OSError, ValueError):
        pass
    stop()


async def serve(args, engine, model, emit):
    loop = asyncio.get_running_loop()
    stopped = asyncio.Event()

    def stop():
        try:
            loop.call_soon_threadsafe(stopped.set)
        except RuntimeError:
            pass  # The session can finish before the stdin watcher.

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop())
    threading.Thread(target=watch_stdin, args=(stop,), daemon=True).start()
    listener = asyncio.create_task(PracticeSession(args, engine, model, emit).listen())
    shutdown = asyncio.create_task(stopped.wait())
    try:
        done, _ = await asyncio.wait((listener, shutdown), return_when=asyncio.FIRST_COMPLETED)
        if shutdown not in done:
            listener.result()
    finally:
        listener.cancel()
        shutdown.cancel()
        await asyncio.gather(listener, shutdown, return_exceptions=True)


def main():
    args = arguments()
    sys.addaudithook(local_socket_only)
    logging.disable(logging.CRITICAL)
    output = sys.stdout

    def emit(kind, **fields):
        print(json.dumps({"type": kind, **fields}, separators=(",", ":"), allow_nan=False),
              file=output, flush=True)

    with redirect_stdout(sys.stderr):
        try:
            engine, model, runtime = load_runtime(args.check)
        except KeyboardInterrupt:
            return 130
        except BaseException:
            emit("error", code="runtime-invalid")
            return 1
        if args.check:
            emit("checked", protocol=PROTOCOL, runtime=runtime)
            return 0
        try:
            asyncio.run(serve(args, engine, model, emit))
        except SessionError as error:
            emit("error", code=error.args[0])
            return 1
        except (OSError, TimeoutError):
            emit("error", code="connection-failed")
            return 1
        except Exception:
            emit("error", code="session-failed")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
