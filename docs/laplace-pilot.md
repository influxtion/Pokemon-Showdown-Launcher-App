# Local Laplace thread-count pilot

This pilot compares the 2-thread Practice setting with the 8-thread stock setting in Gen 9 Random Battle. Both agents use eight determinizations at 150 ms each, the same verified value model, and the same root selection and guard settings. The agents search in separate Python processes against a dedicated loopback server. The runner receives the challenge in every game.

Run with the staged Windows runtime from the repository root.

```powershell
& .\vendor\laplace\dist\python\python.exe -I -B .\tests\laplace-local.py `
  --server-root .\vendor\laplace\dist\server --opponent baseline --threads 2 `
  --battles 60 --output .\out\laplace\stock2-vs-stock8-pilot.json
```

The report is replaced atomically after every completed game. It records results from the 2-thread runner’s perspective and p50, p95, and maximum decision times for both agents. A failed or timed-out game is counted separately and ends the run. The per-game deadline is 15 minutes. Output paths must be new for each run.

The server generates fresh random seeds for each battle. The pilot uses unpaired seeds and fixed sides. Its 95% Wilson interval describes the decisive win share among these local matches, with ties and aborted games reported separately. For example, 30 wins in 60 decisive games would give limits of 37.74% and 62.26%. Both engines share one machine during timing.

The initial staged runtime, with Python 3.12.10, completed one verification match between the settings. The 2-thread runner lost with zero fallbacks across 26 decisions. Its p50 and p95 were 1,425 and 1,495 ms. The 8-thread baseline recorded 23 decisions with p50 and p95 of 1,774.8 and 1,874.5 ms.
