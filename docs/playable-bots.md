# Playable bots and contributor hosting handoff

How the bots decide and every protocol they speak are described in [bots.md](bots.md). This document covers setup, hosting and verification.

Practice now offers **Laplace** and **Foul Play**, with Gen 9 Random Battle teams supplied by the simulator. Both support moves, switching, Terastallization, Forfeit, rematch, explicit Stop, and leaving the Practice page without losing the battle. Computation settings are CPU settings, not invented difficulty ratings. PS-PPO is excluded at the owner's request.

The existing Electron launcher is the client. The engines run only on a separately hosted battle service, never on the player's computer. The online Showdown partition, account and public ladder are independent. No cloud resources have been provisioned, no public bot accounts created, and no installer rebuilt.

## Development setup

These steps prepare a development copy of the battle service; players never run them. Node 24, Python 3.12, Git and a Rust toolchain are prerequisites. Windows native engine builds also need the compiler described in `vendor/laplace/SOURCE.md`.

```powershell
npm ci
npm run bots:setup -- --runtime 'C:\absolute\path\to\vendor\laplace\dist'
```

The `--runtime` path is a Laplace runtime built with `npm run build:practice`. Setup clones the pinned Foul Play revision, creates its separate Python environment, builds its Gen 9 engine, downloads hash-checked random battle data, checks both engines, and writes `out/bots/config.json` and `integrity.json`. The development service loads that config. Paths and generated dependencies stay out of Git. An alternate config can be selected with `SHOWDOWN_BOT_CONFIG`.


Do not run setup while sessions are active. Setup is a development preparation command, not a consumer installer. Its Python environments remain tied to their preparation directory and Python installation. The existing standalone Laplace runtime remains separately verified; Foul Play and Linux inputs have their own recorded file inventory, checked asynchronously before launching. Canceling startup cancels verification. These inventories detect local inconsistency; they are not publisher signatures.

## Exercise the service on a development machine

In one PowerShell terminal, from this checkout:

```powershell
$env:BOT_SERVICE_KEY = '<a random secret of at least 32 characters>'
npm run bots:serve
```

In the terminal that starts the launcher:

```powershell
$env:SHOWDOWN_BOT_SERVICE_URL = 'http://127.0.0.1:8787'
$env:SHOWDOWN_BOT_SERVICE_KEY = '<the same secret>'
npm start
```

The local service defaults to IPv4 loopback. The launcher now downloads the sandboxed battle client from the service and connects through its WebSocket gateway. The player's machine needs no bot runtime. Without the two `SHOWDOWN_BOT_SERVICE_*` variables, a development launcher uses the direct test harness instead ([bots.md §7](bots.md#7-development-and-self-hosting-harness)).

Normal `npm start` opens the app normally. Test drivers use `SHOWDOWN_DESKTOP_BACKGROUND=1`: the test window is non-focusing, transparent and ignores mouse input. Captures still come from its web contents; tests no longer use always-on-top or window focus.

## Deploy later

`deploy/bots/Dockerfile` builds the Linux x64 environment; `deploy/bots/compose.yaml` supplies a single battle service behind Caddy HTTPS. It is a stateful service with long-lived WebSockets and CPU workers. The contributor can deploy it on a Linux VM with Docker Compose, including a VM they provision in Google Cloud. Cloud provisioning, DNS and production operations remain their task.

From the repository root on that machine:

```sh
export BOT_DOMAIN=bots.example.org
export BOT_SERVICE_KEY='<a newly generated long random secret>'
export BOT_MAX_SESSIONS=1
docker compose -f deploy/bots/compose.yaml build
docker compose -f deploy/bots/compose.yaml up -d
```

Point DNS at the machine, allow inbound TCP 80 and 443 for Caddy, and leave port 8787 and all simulator ports private. `BOT_SERVICE_ORIGIN` is the exact external HTTPS origin; the reverse proxy must preserve the Host header. Caddy's supplied configuration does that and supports WebSocket upgrades. It deliberately has no access-log directive because session URLs contain private capability tokens.

Set `SHOWDOWN_BOT_SERVICE_URL=https://bots.example.org` and the shared key on an invited tester's launcher. For now, address/key configuration is operator-managed through environment variables. Do not put the shared key in a public launcher build. This is an authenticated private service, not a public multi-user identity system; per-user credentials, fair-use quotas and public distribution configuration remain a later deployment step.

The Compose limits (one simultaneous session, four CPUs, 4 GiB memory, 128 processes) are initial resource caps, not measured hosting recommendations. Measure the actual VM before increasing concurrency. Each active session owns one simulator and one bot; their Python versions/dependencies never share an environment. A full thread setting inside a CPU-capped container is still constrained by that container.

The service rejects excess sessions with a retry message. It removes sessions after one hour, five minutes without activity, two minutes without a client connection, or ten seconds after the client disconnects. Stop deletes the session immediately. A crashed launcher is cleaned up through socket closure and expiry; server restarts end in-memory battles. There is no persistence, reconnection/resume after restart, queue or horizontal routing yet. Use one replica until sticky session routing or external session ownership is implemented.

The contributor must build and test the Linux image and real HTTPS deployment before inviting users. The local service tests validate the API/WebSocket path on Windows; they do not prove Docker, Caddy certificate issuance, cloud firewall settings or Linux native-library portability. Image tags and Python package versions are specified, but the Linux image is not a bit-for-bit reproducible release artifact or a signed distribution.

## API and isolation

All `/v1` calls require `Authorization: Bearer <operator key>` and do not enable browser CORS.

| Method and route | Purpose |
| --- | --- |
| `GET /healthz` | Service process health; not an engine-readiness claim |
| `GET /v1/bots` | Opponent availability |
| `POST /v1/sessions` | Body `{ "opponent": "laplace" or "foulplay", "preset": "quiet" or "balanced" or "full" }`; returns session ID |
| `GET /v1/sessions/:id` | Startup, failure, turn and result status |
| `DELETE /v1/sessions/:id` | Stop and clean up |
| `GET /s/:id/practice-client.html` | Capability-protected client and its assets |
| `WS /s/:id/websocket` | One human connection, proxied to that session's loopback simulator |

The gateway never accepts executable paths, shell commands, usernames, public server destinations or arbitrary battle formats from a player. Session IDs and simulator tokens are separate random 256-bit values. Each simulator binds only to 127.0.0.1, uses local unregistered identities, disables login-server/outbound calls, and has no public credentials. The bot adapters independently restrict sockets to loopback. The remote view has no Node or preload, denies permissions/downloads/popups, and allows assets only from its own session plus official artwork. The operator key stays in Electron's main process, outside the battle page.

## Sources and adapter behavior

- Laplace: `8b4173dfdabff12e9228310ba25e3fd2ed5117df`, MIT; engine 0.0.47 and the already-pinned value model. Eight sampled worlds, 150 ms per world, selected 1/2/8 search threads. Runtime source/notice records are in `vendor/laplace/SOURCE.md`.
- Foul Play: [`8f541f80f91f960603673796559f796b10ccf0fb`](https://github.com/pmariglia/foul-play/tree/8f541f80f91f960603673796559f796b10ccf0fb), GPL-3.0; engine 0.0.48 with Terastallization. Uses upstream battle parsing, state sampling, search and choice formatting. The adapter replaces online authentication/challenge handling, suppresses chat and battle timers, and uses one in-process search executor so Stop cannot leave search pools behind. Sampling parallelism is one, base search time 100 ms, with 1/2/8 native search threads. This is not a claim of upstream ladder strength.
- Foul Play random battle data: [`pkmn/randbats` at `684abfa`](https://github.com/pkmn/randbats/tree/684abfaaba8e163532dfff73465c734e3432314a), exact URL/SHA-256 in `scripts/bots/lock.json`.
- Simulator/classic client are the pinned upstream sources recorded in `vendor/laplace/SOURCE.md`. The hosted bootstrap uses same-origin secure WebSockets under HTTPS and HTTPS artwork even for local HTTP development.

Clones retain source and license files, and Python dependencies retain package notices. The app's own license choice and final distribution review are still open. No new project license is selected by this branch.

## Verification

```powershell
npm run check
npm test
npm run test:desktop
npm run test:bots
# Run with the prepared Laplace Python, which has poke-env:
& '<runtime>\python\python.exe' -I -B tests/bots-games.py
```

`test:bots` runs real Electron games for both opponents, directly and through the service. It checks upstream move/Tera/switch controls, both window sizes/themes, navigation retention, Stop, Forfeit/rematch, renderer crash and hidden disconnection cleanup. All sessions use disposable profiles and private servers; online Showdown traffic is blocked in the harness. `bots-games.py` completes two games per opponent against a heuristic test player and checks rematch result agreement and parent-pipe shutdown. These are integration checks, not a strength benchmark.

Verified on Windows on November 11, 2026: syntax checks; 105 JavaScript unit tests passed (one optional staged-server test skipped); 12 Python runner tests passed; all five existing desktop suites passed; all four real bot desktop combinations passed. Complete-game checks finished two games per opponent with matching client/worker results and clean parent-pipe shutdown (Foul Play: 22 and 31 decisions; Laplace: 25 and 21). Screenshots and the game report are in ignored `out/desktop-smoke/` and `out/bots/games-result.json`. Linux container build and cloud deployment remain unverified.
