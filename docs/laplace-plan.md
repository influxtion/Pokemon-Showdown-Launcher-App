# Local Laplace implementation plan

The owner authorized completing the remaining app features on November 10, 2026, including local Laplace practice and measured consumer-computer feasibility. Installer work comes last. This is an implementation checklist, not a declaration that the feature works.

## Acceptance gates

1. Pin Laplace, its CPU engine, trained weights, Python dependencies and Showdown server. Keep source licenses and reproducible build instructions. Do not reuse credentials, user logs or personal server configuration.
2. Run a dedicated server bound only to IPv4 loopback, with external authentication and outbound traffic disabled. Run a separate bot process with no public-server destination or credential options. The official online client/session remains independent.
3. Bundle a self-contained Python runtime and server. A developer virtual environment is useful for investigation but does not satisfy delivery. Verify after moving the bundle and without relying on developer Python, Rust, Git or Node installations.
4. Add Practice with explicit Start/Stop, truthful startup/failure states, Gen 9 Random Battle, computation presets and a sandboxed local client. Preserve online battles across navigation; clean up owned processes on stop, failure and exit. Do not turn presets into invented Elo ratings.
5. Test complete local games and actual human move controls, switching, fainting, Terastallization, battle completion, restart and failures. Verify themes and both supported window sizes. Run regression suites for the existing app.
6. Measure cold startup, move latency, search visits, CPU and memory on the current machine and under CPU limits. Compare constrained settings against the shipped baseline in controlled local matches with uncertainty intervals. A constrained i9 is not a substitute for testing a genuine low-end computer, and local results do not establish public-ladder Elo.
7. Review source/runtime security and distribution notices. Build and test the final packaged app only after features pass. Clean-machine installation and owner-only signing/license decisions remain explicitly outstanding until actually completed.

## Baseline and evidence

- Desktop baseline: `b19e75c`; working branch: `feat/laplace-local-practice`.
- Laplace checkout: clean `main`, revision `8b4173d` (full revision to be recorded in runtime manifest). Gen 9 Random Battle only.
- Published stock configuration: eight sampled worlds, 150 ms per world, eight search threads, trained value model, mixed root selection. The locally ignored experimental engine fork is not a reviewed distribution dependency.
- Development machine: Intel Core i9-13900H, 14 cores / 20 logical processors, approximately 16 GB RAM. This is a capable laptop CPU, not a low-end reference device.
- The upstream historical Elo is not a guarantee for this integration or lower computation budgets.

## Current work

- [ ] Release-grade runtime provenance and security-version refresh (local relocatable feasibility build passes)
- [x] Loopback server and bot runner, including real complete games and graceful shutdown
- [x] Process lifecycle and Practice UI, including renderer crash and parent-pipe cleanup
- [x] Real local game verification, move/Tera/switch, Forfeit and rematch
- [ ] Performance and strength evaluation
- [ ] Whole-app regression and final package validation

The local Python/runtime staging is approximately 621 MB before the separate server/client and compression. A relocated copy passes the same real engine/model check with its embedded interpreter. The stock native engine was copied from a working environment with a recorded binary hash; a clean wheel build and refreshed Python are still required before release. The full eight-thread search remains the default while a two-thread comparison pilot is evaluated.

Completed checks so far: 73 passing JavaScript unit tests (one optional real-server case skipped in the default suite), seven Python runner tests, all five existing isolated desktop suites, a complete 22-decision local battle against the heuristic, one complete two-thread versus eight-thread baseline smoke, and 192 legal offline benchmark decisions. The full Practice desktop suite passes actual move/Tera/switch server confirmations, navigation retention, Stop confirmation, real Forfeit/rematch, and renderer-crash cleanup. All eight shell/player captures were inspected at both sizes and themes, including the compact upstream action menus. The loopback server's optional real test also passes and proves parent-pipe EOF shutdown.

Keep generated evidence in `out/laplace/` and summarize reproducible results in `docs/laplace-performance.md`. Update this checklist and the local handoff as each gate is met; do not mark a simulated test as a real battle or a developer run as clean-machine proof.
