"""Loopback-only runner tests. Use the prepared Laplace Python to run integration tests."""

import asyncio
from contextlib import redirect_stderr
import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest


RUNNER = Path(__file__).resolve().parents[1] / "scripts" / "laplace" / "runner.py"
SPEC = importlib.util.spec_from_file_location("practice_runner", RUNNER)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
BOT = "Laplace0123456789"
HUMAN = "Player0123456789"
ROOM = "battle-gen9randombattle-1"
TOKEN = "a" * 48
SESSION_OPTIONS = ["--bot", BOT, "--human", HUMAN, "--threads", "4", "--token", TOKEN]


class PolicyTests(unittest.TestCase):
    def test_arguments_only_accept_local_names_and_numeric_ports(self):
        args = runner.arguments(["--port", "8000", *SESSION_OPTIONS])
        self.assertEqual((args.port, args.bot, args.human, args.threads), (8000, BOT, HUMAN, 4))
        args = runner.arguments(["--port", "8000", *SESSION_OPTIONS, "--bot", "Laplace", "--human", "Player"])
        self.assertEqual((args.bot, args.human), ("Laplace", "Player"))
        self.assertTrue(runner.arguments(["--check"]).check)
        for options in (
            ["--port", "wss://example.invalid", *SESSION_OPTIONS],
            ["--port", "65536", *SESSION_OPTIONS],
            ["--port", "8000", "--bot", "OtherBot", "--human", HUMAN, "--threads", "4"],
            ["--port", "8000", "--bot", BOT, "--human", "OtherPlayer", "--threads", "4"],
            ["--port", "8000", *SESSION_OPTIONS, "--threads", "9"],
            ["--port", "8000", *SESSION_OPTIONS, "--token", "x"],
            ["--port", "8000", *SESSION_OPTIONS[:-2]],
            ["--port", "8000", *SESSION_OPTIONS, "--password", "x"],
            ["--check", "--port", "8000"],
        ):
            with self.subTest(options=options), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    runner.arguments(options)
                self.assertEqual(raised.exception.code, 2)

    def test_socket_audit_allows_loopback_only(self):
        runner.local_socket_only("socket.connect", (None, ("127.0.0.1", 8000)))
        runner.local_socket_only("socket.getaddrinfo", ("127.0.0.1", 8000))
        for address in ("localhost", "example.invalid", "192.0.2.1", "::1"):
            with self.subTest(address=address):
                with self.assertRaises(PermissionError):
                    runner.local_socket_only("socket.connect", (None, (address, 8000)))
                with self.assertRaises(PermissionError):
                    runner.local_socket_only("socket.getaddrinfo", (address, 8000))

    def test_search_telemetry_is_bounded_and_hides_engine_state(self):
        session = runner.PracticeSession.__new__(runner.PracticeSession)
        events = []
        session.emit = lambda kind, **fields: events.append((kind, fields))
        session.room = ROOM
        battle = SimpleNamespace(turn=3)
        session.observe_search("turn_start", battle=battle)
        for _ in range(12):
            session.observe_search("world", res=SimpleNamespace(total_visits=500_000_000), state=object())
        session.observe_search("decision", battle=battle, ms=float("nan"), fallback=True,
                               ranked=[("private move", 0.7)])
        self.assertEqual(events, [
            ("thinking", {"room": ROOM, "turn": 3}),
            ("turn", {"room": ROOM, "turn": 3, "elapsedMs": 0, "visits": 2_147_483_647,
                      "worlds": 8, "fallback": True}),
        ])


@unittest.skipUnless(all(importlib.util.find_spec(name) for name in ("laplace", "websockets")),
                     "requires prepared Laplace Python")
class LoopbackTests(unittest.IsolatedAsyncioTestCase):
    async def start(self, *options):
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-I", "-B", str(RUNNER), *options,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        async def cleanup():
            if process.returncode is None:
                process.kill()
            await process.communicate()

        self.addAsyncCleanup(cleanup)
        return process

    async def event(self, process):
        line = await asyncio.wait_for(process.stdout.readline(), 20)
        self.assertTrue(line)
        return json.loads(line)

    async def test_offline_runtime_check(self):
        process = await self.start("--check")
        event = await self.event(process)
        self.assertEqual(event["type"], "checked")
        self.assertEqual(event["protocol"], 1)
        self.assertEqual(event["runtime"]["modelSha256"], runner.MODEL_SHA256)
        self.assertEqual(await asyncio.wait_for(process.wait(), 5), 0)
        self.assertEqual(await process.stdout.read(), b"")

    async def test_socket_login_challenge_battle_and_stop(self):
        from websockets.asyncio.server import serve

        connected = asyncio.get_running_loop().create_future()

        async def handler(websocket):
            connected.set_result(websocket)
            await websocket.wait_closed()

        async with serve(handler, runner.HOST, 0) as server:
            process = await self.start("--port", str(server.sockets[0].getsockname()[1]), *SESSION_OPTIONS)
            websocket = await asyncio.wait_for(connected, 20)
            self.assertEqual(websocket.request.path, f"/showdown/websocket?token={TOKEN}")
            await websocket.send("|challstr|1|local")
            self.assertEqual(await asyncio.wait_for(websocket.recv(), 5), f"|/trn {BOT},0,")
            await websocket.send(f"|updateuser| {BOT}|0|1")
            read_event = asyncio.create_task(self.event(process))
            await asyncio.sleep(0.1)
            self.assertFalse(read_event.done())
            await websocket.send(f"|updateuser| {BOT}|1|1")
            ready = await read_event
            self.assertEqual(ready, {"type": "ready", "protocol": 1, "bot": BOT, "human": HUMAN,
                                     "format": runner.FORMAT, "threads": 4, "determinizations": 8,
                                     "searchMs": 150})

            await websocket.send(f"|pm| Other| {BOT}|/challenge {runner.FORMAT}|{runner.FORMAT}|||")
            await websocket.send(f"|pm| {HUMAN}| Other|/challenge {runner.FORMAT}|{runner.FORMAT}|||")
            await websocket.send(f"|pm| {HUMAN}| {BOT}|/challenge gen9ou|gen9ou|||")
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(websocket.recv(), 0.15)
            await websocket.send(f"|pm| {HUMAN}| {BOT}|/challenge {runner.FORMAT}|{runner.FORMAT}|||")
            self.assertEqual(await asyncio.wait_for(websocket.recv(), 5), "|/utm null")
            self.assertEqual(await asyncio.wait_for(websocket.recv(), 5), f"|/accept {HUMAN.lower()}")

            await websocket.send(f">{ROOM}\n|init|battle\n|title|Other vs. {BOT}")
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(websocket.recv(), 0.15)
            await websocket.send(f">{ROOM}\n|init|battle\n|title|{HUMAN} vs. {BOT}")
            self.assertEqual(await self.event(process), {"type": "battle", "room": ROOM})
            await websocket.send(f"|pm| {HUMAN}| {BOT}|/challenge {runner.FORMAT}|{runner.FORMAT}|||")
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(websocket.recv(), 0.15)
            await websocket.send(f">{ROOM}\n|win|{HUMAN}")
            self.assertEqual(await asyncio.wait_for(websocket.recv(), 5), f"|/leave {ROOM}")
            self.assertEqual(await self.event(process), {"type": "end", "room": ROOM, "result": "win"})
            await websocket.send(f">{ROOM}\n|win|{HUMAN}")
            await websocket.send(f"|pm| {HUMAN}| {BOT}|/challenge {runner.FORMAT}|{runner.FORMAT}|||")
            self.assertEqual(await asyncio.wait_for(websocket.recv(), 5), "|/utm null")
            self.assertEqual(await asyncio.wait_for(websocket.recv(), 5), f"|/accept {HUMAN.lower()}")

            process.stdin.write(b"stop\n")
            await process.stdin.drain()
            self.assertEqual(await asyncio.wait_for(process.wait(), 5), 0)
            self.assertEqual(await process.stdout.read(), b"")

    async def test_socket_close_and_stdin_eof(self):
        from websockets.asyncio.server import serve

        for disconnect in (False, True):
            with self.subTest(disconnect=disconnect):
                connected = asyncio.get_running_loop().create_future()

                async def handler(websocket):
                    connected.set_result(websocket)
                    await websocket.wait_closed()

                async with serve(handler, runner.HOST, 0) as server:
                    process = await self.start("--port", str(server.sockets[0].getsockname()[1]),
                                               *SESSION_OPTIONS)
                    websocket = await asyncio.wait_for(connected, 20)
                    await websocket.send("|challstr|1|local")
                    self.assertEqual(await asyncio.wait_for(websocket.recv(), 5), f"|/trn {BOT},0,")
                    await websocket.send(f"|updateuser| {BOT}|1|1")
                    self.assertEqual((await self.event(process))["type"], "ready")
                    if disconnect:
                        await websocket.close()
                        self.assertEqual(await self.event(process), {"type": "error", "code": "disconnected"})
                    else:
                        process.stdin.close()
                        await asyncio.wait_for(websocket.wait_closed(), 5)
                    self.assertEqual(await asyncio.wait_for(process.wait(), 5), int(disconnect))
                    self.assertEqual(await process.stdout.read(), b"")

    async def test_redirect_cannot_connect_to_a_second_port(self):
        from websockets.asyncio.server import serve

        second_port_touched = asyncio.Event()

        async def track_connection(reader, writer):
            second_port_touched.set()
            writer.close()
            await writer.wait_closed()

        async with await asyncio.start_server(track_connection, runner.HOST, 0) as destination:
            second_port = destination.sockets[0].getsockname()[1]

            def redirect(connection, request):
                response = connection.respond(302, "Redirect")
                response.headers["Location"] = f"ws://{runner.HOST}:{second_port}/showdown/websocket"
                return response

            async def handler(websocket):
                await websocket.wait_closed()

            async with serve(handler, runner.HOST, 0, process_request=redirect) as server:
                process = await self.start("--port", str(server.sockets[0].getsockname()[1]), *SESSION_OPTIONS)
                event = await self.event(process)
                self.assertEqual(event["type"], "error")
                self.assertEqual(await asyncio.wait_for(process.wait(), 5), 1)
                self.assertFalse(second_port_touched.is_set())


if __name__ == "__main__":
    unittest.main()
