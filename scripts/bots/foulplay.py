"""Pinned Foul Play adapter. Only accepts one isolated loopback practice session."""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from importlib.metadata import version
import json
import logging
import os
from pathlib import Path
import re
import socket
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "laplace"))
from runner import local_socket_only, watch_stdin, identity_matches

FORMAT = "gen9randombattle"
ROOM = re.compile(r"battle-gen9randombattle-\d{1,16}(?:-[a-z0-9]{1,32}pw)?")


def arguments(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--human", choices=["Player"], required=True)
    parser.add_argument("--bot", choices=["FoulPlay"], required=True)
    parser.add_argument("--threads", type=int, choices=[1, 2, 8], required=True)
    args = parser.parse_args(argv)
    if not args.source.is_absolute() or not 1024 <= args.port <= 65535 or not re.fullmatch(r"[a-f0-9]{64}", args.token):
        parser.error("Expected an absolute source path and loopback session")
    return args


async def serve(args, emit):
    sys.path.insert(0, str(args.source))
    from fp.config import FoulPlayConfig, SaveReplay
    from fp.data.mods.apply_mods import apply_mods
    from fp.websocket_client import PSWebsocketClient
    from fp.run_battle import pokemon_battle
    import fp.search.main as search
    import websockets

    if version("poke-engine") != "0.0.48":
        raise RuntimeError("Unsupported Foul Play engine")
    # Keep all search work in the owned process so Stop/parent death cannot orphan workers.
    # One sampled state at a time; the engine itself uses the selected thread count.
    search.ProcessPoolExecutor = ThreadPoolExecutor
    config = FoulPlayConfig
    config.username = config.user_id = args.bot
    config.pokemon_format = FORMAT
    config.search_time_ms = config.team_preview_search_time_ms = 100
    config.parallelism = config.team_preview_search_parallelism = 1
    config.search_threads = args.threads
    config.smogon_stats = None
    config.log_to_file = False
    config.save_replay = SaveReplay.never
    apply_mods(config.format_spec)

    class LocalClient(PSWebsocketClient):
        room = None
        turn = 0
        thinking_since = None

        async def receive_message(self):
            message = await super().receive_message()
            lines = message.split("\n")
            if lines[0].startswith(">") and ROOM.fullmatch(lines[0][1:]):
                room = lines[0][1:]
                if "|init|battle" in lines:
                    if self.room is not None:
                        raise RuntimeError("Unexpected second battle")
                    self.room = room
                    self.turn = 0
                    emit("battle", room=room)
                if self.room == room:
                    for line in lines:
                        if line.startswith("|turn|"):
                            self.turn = min(10000, int(line.split("|")[2]))
                        if line.startswith("|error|[Invalid choice]") or line.startswith("|error|[Unavailable choice]"):
                            # Never silently replace this bot with random/default play.
                            raise RuntimeError("Foul Play choice rejected")
                        if line.startswith("|request|") and line[9:]:
                            request = json.loads(line[9:])
                            if request and not request.get("wait"):
                                self.thinking_since = time.monotonic()
                                emit("thinking", room=room, turn=self.turn or 1)
            return message

        async def send_message(self, room, messages):
            if messages in (["hf"], ["gg"], ["/timer on"]):
                return
            await super().send_message(room, messages)
            if room == self.room and messages and messages[0].startswith(("/choose", "/switch")):
                elapsed = round((time.monotonic() - (self.thinking_since or time.monotonic())) * 1000)
                emit("turn", room=room, turn=self.turn or 1, elapsedMs=max(0, elapsed))
                self.thinking_since = None

    url = f"ws://127.0.0.1:{args.port}/showdown/websocket?token={args.token}"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as transport:
        transport.setblocking(False)
        await asyncio.wait_for(asyncio.get_running_loop().sock_connect(transport, ("127.0.0.1", args.port)), 5)
        async with websockets.connect(url, sock=transport, open_timeout=5, close_timeout=2, max_size=2**20) as websocket:
            client = LocalClient()
            client.websocket = websocket
            client.username = args.bot
            async with asyncio.timeout(10):
                while True:
                    message = await client.receive_message()
                    if "|challstr|" in message:
                        await client.send_message("", [f"/trn {args.bot},0,"])
                    if any(line.startswith(f"|updateuser| {args.bot}|1|") for line in message.split("\n")):
                        break
            emit("ready", protocol=1, opponent="foulplay", bot=args.bot, human=args.human,
                 format=FORMAT, threads=args.threads, searchMs=100)
            while True:
                message = await client.receive_message()
                for line in message.split("\n"):
                    parts = line.split("|", 7)
                    if (len(parts) >= 6 and parts[1] == "pm" and identity_matches(parts[2], args.human)
                            and identity_matches(parts[3], args.bot)
                            and parts[4] == f"/challenge {FORMAT}" and parts[5] == FORMAT):
                        await client.send_message("", ["/utm null"])
                        await client.send_message("", [f"/accept {args.human}"])
                        winner = await pokemon_battle(client, FORMAT, None)
                        emit("end", room=client.room, result="loss" if winner == args.bot else "win" if winner == args.human else "tie")
                        client.room = None
                        break


def main():
    args = arguments()
    sys.addaudithook(local_socket_only)
    logging.disable(logging.CRITICAL)
    output = sys.stdout

    def emit(kind, **fields):
        print(json.dumps({"type": kind, **fields}), file=output, flush=True)

    threading.Thread(target=watch_stdin, args=(lambda: os._exit(0),), daemon=True).start()
    with redirect_stdout(sys.stderr):
        try:
            asyncio.run(serve(args, emit))
        except Exception:
            import traceback
            traceback.print_exc()
            emit("error", code="foulplay-session-failed")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
