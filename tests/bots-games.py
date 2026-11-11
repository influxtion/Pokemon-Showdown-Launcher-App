"""Complete two private games per bot, including a rematch on the same worker."""
import asyncio
from contextlib import AsyncExitStack
import importlib.util
import json
import logging
from pathlib import Path
import secrets
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("local_test", ROOT / "tests/laplace-local.py")
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


async def main():
    from poke_env import AccountConfiguration, ServerConfiguration
    from poke_env.player import SimpleHeuristicsPlayer
    from websockets.asyncio.client import connect
    config = json.loads((ROOT / "out/bots/config.json").read_text())
    results = []
    for opponent, bot in (("foulplay", "FoulPlay"), ("laplace", "Laplace")):
        async with AsyncExitStack() as stack:
            token = secrets.token_hex(32)
            server = await stack.enter_async_context(local.child("node", str(ROOT / "scripts/laplace/server.cjs"),
                "--server-root", str(Path(config["root"]) / "server"), "--port", "0", "--token", token))
            port = (await local.event(server, "ready"))["port"]
            command = ([config["foulPlayPython"], "-I", "-B", str(ROOT / "scripts/bots/foulplay.py"), "--source", config["foulPlaySource"]]
                       if opponent == "foulplay" else [config["laplacePython"], "-I", "-B", str(ROOT / "scripts/laplace/runner.py")])
            process = await stack.enter_async_context(local.child(*command, "--port", str(port), "--token", token,
                "--bot", bot, "--human", "Player", "--threads", "2", stop=True))
            await local.event(process, "ready")
            url = f"ws://127.0.0.1:{port}/showdown/websocket?token={token}"
            websocket = await stack.enter_async_context(connect(url, proxy=None, close_timeout=2))
            finished_rooms = set()

            class GameSocket:
                def __aiter__(self):
                    return self

                async def __anext__(self):
                    while True:
                        message = await websocket.recv()
                        if '|popup|' in message:
                            raise RuntimeError(message)
                        if message.split("\n", 1)[0].removeprefix(">") not in finished_rooms:
                            return message

                async def send(self, message):
                    await websocket.send(message)

            game_socket = GameSocket()
            player = SimpleHeuristicsPlayer(account_configuration=AccountConfiguration("Player", None),
                server_configuration=ServerConfiguration(url, ""), battle_format="gen9randombattle",
                start_listening=False, loop=asyncio.get_running_loop())

            async def collect():
                decisions = 0
                while True:
                    event = await local.event(process, timeout=90)
                    if event["type"] == "turn":
                        decisions += 1
                    if event["type"] == "end":
                        assert decisions > 0
                        return event["room"], event["result"], decisions

            for game in range(2):
                if game:
                    player.reset_battles()
                    await player.ps_client.challenge(bot.lower(), "gen9randombattle", None)
                async with asyncio.timeout(600):
                    human_result, bot_result = await asyncio.gather(local.human_game(game_socket, player, "Player", bot), collect())
                assert tuple(bot_result[:2]) == human_result
                finished_rooms.add(human_result[0])
                result = {"opponent": opponent, "game": game + 1, "room": human_result[0], "humanResult": human_result[1], "decisions": bot_result[2]}
                results.append(result)
                print(json.dumps(result), flush=True)
            process.stdin.close()
            assert await asyncio.wait_for(process.wait(), 10) == 0
    (ROOT / "out/bots/games-result.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    asyncio.run(main())
