# Laplace practice development runtime

The runtime under `dist/` is generated and ignored. It is currently a local feasibility build, not a published release asset. No credentials, personal logs, saved games or developer server configuration belong in it.

## Sources

- [Laplace](https://github.com/influxtion/Laplace-Pokemon-Showdown-AI), MIT, revision `8b4173dfdabff12e9228310ba25e3fd2ed5117df`.
- [Pokémon Showdown server](https://github.com/smogon/pokemon-showdown), MIT, revision `a9caa4cabe89459b00e717a47148d0f67b4451ae` for simulation.
- [Pokémon Showdown classic client](https://github.com/smogon/pokemon-showdown-client), AGPL-3.0, revision `49b54209ebee54ceb8fff62a5eb5bedf7efcf6dc`. Its build tooling uses server data revision `202b6b385c2536977c60a97bf12d931c2d449586`; this does not replace the simulator.
- [Python 3.12.10 Windows x64 embeddable runtime](https://www.python.org/downloads/release/python-31210/), PSF license. Archive SHA-256 `4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3`.
- poke-engine 0.0.47 with Gen 9 Terastallization, poke-env 0.15.0, CPU PyTorch and transitive dependencies retain their licenses. The staging script copies distribution metadata and licenses and records each file's hash. Exact measured versions and native binary identity are in `docs/laplace-performance.md`.

Laplace's model SHA-256 is `502a47a59a6f87786c56b835e972828bc8cbab8e75028b5ddf90b49b8b5d2861`. The bot refuses an unexpected model. No experimental local engine fork is included.

## Build the feasibility runtime

Use a clean checkout at the pinned Laplace revision with its documented CPU engine environment already built, and a built server at the pinned simulator revision. From this desktop repository:

```powershell
& '<Laplace checkout>/.venv/Scripts/python.exe' scripts/laplace/stage-runtime.py --source '<Laplace checkout>'
node scripts/laplace/stage-server.cjs '<Laplace checkout>/server'
node scripts/laplace/build-client.cjs
& './vendor/laplace/dist/python/python.exe' -I -B scripts/laplace/runner.py --check
```

The staging steps refuse to overwrite an existing Python/server runtime. Preserve prior results before producing another build. The Python staging script copies only tracked Laplace inputs and installed distribution-owned files; it excludes editable-install hooks and interpreter bytecode. It does not copy `.env` or use the ladder CLI.

The client builder records its patches in code: a fixed token-bearing loopback WebSocket and local-only client storage initialization. The adjacent HTML/bootstrap/CSS provide the practice shell. Battle simulation, move controls, rendering, HP bars and type colors remain upstream. Remote requests are limited by the desktop view to official Pokémon artwork. Audio and arbitrary browser navigation are disabled.

## Before distribution

The current installer excludes this runtime. Complete a clean reproducible native-engine wheel build and a supported Python security-version refresh, retain all corresponding sources/notices (including the patched AGPL client), and resolve the owner's project/distribution licensing decision before publishing. Copying a working local native extension proves feasibility but does not establish reproducible provenance of its original compiler invocation. Test a relocated runtime, packaged lifecycle, and a clean consumer Windows machine. See `docs/laplace-plan.md` for the remaining acceptance gates.
