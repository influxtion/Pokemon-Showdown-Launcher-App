# Laplace practice development runtime

The Windows x64 development runtime under `dist/` is generated and ignored. Keep credentials, personal logs, saved games and developer server configuration out of it.

## Sources

- [Laplace](https://github.com/influxtion/Laplace-Pokemon-Showdown-AI), MIT, revision `8b4173dfdabff12e9228310ba25e3fd2ed5117df`.
- [Pokémon Showdown server](https://github.com/smogon/pokemon-showdown), MIT, revision `a9caa4cabe89459b00e717a47148d0f67b4451ae` for simulation.
- [Pokémon Showdown classic client](https://github.com/smogon/pokemon-showdown-client), AGPL-3.0, revision `49b54209ebee54ceb8fff62a5eb5bedf7efcf6dc`. Its build tooling uses server data revision `202b6b385c2536977c60a97bf12d931c2d449586`; this does not replace the simulator.
- [Python 3.12.16 Windows x64 standalone build](https://github.com/astral-sh/python-build-standalone/releases/tag/20261026). The archive, exact Windows wheels and their SHA-256 hashes are pinned in [runtime-lock.json](runtime-lock.json). Python and wheel packages retain their supplied metadata and notices.
- Microsoft Visual C++ v14.51.36247 app-local runtime. The locked [official x64 CRT package](https://download.visualstudio.microsoft.com/download/pr/3984a6ef-2ffc-4c07-962e-bf9e9b862819/24a1c8dba0376d9b008ac2ba430d13c06664fc6f163511fd7866485030e289af/Microsoft.VC.14.51.CRT.Redist.X64.base.vsix) supplies four release CRT DLLs for Python and Torch. The build preserves the package manifest and checks that the DLLs load from the staged Python directory. Distribution is subject to [Microsoft's Visual Studio redistribution terms](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution).
- Stock poke-engine 0.0.47 is compiled from the locked source distribution with Gen 9 Terastallization enabled and default features disabled. The build records the source, Cargo.lock and produced wheel hashes, along with the compiler, Rust target and maturin version. See [benchmark runtime identity](../../docs/laplace-performance.md#runtime-identity) for the build used in the measurements.

Laplace's model SHA-256 is `502a47a59a6f87786c56b835e972828bc8cbab8e75028b5ddf90b49b8b5d2861`. The bot refuses an unexpected model. No experimental local engine fork is included.

## Build the development runtime

Build on Windows x64 with Node.js 24 and npm, Git, `tar`, and `rustup` available on PATH. Select Rust and Cargo **1.96.0** through rustup with one of the supported x64 Windows hosts.

- For `x86_64-pc-windows-gnu`, provide `gcc` on PATH targeting `x86_64-w64-mingw32`. The verified build used MSYS2 GCC 13.2.0.
- For `x86_64-pc-windows-msvc`, use a configured x64 MSVC build shell with `cl` on PATH. The builder accepts this configuration. The recorded build used GNU.

The first build needs network access to fetch the pinned archives, source revisions and dependencies. The builder bootstraps its own Python and fetches clean pinned source checkouts under `out/`. A local Laplace checkout, developer Python installation and prebuilt server are unnecessary.

From the desktop repository, after installing its npm dependencies, run:

```powershell
npm run build:practice
npm run test:practice
```

The build installs exact CPU dependency wheels by hash, fetches Cargo dependencies against the source lockfile, and compiles the native wheel offline after those dependencies are available. It builds the pinned Showdown simulator and classic client, runs the isolated Python engine and model check, then creates and verifies a v2 manifest with each payload file's size and SHA-256. A verified candidate replaces `dist/`. An earlier runtime is retained under `out/laplace/previous-runtime-*`. Stop a running Practice session before rebuilding.

For inspection while an existing runtime is in use, `npm run build:practice -- --stage-only`
retains a verified `vendor/laplace/pending-*` candidate without replacing `dist/`.
Failed candidates and temporary bootstrap directories are removed; prior active runtimes are preserved.

The runtime's `sources/` folder retains archives of the pinned Laplace, Showdown simulator,
classic client and its separate data-generator repositories, plus the top-level builder,
local adapter scripts, client shell, lock and notices. The engine source distribution and
other locked download inputs are cached under `out/laplace/`. The installed runtime includes
only the staged inputs and dependencies, without editable-install hooks or generated interpreter bytecode.

At **Start practice**, the desktop verifies the manifest and exact file inventory in a worker before launching either child process. An incomplete or damaged runtime fails startup with a rebuild message.
This detects inconsistency and corruption; the local manifest is not a publisher signature.

`scripts/laplace/stage-runtime.py` and `scripts/laplace/stage-server.cjs` are legacy feasibility tools. They copy development inputs and are outside the supported build path.

The client builder records its loopback connection, local storage and practice navigation patches in code. The adjacent HTML, bootstrap and CSS provide the practice shell. Battle simulation, move controls, rendering, HP bars and type colors remain upstream. The desktop view permits official Pokémon artwork. It disables audio and arbitrary browser navigation.

## Before distribution

Players use Practice through the hosted battle service. Test packages bundle this runtime
only for the development harness.
Before the service is offered to invited testers, review corresponding source and notices for
the patched AGPL client and dependencies; the owner's licensing decision is still open.
See [playable bots](../../docs/playable-bots.md).
