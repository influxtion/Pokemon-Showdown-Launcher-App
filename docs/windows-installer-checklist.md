# Clean-Windows installer acceptance checklist

Use this for stage 1 of the [Windows delivery plan](windows.md). Copy the
[results template](windows-installer-results-template.md) for each machine and candidate.
This procedure is ready to run; it is not evidence that installation has passed.

## Prepare the candidate (maintainer)

- Build from a clean, committed checkout using the commands in
  [Build and inspect](windows.md#build-and-inspect). Record the full source commit,
  package version, Electron version, build commands and their results.
- Inspect package contents and run the packaged smoke check against the same build.
  Do not treat an old smoke report or an existing installer as verification of a new build.
- Preserve the exact installer being tested. Record its filename, byte size and SHA-256.
  On the build machine, use PowerShell with the actual artifact path:

  ```powershell
  Get-Item -LiteralPath '.\out\windows\Showdown Desktop Setup 0.1.0-x64.exe' | Select-Object Name, Length
  Get-FileHash -LiteralPath '.\out\windows\Showdown Desktop Setup 0.1.0-x64.exe' -Algorithm SHA256
  ```

- Label the candidate **unsigned test build**, and record exactly which runtimes it contains.
  The default Electron icon and Showdex exclusion remain until the distribution decision.
  A candidate tested with a battle-service address and key must pass P1–P2 below. No public
  release is implied.
- For the upgrade case, prepare two installers with distinct package versions, A and B
  (B newer than A). Record each source commit and hash separately. Renaming the same
  installer or reinstalling version A does not prove an upgrade. If only one version is
  available, mark upgrade cases Blocked; prepare the second version in a separate task.

## Prepare the test machine

- Use a clean Windows 11 x64 VM or separate PC with a standard, non-administrator user.
  Record Windows edition/build, display resolution/scaling, VM or hardware, and network.
  Git, Node.js, Python, Rust and the source checkout must not be required or installed for this test.
  Record CPU model, installed RAM and storage type. Record whether the Microsoft C++
  redistributable was already installed; do not install it to hide a missing app dependency.
- Begin with no Showdown Desktop installation or `%APPDATA%\showdown-desktop` profile.
  Use a fresh VM snapshot or disposable Windows account rather than deleting a real profile.
  Leave `SHOWDOWN_DESKTOP_USER_DATA` unset: this run must exercise the normal profile path.
- Keep the machine/profile through restart, upgrade and uninstall/reinstall tests. A
  fresh temporary profile at each step would hide persistence bugs.
- Transfer the installer and compare its SHA-256 to the maintainer's value. Record whether
  it arrived by browser download, shared folder or another route. A copied file does not
  establish the browser-download warning experience; test that separately before release.
- Record any security warning verbatim and whether it blocks installation. If policy blocks
  the unsigned build, mark Blocked and retain evidence; disabling protection is not a step.
- Use disposable team/note data and a tester-controlled Showdown account. The human tester
  chooses and performs all real searches, challenges and battle actions.

## Run the cases in order

For a complete upgrade run, start with A, then install B at U1. Repeat B1–B3 on B after
U2, recording A and B observations separately. Also run I1–I3, W1–W6 and B1–B3 with B
from a fresh snapshot/account to prove B works as a first installation. For that fresh
install run, skip U1/U2 and continue with R1/R2. Keep the two runs' results separate.
Mark each case Pass, Fail, Blocked or Not run and record what was observed, not just what
was expected.

| ID | Action | Acceptance / evidence |
| --- | --- | --- |
| I1 | Run the installer as the standard user. | Installation completes without developer tools or administrator credentials. Record install path, prompts, warnings and any automatic launch. |
| I2 | Close any automatically opened window; launch Showdown Desktop from Start. | One working launcher opens. Start shortcut exists; no desktop shortcut is expected from the current configuration. Record the installed executable's version. |
| I3 | Check Settings → Installed apps and installation files. | App is listed with the intended version; installed executable and uninstaller exist. Record actual locations and any duplicate entries. |
| W1 | Connect to Showdown, then temporarily disconnect/reconnect the test machine's network while idle. | Home/client report connection loss and recovery truthfully; ordinary use resumes without reinstalling. Record delays or required recovery actions. |
| W2 | Sign in, create a disposable named team, select its format/team on Home, and use Edit teams. | Account/team information is correct and the selected team opens. Navigate away and back with an editor open: its work survives. Never include credentials in evidence. |
| W3 | Save a replay note using a real public replay URL; edit, search and reopen it. Leave a second note draft unsaved and navigate away/back. | Saved content matches, external replay opens, and unsaved draft survives navigation. Closing with a draft offers a discard choice; cancel leaves the app/draft intact. Save it before continuing. |
| W4 | Try Light, Dark and Match Windows; resize/maximize at 100% and 125% Windows scaling. Visit Home, Showdown, Replay notes and Settings. | Controls remain reachable, no horizontal page overflow, text readable and client correctly aligned. Record physical display resolution and window size; include minimum 1024×640 logical window where the display permits. |
| W5 | Check integration status. | Showdex reports Not installed when excluded; normal Showdown works. With a battle service configured, Practice reports Ready to start. A future bundled-Showdex candidate needs its own installed integration checks. |
| W6 | Set a non-default appearance/start page, keep close protection enabled, resize the window, quit, reboot Windows and launch from Start. | Sign-in session, complete team contents, saved replay notes, settings and window state survive. Record the normal profile path and any unexpected sign-in prompt. |
| P1 | With the battle-service address and key configured, play a complete Practice game against each bot using moves, switches and Terastallization; start a rematch. | The game starts without installing anything or an administrator prompt; legal controls work, the bot responds, the result is correct and New battle works. Record computation setting, move times and any stalls; do not infer Elo from one game. |
| P2 | During Practice, visit Home, Replay notes and Showdown, then return. Cancel Stop and Close confirmations; then stop deliberately and start again. | Both sessions survive page changes. Cancelling keeps the game; stopping ends the service session and restarting works. Check both themes and 100%/125% scaling. |
| B1 | Human tester starts and cancels a search, then starts a search that becomes a battle. | Search state/cancel work and a new player battle switches to Showdown. Record the format and outcome without private opponent/account details. |
| B2 | During the tester's battle, visit Home/Replay notes and return. Try closing and reloading the client, choosing Cancel in each confirmation. | Battle stays alive across pages; close/reload protection appears and cancelling preserves play. Finish the battle before upgrading. |
| B3 | Human tester opens a challenge with a consenting partner; also checks Friends. | Challenge targets the intended user/format. Record presence behavior or fallback explicitly; an available fallback alone does not prove accurate friend presence. |
| U1 | Close A normally with all notes saved and no active search/battle; install B without uninstalling A. | Upgrade completes under the same standard user, Start launches B, and Installed apps has no stale duplicate entry. Record versions before/after. |
| U2 | Compare data with the recorded A baseline; reopen the app once more. | Session, complete team contents, saved notes, settings and window state are preserved. Repeat W2/W3 basic actions to prove the upgraded stores remain writable. |
| R1 | Close B; uninstall through Windows Settings → Installed apps. | Uninstall completes; Start shortcut, installed executable and Installed apps entry are removed. Record leftover install files and whether the normal profile remains. |
| R2 | Reinstall the exact same B installer and launch from Start. | App launches normally. Record which session/teams/notes/settings return and which do not. Data preservation here is an observation until the uninstall policy is finalized; unexpected loss during an upgrade is always a failure. |

Before U1, record non-sensitive baseline values: team name/format and contents, note
title/body/link, appearance/start page/close protection, window state and signed-in status.
Keep a private copy of disposable team exports and saved notes outside the profile so loss
can be diagnosed. Do not sign out or reset launcher data between persistence checks;
those actions intentionally remove data and would invalidate the comparison.

For B, also export notes, import the backup through conflict review, and undo that import.
Review a real public replay beside its notes; confirm playback, editing and return to the list.
Record these under W3. P1–P2 may be Not applicable without a battle service; they are
required on a candidate that advertises Practice.

## Record the decision

- Any install/launch failure, upgrade data loss or battle interruption blocks acceptance.
  Log reproduction steps, expected/actual behavior, affected candidate hash and evidence.
- Blocked or Not run cases remain outstanding. An unpacked smoke pass cannot replace
  installer, upgrade, reboot or uninstall evidence. Report fresh install and upgrade separately.
- For R1/R2, report actual retention behavior and confirm it matches the instructions that
  will accompany a release. Do not promise either a complete data wipe or data retention yet.
- Share sanitized results only. Profile folders can contain sessions, local teams, notes and
  private replay links; do not attach the profile, cookies or credentials to a public issue.
- End with **Accepted for stage 1**, **Failed**, or **Incomplete**, with unresolved case IDs.
  Stage 1 acceptance is installation evidence only; licensing, signing and public release
  remain separate gates in the delivery plan.
