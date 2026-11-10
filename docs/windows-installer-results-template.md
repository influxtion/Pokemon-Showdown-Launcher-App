# Windows installer test results

Copy this template for a run of the [installer checklist](windows-installer-checklist.md).
Store local drafts/evidence under ignored `out/installer-validation/`; commit or share only
sanitized reports deliberately. Every case starts Not run; no pass is implied by this template.

## Run and environment

| Field | Recorded value |
| --- | --- |
| Date / tester alias | Not recorded |
| Run type | Fresh install of B / A-to-B upgrade (choose one) |
| Windows edition, version and OS build / x64 | Not recorded |
| Hardware or VM / clean snapshot identifier | Not recorded |
| Standard user; no dev tools or prior app/profile | Not verified |
| Display resolution / scaling / tested window sizes | Not recorded |
| Network / relevant managed-device restrictions | Not recorded |
| Installer transfer route / browser if downloaded | Not recorded |
| Normal profile path used; override unset | Not verified |

## Artifact identity and build evidence

Record A only for an upgrade run. In a fresh-install run, mark A Not applicable.

| Field | A (previous version) | B (candidate) |
| --- | --- | --- |
| Full source commit / clean checkout | Not recorded | Not recorded |
| Package version / Electron version | Not recorded | Not recorded |
| Installer filename / bytes | Not recorded | Not recorded |
| SHA-256 at build / matches transferred file | Not recorded | Not recorded |
| Signing status / observed publisher | Not recorded | Not recorded |
| Included integrations / known limitations | Not recorded | Not recorded |
| Build/check/package-smoke results and evidence | Not recorded | Not recorded |
| Package contents inspection | Not recorded | Not recorded |

## Results

Use Pass, Fail, Blocked or Not run. Include observations and an evidence reference per row.
For fresh-install-only runs, leave U1/U2 Not run with that reason; the separate upgrade run
is still required for stage 1. Record warning text and install/profile locations below.
In upgrade runs, B1–B3 need observations from both A and B, as directed by the checklist.

| Case | Status | Actual behavior / evidence / defect reference |
| --- | --- | --- |
| I1 Install | Not run | |
| I2 Start launch | Not run | |
| I3 Installed app identity | Not run | |
| W1 Connection/recovery | Not run | |
| W2 Sign-in/teams | Not run | |
| W3 Replay notes/drafts | Not run | |
| W4 Theme/scaling/layout | Not run | |
| W5 Integration status | Not run | |
| W6 Reboot/persistence | Not run | |
| B1 Search/battle transition | Not run | |
| B2 Battle survival/close/reload | Not run | |
| B3 Challenge/friends | Not run | |
| U1 Upgrade A to B | Not run | |
| U2 Upgrade persistence/writes | Not run | |
| R1 Uninstall | Not run | |
| R2 Reinstall | Not run | |

Security prompts (exact text, point encountered, blocked or continued): Not recorded.

Actual install path / Start entry / Installed apps version: Not recorded.

Remaining install files and profile after uninstall: Not recorded.

## Persistence comparison

Use disposable, non-sensitive values. Compare complete contents locally; share only a
sanitized description of matches/differences. Do not include session tokens or private links.

| Data | Baseline before upgrade (A) | After upgrade/restart (B) | After uninstall/reinstall (B) |
| --- | --- | --- | --- |
| Signed-in status | Not recorded | Not run | Not run |
| Team names/formats and full contents | Not recorded | Not run | Not run |
| Saved replay titles/notes/public links | Not recorded | Not run | Not run |
| Appearance/start page/close protection | Not recorded | Not run | Not run |
| Window bounds/maximized state | Not recorded | Not run | Not run |

For a fresh-install run, use the baseline column for B's data before uninstall and mark
the upgrade column Not run. Link the separate A-to-B report in the decision below.

## Defects and decision

For each failure/block: case ID, artifact hash, reproduction steps, expected behavior,
actual behavior, impact, sanitized evidence and issue reference. Record retests separately
with their new candidate identity; do not silently replace a failed result.

- Overall: **Incomplete — not executed**.
- Fresh-install result/report: Not run.
- Upgrade result/report: Not run.
- Uninstall/reinstall behavior and proposed user instructions: Not recorded.
- Unresolved case IDs / blockers: All.
- Next action / responsible person: Not assigned.
- Stage 1 acceptance reviewer/date: Not accepted.

Only mark stage 1 accepted when the required fresh-install and upgrade runs are complete,
uninstall behavior is documented, and no launch, data-loss or battle-interruption blocker
remains. This does not authorize or establish readiness for a public release.
