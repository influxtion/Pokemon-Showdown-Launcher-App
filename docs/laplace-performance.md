# Laplace CPU benchmark

The benchmark runs stock Laplace's Gen 9 Random Battle move-selection pipeline on the CPU. It uses local set data and synthetic battle snapshots. The benchmark creates no Showdown rooms, sends no orders, and needs no running server.

## Results

Measured November 10, 2026 using the freshly built and staged Windows runtime. All 180 warm decisions and 12 first decisions were legal without engine fallback. Each of the eight worlds contributed visits, and the corresponding warm world hashes matched across the matrix.

| Available logical CPUs | Search threads | Median wall, ms | Max wall, ms | Median CPU, ms | Median visits | Peak working set, MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 20 (unrestricted) | 1 | 1,276 | 1,314 | 1,266 | 538,000 | 293 |
| 20 (unrestricted) | 2 | 1,371 | 1,409 | 2,562 | 981,000 | 327 |
| 20 (unrestricted) | 4 | 1,460 | 1,538 | 5,047 | 1,643,000 | 365 |
| 20 (unrestricted) | 8 | 1,637 | 1,743 | 9,828 | 2,353,000 | 408 |
| 4 | 1 | 1,276 | 1,311 | 1,266 | 538,000 | 299 |
| 4 | 2 | 1,349 | 1,392 | 2,312 | 883,000 | 323 |
| 4 | 4 | 1,408 | 1,458 | 4,734 | 1,219,000 | 336 |
| 4 | 8 | 1,431 | 1,478 | 5,062 | 1,266,000 | 337 |
| 2 | 1 | 1,277 | 1,310 | 1,266 | 552,000 | 294 |
| 2 | 2 | 1,296 | 1,328 | 1,922 | 650,000 | 299 |
| 2 | 4 | 1,317 | 1,366 | 2,516 | 719,000 | 301 |
| 2 | 8 | 1,355 | 1,385 | 2,578 | 762,000 | 305 |

Each row aggregates 15 warm decisions. CPU time sums work across the process's threads. On the unrestricted i9, going from four to eight threads raised median visits by 43%, median CPU time by 95%, and median wall time by 12%. With the four-logical-CPU mask, the same change added 4% more visits. With the two-logical-CPU mask, going from two to eight threads added 17% more visits and 34% more CPU time.

The fresh Python process reached an initialized agent with the model loaded in **3.19 seconds median** (range 3.11–3.32 seconds across the 12 processes). This includes the benchmark driver's manifest, engine and checkpoint identity checks. Torch and feature imports took 2.22 seconds median. Agent construction and checkpoint loading took 4.8 ms median once the imports finished. The first opening decision then took 1.41 seconds median (range 1.33–1.81 seconds). Filesystem caches were left intact. The process working set just after the model loaded was 258 MiB median.

The 180 warm decisions all skipped the value model under the stock near-tie gate. In the separate controlled tie, rerank medians ranged from **16 to 31 ms** over 45–87 successor states. The model's forward pass accounted for 0.21–0.34 ms of those medians. In the separate precomputed-batch probe, median forward plus sigmoid took 0.033–0.038 ms for one row, 0.095–0.113 ms for 32 rows, and 0.268–0.307 ms for 128 rows across the conditions.

The timings and visits measure compute cost on three positions. Playing strength or an Elo estimate would require separate controlled matches with fixed opponents, paired seeds and uncertainty intervals.

## Hosting implications

Practice runs only on the hosted battle service, so these numbers size the service host, not players' computers. Search is time-limited: fewer CPUs give similar wall times but shallower searches. The eight-thread setting collected about 46% fewer visits with four logical CPUs and 68% fewer with two than it did unrestricted. The Compose file's initial cap of four CPUs per container therefore limits the Full preset. Measure the actual service VM before raising concurrency; this i9 is not a substitute for that test.

## Method

- The host was an Intel Core i9-13900H with 14 physical cores, 20 logical CPUs, 16 GiB installed RAM and Windows 11 build 26200. It was on AC power with the Performance power scheme. The refreshed matrix ran separately from the desktop smoke. Ordinary background activity and scheduling can affect timings.
- Each condition starts a fresh Windows Python process. The stock ladder search budget is eight sequential determinized worlds at 150 ms per world. The matrix varies the native threads per world between 1, 2, 4 and 8. The benchmark uses the stock vote and mix settings and disables trace recording.
- The unrestricted process could use logical CPU IDs 0–19. The four-CPU mask used IDs 0–3, covering two physical performance cores with SMT. The two-CPU mask used IDs 0–1, sharing one physical performance core. These masks measure scheduling constraints on this i9. Performance on a budget CPU requires testing that hardware.
- The benchmark tests a six-member opening with unrevealed opponents, a midgame with hazards and a boosted opponent, and a forced switch with one additional fainted bench Pokémon. Five warm decisions per fixture use matching seeded world samples across conditions. The script compares the serialized world hashes. Rust search randomness, system load and time-budget overshoot can still change the results.
- Decision wall time includes Laplace's set sampling, search, pooling, guards, optional value rerank and conversion to a poke-env order. The timer excludes fixture construction and legality checks. Every decision must return a move or switch from the fixture's available options, including Tera and forced-switch restrictions. All eight searches must report visits, and engine fallbacks fail the run.
- The warm peak is the Windows peak working set of one Python worker from process start through its last measured decision. It includes Python, the engine, Torch, the checkpoint, set data and the benchmark driver. It measures resident memory, including shared pages, and excludes the Showdown server and Electron.
- A separate controlled value rerank uses three tied legal moves in the midgame fixture. It times the stock rerank over its usual four worlds and two opponent options per world when those options have visits. This includes successor generation, featurization, model inference and weighting. A separate forward-pass probe times the precomputed feature batches and sigmoid on one Torch thread.

## Runtime identity

| Input | Measured version or revision |
| --- | --- |
| Laplace source | `8b4173dfdabff12e9228310ba25e3fd2ed5117df` |
| Local Pokémon Showdown checkout for Gen 9 set data | `a9caa4cabe89459b00e717a47148d0f67b4451ae` |
| Python | 3.12.16, staged Windows x64 |
| poke-engine | 0.0.47, freshly built for `x86_64-pc-windows-gnu` with Rust 1.96.0 and GCC 13.2.0 |
| poke-env | 0.15.0 |
| NumPy | 2.4.6 |
| Torch | 2.12.0+cpu |

The staged Laplace metadata reports 1.1.0. The benchmark checks that its packaged set sheet matches the pinned checkout, and verifies Tera options in opening searches. The v2 runtime manifest's SHA-256 is `e83e08649b5fd0f5d4c78c2c936a48c35b97480e296041d8c3a6bca74d4ff1a4`. The loaded engine binary's SHA-256 is `55da8bd33aca45da4bf5c25fe21d69476bc60edc8346a20c1d243caab497902c`. The bundled value checkpoint's SHA-256 is `502a47a59a6f87786c56b835e972828bc8cbab8e75028b5ddf90b49b8b5d2861`.

## Earlier development baseline

The prior development environment used Python 3.12.10 and a different stock engine binary with SHA-256 `39d0edc4b8459b4ddc1b12f0080eb5a3223541631c2538bce36b381ccbfa1d48`. Its unrestricted two-thread row measured 1.37 seconds and 930,000 visits median with 316 MiB peak working set. Its unrestricted eight-thread row measured 1.63 seconds and 2,207,000 visits median with 391 MiB peak working set. Its fresh processes reached an initialized agent in 1.46 seconds median. The warm fixture hashes matched those in the staged run. Integration testing and runtime staging overlapped the earlier run, and the environments used different Python and engine builds. The comparison cannot isolate the impact of any one change. The earlier raw report is preserved locally as `out/laplace/benchmark-development.json`.

## Reproduce

Build and stage the Laplace runtime first (`npm run build:practice`). Keep the pinned Laplace source checkout with its local Showdown set sheet for input verification. Run from the desktop repository.

```powershell
$laplace = 'C:/Users/jayde/Desktop/Laplace/Pokemon Showdown AI'
& '.\vendor\laplace\dist\python\python.exe' -I -B scripts/laplace/benchmark.py --laplace-root $laplace
```

The complete run writes individual timings, native visits, order choices, memory readings and revision hashes to the ignored `out/laplace/benchmark.json`. Use `--repeats 1` for a shorter matrix check.
