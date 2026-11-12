# Local Laplace implementation plan

The owner authorized local Laplace practice and consumer-computer feasibility testing on November 10, 2026. The development runtime and desktop flow have passed local checks. Installer work comes last.

## Acceptance gates

1. Pin Laplace, its CPU engine, trained weights, Python dependencies and Showdown server. Keep source licenses and reproducible build instructions. Do not reuse credentials, user logs or personal server configuration.
2. Run a dedicated server bound only to IPv4 loopback, with external authentication and outbound traffic disabled. Run a separate bot process with no public-server destination or credential options. The official online client/session remains independent.
3. Build a self-contained Python runtime and server. Verify the local bundle after moving it and run it without developer Python, Rust, Git or Node installations. Repeat lifecycle checks in the packaged app on a clean Windows machine before distribution.
4. Add Practice with explicit Start/Stop, truthful startup/failure states, Gen 9 Random Battle, computation presets and a sandboxed local client. Preserve online battles across navigation; clean up owned processes on stop, failure and exit. Do not turn presets into invented Elo ratings.
5. Test complete local games and actual human move controls, switching, fainting, Terastallization, battle completion, restart and failures. Verify themes and both supported window sizes. Run regression suites for the existing app.
6. Measure cold startup, move latency, search visits, CPU and memory on the current machine and under CPU limits. Compare constrained settings against the shipped baseline in controlled local matches with uncertainty intervals. A constrained i9 is not a substitute for testing a genuine low-end computer, and local results do not establish public-ladder Elo.
7. Review source/runtime security and distribution notices. Build and test the final packaged app only after features pass. Clean-machine installation and owner-only signing/license decisions remain explicitly outstanding until actually completed.

## Baseline and evidence

- Local Practice first landed in desktop merge `0881ee8`. The fresh runtime work is on `feat/laplace-runtime`.
- The runtime pins Laplace revision `8b4173dfdabff12e9228310ba25e3fd2ed5117df` for Gen 9 Random Battle.
- Published stock configuration: eight sampled worlds, 150 ms per world, eight search threads, trained value model, mixed root selection. The locally ignored experimental engine fork is not a reviewed distribution dependency.
- Development machine: Intel Core i9-13900H, 14 cores / 20 logical processors, approximately 16 GB RAM. This is a capable laptop CPU, not a low-end reference device.
- The upstream historical Elo is not a guarantee for this integration or lower computation budgets.

## Current status

- [x] Clean pinned development runtime build with Python 3.12.16 and fresh stock engine
- [x] Loopback server and bot runner, including real complete games and graceful shutdown
- [x] Practice UI and process lifecycle, including prelaunch integrity verification, renderer crash and parent-pipe cleanup
- [x] Real local game verification, move/Tera/switch, Forfeit and rematch
- [x] CPU benchmark and desktop smoke against the freshly staged runtime
- [x] Fresh app-local Microsoft CRT and complete runtime build; packaged and relocated real-game smoke
- [ ] Complete and evaluate the local two-thread comparison pilot and strength gate
- [ ] Verify on a lower-end consumer Windows machine
- [ ] Complete installer artifact validation, clean-machine installation and distribution review

`npm run build:practice` builds the pinned Windows x64 runtime with Python 3.12.16, stock poke-engine 0.0.47 from its hashed source distribution, exact hashed dependency wheels and the pinned Showdown simulator and client. It retains source archives, build metadata and a v2 SHA-256 inventory. The desktop verifies that inventory in a worker before starting the runtime. See the [runtime build instructions](../vendor/laplace/SOURCE.md). The earlier scripts that copy an existing environment are for legacy investigation.

The fresh runtime passed the isolated Practice desktop suite with real server-confirmed move, Tera and switch, navigation retention, Stop confirmation, Forfeit and rematch, and renderer-crash cleanup. The inventory verified again after testing. The fresh offline matrix returned 192 legal decisions and measured CPU time, latency, visits and memory. See the [performance report](laplace-performance.md) for the host and CPU masks.

The full eight-thread search remains the default as the [two-thread local comparison pilot](laplace-pilot.md) gets underway. The pilot uses fixed sides and unpaired random seeds. The strength gate remains open, and the benchmark and smoke games establish neither public-ladder Elo nor budget-PC performance.

The 0.2.0 unpacked package includes the runtime. Both its original and relocated copies passed
real move, navigation, Forfeit/rematch and normal child-process cleanup checks with a
system-only PATH. The build also verifies that Torch loads its four Microsoft CRT DLLs
app-locally. The reference CPU benchmark and ongoing pilot use the earlier fresh runtime;
the final candidate adds app-local CRT and complete source archives without changing the
pinned engine, weights or search policy. Native compiler outputs are recorded per build;
byte-identical output across build directories is not claimed.

Current checks: 83 JavaScript tests pass (one optional server case skipped by default),
11 Python tests, all five isolated desktop suites, live guest Showdex and replay checks,
the real Practice desktop suite and both packaged Practice smokes. The live replay check
also found and fixed deferred resizing and fractional horizontal overflow at 125% scaling.
Installer artifact checks, clean-machine testing and owner licensing/signing decisions
remain before release. Keep generated evidence in `out/laplace/`.
