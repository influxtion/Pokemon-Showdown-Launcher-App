# Laplace CPU benchmark

The benchmark runs stock Laplace's Gen 9 Random Battle move-selection pipeline on the CPU. It uses local set data and synthetic battle snapshots. The benchmark creates no Showdown rooms, sends no orders, and needs no running server.

## Results

Measured November 10, 2026. All 180 warm decisions and 12 first decisions were legal without engine fallback. Each of the eight worlds contributed visits, and the corresponding warm world hashes matched across the matrix.

| Available logical CPUs | Search threads | Median wall, ms | Max wall, ms | Median CPU, ms | Median visits | Peak working set, MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 20 (unrestricted) | 1 | 1,302 | 1,384 | 1,297 | 385,000 | 276 |
| 20 (unrestricted) | 2 | 1,367 | 1,423 | 2,563 | 930,000 | 316 |
| 20 (unrestricted) | 4 | 1,488 | 1,602 | 5,031 | 1,490,000 | 344 |
| 20 (unrestricted) | 8 | 1,632 | 1,783 | 9,875 | 2,207,000 | 391 |
| 4 | 1 | 1,304 | 1,360 | 1,266 | 483,000 | 279 |
| 4 | 2 | 1,362 | 1,422 | 2,469 | 846,000 | 309 |
| 4 | 4 | 1,442 | 1,522 | 4,688 | 1,136,000 | 320 |
| 4 | 8 | 1,428 | 1,517 | 5,078 | 1,166,000 | 321 |
| 2 | 1 | 1,284 | 1,341 | 1,266 | 496,000 | 279 |
| 2 | 2 | 1,299 | 1,367 | 1,938 | 650,000 | 286 |
| 2 | 4 | 1,326 | 1,380 | 2,531 | 700,000 | 288 |
| 2 | 8 | 1,356 | 1,423 | 2,578 | 722,000 | 289 |

Each row aggregates 15 warm decisions. CPU time sums work across the process's threads. On the unrestricted i9, going from four to eight threads raised median visits by 48%, median CPU time by 96%, and median wall time by 10%. With the four-logical-CPU mask, the same change added 3% more visits. With the two-logical-CPU mask, going from two to eight threads added 11% more visits and 33% more CPU time.

The fresh Python process reached an initialized agent with the model loaded in **1.46 seconds median** (range 1.40–1.94 seconds across the 12 processes). Torch and feature imports took 974 ms median. Agent construction and checkpoint loading took 4.8 ms median once the imports finished. The first opening decision then took 1.42 seconds median (range 1.34–1.78 seconds). Filesystem caches were left intact. The process working set just after the model loaded was 243 MiB median.

The 180 warm decisions all skipped the value model under the stock near-tie gate. In the separate controlled tie, rerank medians ranged from **18 to 36 ms** over 51–87 successor states. The model's forward pass accounted for 0.22–0.42 ms of those medians. In the separate precomputed-batch probe, median forward plus sigmoid took 0.031–0.045 ms for one row, 0.095–0.195 ms for 32 rows, and 0.292–0.359 ms for 128 rows across the conditions.

The timings and visits measure compute cost on three positions. Playing strength or an Elo estimate would require separate controlled matches with fixed opponents, paired seeds and uncertainty intervals.

## Method

- The host was an Intel Core i9-13900H with 14 physical cores, 20 logical CPUs, 16 GiB installed RAM and Windows 11 build 26200. It was on AC power with the Performance power scheme. Other desktop activity, including a brief integration test and runtime staging, overlapped the run.
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
| Python | 3.12.10, Windows x64 |
| poke-engine | 0.0.47 with Gen 9 Tera choices verified |
| poke-env | 0.15.0 |
| NumPy | 2.4.6 |
| Torch | 2.12.0+cpu |

The editable Laplace install reports package metadata 1.0.0. The loaded source comes from the pinned checkout above. The installed engine binary's SHA-256 is `39d0edc4b8459b4ddc1b12f0080eb5a3223541631c2538bce36b381ccbfa1d48`. It lacks the local fork's value-net marker. The wheel metadata identifies release 0.0.47, with no Rust Git commit recorded. The shipped value checkpoint's SHA-256 is `502a47a59a6f87786c56b835e972828bc8cbab8e75028b5ddf90b49b8b5d2861`.

## Reproduce

Use the existing Laplace Python 3.12 environment, the stock Tera-enabled poke-engine build and the bundled CPU checkpoint. A local Showdown checkout under Laplace supplies the set sheet. Run from the desktop repository.

```powershell
$laplace = 'C:/Users/jayde/Desktop/Laplace/Pokemon Showdown AI'
& "$laplace/.venv/Scripts/python.exe" -B scripts/laplace/benchmark.py --laplace-root $laplace
```

The complete run writes individual timings, native visits, order choices, memory readings and revision hashes to the ignored `out/laplace/benchmark.json`. Use `--repeats 1` for a shorter matrix check.
