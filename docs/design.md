# Showdown Desktop: design

| | |
| --- | --- |
| **Status** | Living document. Describes v0.2.0 (`main` at `bc5ec62`). |
| **Last reviewed** | 2026-11-12 |
| **Scope** | The whole app: launcher shell, Showdown bridge, replay notes, Showdex, hosted battle service, and the two practice bots (Foul Play and Laplace). |
| **Related** | [Practice bots](bots.md) · [Playable bots](playable-bots.md) · [Laplace performance](laplace-performance.md) · [Replay review](replay-review.md) · [Replay backups](replay-backups.md) · [Windows delivery](windows.md) |

This document explains *what* the app is, *how* it is built, and *why* the main decisions were made. Setup steps, measurements and checklists live in the related documents; this one links to them rather than repeating them. Figures marked *(snapshot)* were true on the date above and are expected to drift.

## Contents

1. [Context](#1-context)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Architecture](#3-architecture)
4. [Features](#4-features)
5. [Hosted practice service](#5-hosted-practice-service)
6. [Practice bots](#6-practice-bots)
7. [Key decisions](#7-key-decisions)
8. [Security and privacy](#8-security-and-privacy)
9. [Testing](#9-testing)
10. [Build and packaging](#10-build-and-packaging)
11. [Risks and open questions](#11-risks-and-open-questions)
12. [Appendix: visual design tokens](#appendix-visual-design-tokens)

## 1. Context

Pokémon Showdown is played in a browser tab. A tab loses its place among other tabs, gives tools such as damage calculators and replay notes no stable home, and offers no safe way to practise against strong bots: any automated play on the public server uses a real account and the public ladder.

Showdown Desktop is an Electron 45 / Node 24 app that hosts the **unmodified** official client in a dedicated window, adds a launcher shell and tools around it, and runs bot practice on a **private** simulator that never touches the player's account.

**Audience.** Competitive Showdown players who want one app window that keeps their session and tools together, and who want to practise against strong engines without touching their online account.

## 2. Goals and non-goals

**Goals**

- G1. A downloadable Windows app that installs and runs with no development tools.
- G2. The official client stays fully playable at all times. Every added layer fails safe back to plain Showdown.
- G3. Add value around the client: a home hub, replay notes and in-app review, an optional damage calculator, and bot practice.
- G4. Practise against strong engines (Laplace and Foul Play) through a private hosted battle service.
- G5. A distinctive visual identity: cobalt light and steel-blue dark themes, flat and colorful.

**Non-goals**

- Forking or re-implementing the Showdown client or battle simulator.
- Running bots on the player's computer as a feature. Practice is service-only (owner decision, 2026-11-12). The direct local path stays in the code only as a test harness and as the base for self-hosting ([bots.md §7](bots.md#7-development-and-self-hosting-harness)).
- Automating play on the user's real account. The app never searches, challenges or plays by itself, and tests use simulated sessions.
- Hosting replays. Showdown hosts them; the app stores only links and notes.
- Rating bots as Elo players. Practice settings are computation budgets, not skill levels.

**Priority.** Features first. Clean-machine installation, signing, licensing and public release come last.

## 3. Architecture

One Electron window hosts three kinds of web content with different trust levels. The main process owns all state, files, child processes and secrets.

```mermaid
flowchart LR
  subgraph Window["Electron window"]
    L["Launcher pages<br/>(trusted, preload)"]
    S["Showdown client view<br/>(untrusted, no preload)"]
    P["Practice view<br/>(sandboxed, no preload)"]
    R["Replay review view<br/>(untrusted, no preload)"]
  end
  M["Main process<br/>state · IPC · files · secrets"]
  L <-- "named IPC channels" --> M
  M -- "allowlisted bridge" --> S
  M --> R
  M --> HS["Hosted battle service<br/>(HTTPS, bearer key)"]
  HS --> RT["Per-session runtime on the server<br/>simulator + bot (server loopback)"]
  P -. "WebSocket + capability URL" .-> HS
  S -. "HTTPS" .-> PS["play.pokemonshowdown.com"]
```

### Components

| Part | Where | Trust and isolation |
| --- | --- | --- |
| Main process (`app/main.js`) | Electron main | Owns windows, IPC, settings, replay storage, logs, practice lifecycle and the service key |
| Launcher pages (`renderer/*.html`) | `BrowserWindow` | Get `window.desktop` from `app/preload.js`; every call is a named IPC channel |
| Showdown client view | `WebContentsView`, partition `persist:showdown` | Loads `play.pokemonshowdown.com`; no preload, no Node; themed by injected CSS; popups only for Google sign-in |
| Showdown bridge (`app/showdown.js`) | Main, runs functions in the client page | Reads a sanitized snapshot (user, formats, teams, news, rooms, friends) and sends allowlisted actions: search, cancel, challenge, join, focus, leave, edit team, login |
| Practice view (`app/practice-view.js`) | `WebContentsView` | Patched classic client; no preload, no Node; connects only to its hosted practice session |
| Replay review (`app/replay-review.js`) | `WebContentsView` | Official replay player beside the note editor |
| Showdex (`app/showdex-integration.js`) | Custom scheme inside the client view | Optional pinned build, verified by SHA-256 manifest |
| Hosted practice (`app/hosted-practice.js` ↔ `scripts/bots/service.cjs`) | Remote service | Bearer-key REST and per-session WebSocket gateway. Each session runs a `PracticeRuntime` (simulator and bot child processes, loopback only) on the server |

### Data flow

- **Online play.** Launcher pages ask main for a snapshot. Main runs `readClient()` inside the Showdown page and sanitizes the result (IDs by regex, strings length-capped, sprite paths checked). Actions go the other way, validated against an allowlist, with arguments passed as JSON and never spliced into code. When a battle room opens, the launcher switches to the client view.
- **Practice.** The Practice page asks main to start a session with an opponent and preset. Main's `HostedPractice` creates the session on the battle service with the operator key and polls its status. Once the bot is ready, the practice view loads from the session's capability URL and talks to the server only through that session's WebSocket gateway.
- **Storage.** Settings, window state and `replays.json` live in Electron's userData folder (`%APPDATA%/showdown-desktop`), written atomically (temp file, then rename). Showdown's own login, teams and preferences live in the `persist:showdown` partition, separate from launcher data. Logs record fixed event names and numeric codes only.

### Repository layout

| Path | Contents |
| --- | --- |
| `app/` | Main-process modules, preload, injected client/replay/Showdex CSS |
| `renderer/` | Launcher pages: Home, Showdown, Practice, Replays, Settings, shared nav and styles |
| `scripts/laplace/` | Laplace build scripts, simulator wrapper, Python runner, benchmark (used on the service host) |
| `scripts/bots/` | Foul Play setup, adapter, hosted battle service, bot test driver, source lock |
| `vendor/laplace/`, `vendor/showdex/` | Source pins, licenses, runtime lock, patched practice client shell |
| `deploy/bots/` | Dockerfile, Compose file and Caddyfile for the hosted service |
| `tests/` | Node unit tests, Python runner tests, Electron desktop and live smoke drivers |
| `docs/` | Feature, performance, packaging and hosting documentation |

## 4. Features

Six user-facing areas: Home, the Showdown client, Practice, Replay notes and review, Showdex, and Settings. Each degrades to plain Showdown when it fails (G2).

**Launcher shell and navigation**

- Left rail: Home, Showdown, Practice, Replay notes, Settings. A Showdown section lists open rooms (battles, chats, teambuilder, ladder) and a **Join a room** button; it appears only while rooms are open.
- The client stays loaded across page changes, so navigating never loses a live battle.
- A newly started battle switches to the Showdown view and takes priority over other pages. Home shows a **Return to battle** banner while one is running.
- Fail-safe shell: if the launcher cannot drive rooms, the client's own tabs are restored.

**Home hub**

- Cobalt battle hero: format picker, team picker with sprites of the selected team, **Battle** (search), **Cancel**, **Challenge a user**. Searching shows an animated state and runs in the background.
- Account status and ratings (cached 2 minutes), user and battle counts.
- Tiles for Teambuilder and Watch a battle, the latest three Showdown news posts, chat rooms, recent replay notes.
- Friends panel from structured presence data (online, idle, busy, offline as reported), refreshed at most every 30 s, with **Open friends list** as fallback. No battle links or avatars are inferred.

**Showdown client**

- The official client in a persistent partition, so sign-in survives restarts.
- Injected cobalt-light / steel-blue-dark theme that preserves Pokémon type, HP and stat colors.
- External links open in the system browser; only Google sign-in may open a popup.

**Practice against bots**

- Gen 9 Random Battle against **Laplace** or **Foul Play**.
- Presets **Quiet** (1 search thread), **Balanced** (2) and **Full** (8, default). These are CPU budgets, not difficulty levels.
- Moves, switching, Terastallization, Forfeit, rematch (**Next battle**) and explicit **Stop practice…**. Status shows starting, ready, thinking, turn, elapsed time and result.
- Runs on the private hosted battle service; nothing is installed or computed on the player's PC. Online and practice games stay loaded side by side.

**Replay notes and review** (details: [replay-review.md](replay-review.md), [replay-backups.md](replay-backups.md))

- Save a replay link with title, format and notes (title 120 chars, notes 5,000, up to 1,000 entries / 8 MiB). **Save replay note** on a battle prefills players and format.
- Search by title, format and note text; **Ctrl+F**, **Escape**, **Ctrl+S**. Duplicate links offer the existing note.
- **Review replay** shows the official replay player beside the note editor. Unsaved drafts survive navigation.
- **Export notes…** to JSON; **Import notes…** with a review step, per-note conflict choice, and **Undo import…** until notes change or the app restarts.

**Showdex (optional)**

- Pinned Showdex 1.4.2 with a recorded readiness patch, verified against a committed SHA-256 manifest. Enabled in Settings; takes effect only after an explicit client reload.
- Themed to match the app while keeping calculator colors. Excluded from packaged builds until its distribution licensing is decided.

**Settings**

- Appearance (system, light, dark), start page, confirm on close, Showdex toggle, explicit client reload, open logs.
- **Sign out** clears the Showdown partition (including local teams). **Reset launcher** clears settings, preferences and replay notes but keeps the Showdown session. Both confirm first.
- Window size, position and maximized state are remembered, and repositioned if a monitor disappears.

## 5. Hosted practice service

Every practice game is a real Showdown battle on a private simulator, run on the battle service, that only the player's session and one bot can reach. Setup and hosting steps: [playable-bots.md](playable-bots.md). Message-level protocols: [bots.md §3](bots.md#3-protocols).

### Session lifecycle on the server (`app/practice-runtime.js`)

The service creates one `PracticeRuntime` per session:

1. **Validate.** Opponent is `laplace` or `foulplay` (Foul Play only if configured); preset is `quiet`, `balanced` or `full`; no session is running.
2. **Mint identities.** A fresh 256-bit hex token; fixed names `Player` and `Laplace` or `FoulPlay`. A 120 s startup timeout starts.
3. **Verify the runtime.** A worker thread checks every payload file's size and SHA-256 against the v2 manifest. Foul Play has its own recorded inventory. Stop cancels verification.
4. **Start the simulator.** `server.cjs` runs under Electron's Node (`ELECTRON_RUN_AS_NODE`) on an OS-chosen port bound to `127.0.0.1` and reports `{type: "ready", port}`.
5. **Start the bot.** `python -I -B runner.py` (or `foulplay.py --source …`) with port, token, names and thread count, at below-normal priority with a minimal environment (`OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`).
6. **Check the handshake.** The bot's `ready` event must echo the exact protocol, names, format, thread count and search settings (Laplace: 8 worlds, 150 ms; Foul Play: 100 ms). Any mismatch fails the session.
7. **Play.** The player's practice view loads the patched classic client from the service, connects through the gateway and challenges the bot. Bot events reach the Practice page through session status.
8. **Stop.** Stop, failure, client disconnection or expiry ends both children (stdin closed, then killed). A `generation` counter discards late events from an old session.

### Simulator hardening (`scripts/laplace/server.cjs`)

- Pinned Showdown server `a9caa4c`, loaded with an in-memory config: loopback bind, no subprocesses, file writes, network requests, login server, ladder or logging.
- Outbound `Socket.connect` and `fetch` are replaced with functions that throw.
- Plain HTTP requests get 404. A WebSocket upgrade is accepted only from `127.0.0.1` with the exact `Host` header and `/showdown/websocket?token=<token>` path.
- stdout is reserved for the JSON protocol; upstream logging goes to stderr. The server exits when the parent pipe closes.

### Practice client and view

- The classic Showdown client (AGPL-3.0, pinned `49b5420`) is built with recorded, anchor-checked patches: connect straight to the practice socket, skip the public server, keep navigation inside the room, adjust Forfeit and close-room behavior. Rendering and controls stay upstream.
- `client-bootstrap.js` validates the session address and names before anything loads.
- The view is sandboxed with context isolation, no Node and no preload. All permission requests are denied. Requests are allowed only to the session's own client files and server and official Showdown artwork; audio, downloads, popups and arbitrary navigation are blocked.

### Hosted service (`scripts/bots/service.cjs`)

The service wraps the same `PracticeRuntime` per session behind HTTPS. The launcher's `HostedPractice` polls it every second and keeps the operator key in the main process only.

Its REST API, WebSocket gateway, limits and session expiry are specified in [bots.md §3.1](bots.md#31-launcher--battle-service-https).

- `deploy/bots/` builds a Linux x64 image behind Caddy HTTPS with initial caps of 1 session, 4 CPUs, 4 GiB and 128 processes. Caddy keeps no access log because URLs carry capability tokens. Only ports 80 and 443 are public.
- Not built: persistence, resume after restart, queueing, horizontal routing, per-user credentials and quotas.

### Pins

| Component | Pin |
| --- | --- |
| Python | 3.12.16 (`python:3.12.16-slim-bookworm` service image) |
| Laplace | `8b4173d`, MIT; model SHA-256 `502a47a5…` |
| poke-engine (Laplace) | 0.0.47 from hashed sdist, Rust 1.96.0, Tera feature |
| Foul Play | `8f541f8`, GPL-3.0; poke-engine 0.0.48; separate venv |
| Random-battle data (Foul Play) | `pkmn/randbats` `684abfa`, SHA-256 in `scripts/bots/lock.json` |
| Showdown simulator | `smogon/pokemon-showdown` `a9caa4c`, MIT |
| Classic client | `smogon/pokemon-showdown-client` `49b5420`, AGPL-3.0 |

## 6. Practice bots

Foul Play and Laplace are fully described, including every protocol layer, in **[bots.md](bots.md)**. In short:

- Both are real Showdown players on a private simulator. They log in, accept the player's challenge, read the standard battle protocol and send standard `/choose` commands.
- Both handle hidden information by **determinization**: they sample plausible complete opponent teams, search each one with poke-engine's decoupled MCTS, and combine the root visit shares.
- **Foul Play** (GPL-3.0) searches 2–4 worlds of 50–100 ms and picks randomly among options with at least 75% of the best share.
- **Laplace** (MIT, the owner's project) searches 8 worlds of 150 ms. It then applies deterministic guards and a small value net that re-ranks near-ties, and samples among un-vetoed options with at least 90% of the best.
- Each bot reports to its supervisor with one JSON event per line on stdout and stops on `stop` written to stdin.

## 7. Key decisions

Each entry records the choice, the alternative it was weighed against, and why.

| # | Decision | Alternative | Rationale |
| --- | --- | --- | --- |
| D1 | Host the unmodified official client | Fork or re-implement the client | Stays current with Showdown automatically; the app's layers can fail without breaking play (G2). |
| D2 | Talk to the client through a sanitized, allowlisted bridge run from main | Give the client view a preload or Node | The client is remote, untrusted content. Named actions with JSON arguments keep the attack surface to a fixed list. |
| D3 | Separate partition `persist:showdown` for the client | Share the launcher's session storage | Sign-in survives restarts, and Sign out / Reset launcher can clear one without the other. |
| D4 | Practice on a private simulator on the battle service | Bot plays on the public server | No account, ladder or public traffic is involved, which makes automated play on real accounts impossible by construction. |
| D5 | Loopback enforced twice (server listener checks and Python audit hooks) | Rely on the bind address alone | A bug or proxy setting in one layer cannot send a bot to a public destination. |
| D6 | Presets are CPU budgets (1 / 2 / 8 threads) | Named difficulty levels | Thread count is what the setting actually changes; difficulty names would imply strength claims that are not measured. |
| D7 | Bots run only on the hosted service | Also run them on the player's PC | Owner decision (2026-11-12). Players' results do not depend on their CPU, and only one deployment serves players. The direct path is kept for testing and future self-hosting. |
| D7a | On the server, bots run as child processes speaking newline-delimited JSON | In-process bindings | Isolates crashes and gives Stop a single process tree to end. |
| D8 | Foul Play searches in threads, not processes | Upstream `ProcessPoolExecutor` | Stop cannot leave orphaned worker processes. |
| D9 | A rejected Foul Play choice ends the session | Fall back to a random move | The bot is never silently weakened; failures are visible. |
| D10 | Laplace pools by plain average | Robust (vote-based) pooling | Sets are already sampled by frequency, so the average is likelihood-weighted. |
| D12 | Every third-party input pinned by revision or hash | Track upstream | Reproducible builds and a recorded license position per component. |
| D13 | Hosted service reuses `PracticeRuntime` per session | A separate server implementation | One tested lifecycle for every session. |

## 8. Security and privacy

- **No automated play on real accounts.** The app and its tests never search, challenge or play on the user's account. Desktop tests use simulated sessions; live tests are guest-only and spectate.
- **Least privilege per view.** Only launcher pages get a preload. The Showdown, practice and replay views have no Node and no preload.
- **Allowlisted bridge.** Actions are named and validated; arguments travel as JSON, never as code. Snapshots are sanitized before they reach launcher pages.
- **Loopback-only bots on the server.** See D4 and D5. No credentials or public destinations are accepted from a player.
- **Private logs.** Fixed event names and numeric codes only: no usernames, credentials, replay URLs or note text.
- **Service secrets.** The operator key stays in the main process; session URLs are capability tokens and are never access-logged.
- **Pinned, verified inputs.** Manifests detect inconsistency; they are not publisher signatures.
- **Explicit destructive actions.** Sign out and reset ask first; Showdex changes need an explicit client reload.

## 9. Testing

| Command | Covers |
| --- | --- |
| `npm run check` | Syntax checks |
| `npm test` | Node unit tests: bridge sanitization, action validation, navigation timing, settings, replays, imports, practice manifest and runtime, bot service and integrity |
| `npm run test:desktop` | Electron suites with temporary profiles and simulated Showdown responses; outbound client traffic blocked; screenshots in `out/desktop-smoke/` |
| `npm run test:practice`, `npm run test:bots`, `tests/bots-games.py` | Real games against both bots, directly and through the service ([bots.md §7](bots.md#7-development-and-self-hosting-harness)) |
| `tests/bots-games.py` | Complete games per bot against a heuristic test player; result agreement and pipe shutdown |
| Python runner tests | `tests/laplace_runner_test.py` and related |
| `test:showdex:live`, `test:replays:live`, `test:shell:live` | Optional guest-only network checks |
| `smoke:packaged`, `smoke:practice-packaged` | The unpacked package, including a real bot game through the bundled test runtime |

These are integration checks, not strength benchmarks. *(snapshot)* All suites passed on Windows on 2026-11-11.

## 10. Build and packaging

- `npm run pack:win` builds an unsigned Windows x64 NSIS installer in `out/windows/`; `pack:win:dir` builds an unpacked app for inspection. See [windows.md](windows.md).
- `pack:win` requires a verified Laplace runtime from `npm run build:practice`; test packages bundle it outside `app.asar` so the harness can run, and package hooks re-verify every copied file. Players use the hosted service, whose bots are built into its image (`deploy/bots/Dockerfile`).
- Showdex is excluded from packages until its distribution licensing is settled.
- Nothing is published automatically; there is no auto-updater.

## 11. Risks and open questions

### Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Showdown client changes upstream | Bridge reads or theme selectors break | Fail-safe shell restores the client's tabs; live drift check; guest smoke tests |
| Service CPU limits | Same wall time but far fewer search visits on fewer cores (−46% at 4 CPUs, −68% at 2 for Full) | Presets are honest CPU budgets; size the service host by measurement |
| Licensing | AGPL/GPL obligations for bundled components | Source archives and notices retained; owner review before public release |
| Shared service key | Anyone with the key can start sessions | Private testers only; per-user credentials and quotas before any public service |
| Single-replica service | A restart ends every battle | Documented; sticky routing or external session state needed to scale |

### Open decisions

- [ ] The project's own license, and distribution of the patched AGPL classic client, GPL Foul Play and Showdex.
- [ ] Code signing and release branding (the installer uses Electron's default icon).
- [ ] Whether Showdex ships in packages.
- [ ] How invited testers get hosted-service access (today a shared key).

### Verification outstanding

- [ ] Signed-in checks by the owner: session persistence, ratings, team selection, challenges, a real search becoming a battle, friends data, rail forfeit popup, post-battle result bar.
- [ ] Clean Windows 11 install, upgrade, uninstall and reinstall at 100% and 125% scaling ([checklist](windows-installer-checklist.md)).
- [ ] Linux image and a real HTTPS deployment of the battle service, including move latency under the container's CPU caps.

### Not designed yet

- Incoming challenges and PMs inside the launcher.
- What replaces Showdown's own home screen; Practice view chrome.
- Practice formats beyond Gen 9 Random Battle.
- macOS and Linux packages, an auto-updater, a website or store listing.

## Appendix: visual design tokens

Two themes share one identity: a cobalt rail, a cobalt Home hero and a Showdown-yellow primary button. Light is **Cobalt**; dark is **Steel blue**, deliberately blue rather than charcoal or grey. Components use role tokens only. A color change edits the token in both theme blocks of `renderer/styles.css` and the matching `--sd-*` value in `app/client-theme.css`.

| Token | Cobalt (light) | Steel blue (dark) | Use |
| --- | --- | --- | --- |
| `--bg-app` | `#e6ecf5` | `#24304a` | Window background |
| `--bg-panel` | `#ffffff` | `#2c3a57` | Panels and cards |
| `--text` | `#15223a` | `#f1f4fa` | Primary text |
| `--accent` | `#2459b8` | `#7db2ff` | Links, focus, selection |
| `--primary` | `#f5c42c` | `#f5c42c` | One primary button per region |
| `--rail-bg` | `#1f4b9a` | `#193f85` | Navigation rail |

Rules: flat and dense; color always has a job; no purple, gradients, glassy buttons or web fonts; waiting states animate, with reduced motion respected. Pokémon type, HP, stat and damage colors are never restyled. Subjective visual changes are mocked up as 2–3 options for the owner to choose before they are built.
