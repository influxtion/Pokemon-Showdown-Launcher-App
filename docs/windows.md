# Windows app delivery plan and packaging

**Priority update — November 10, 2026:** the owner wants installer work last and has
authorized larger feature work before resuming this release plan. A spare
Windows PC is available for later testing; its Windows version and clean-test setup remain
to be confirmed. The checklist is retained for that stage, not the next development task.

Replay backup/restore, in-app replay review and Practice are now implemented. Practice
connects to a hosted battle service; the app package contains no bot runtime. Showdex
distribution remains undecided. No public release or clean-machine pass is implied.

The alpha target is a Windows x64 NSIS installer. The same configuration can also produce an unpacked app for inspection and smoke testing. Neither command installs or publishes the app. The installer is unsigned and uses Electron's default icon until project licensing and release branding are settled.

## Feasibility and intended experience

Plan recorded November 10, 2026. Technically feasible: the project already produces a
Windows x64 NSIS installer containing the Electron runtime, and an isolated packaged-app
smoke test passes. Players will not need Git, Node.js, terminal commands, or a source
checkout. Electron supports this packaging and distribution model; a native rewrite is
not required. See [Electron distribution guidance](https://www.electronjs.org/docs/latest/tutorial/distribution-overview).

The latest local packaging report measured approximately 121 MB for the installer and
374 MB for the unpacked app. These are development-machine measurements, not download,
startup or memory guarantees. That artifact predates the selected-team shortcut and must
be rebuilt before release. Clean-machine installation and upgrades remain unverified.

The intended flow is **download installer → install → launch from Start → use Showdown**.
The app remains online: it connects to the existing Showdown service. A successful installer
does not prove reliability on other machines or that players will keep using the app.

## First-release scope

- Windows x64 first, with Windows 11 as the initial clean-machine test target. Advertise
  only operating-system versions actually validated with the pinned Electron version.
- Ship the existing online workspace, replay notes with backup/review, Practice through the hosted service, and settings. Aim to include the
  optional Showdex integration once its distribution review and packaged tests are complete.
- Keep the app free, with no launcher account or subscription. The only backend is the
  private battle service for Practice.
- Use a direct installer download and manual upgrades first. A custom website, store
  listing, automatic updater, macOS/Linux packages and fully offline artwork are later work.

## Staged plan

Each numbered stage is several small tasks, not one large implementation branch. Finish,
verify, merge, push and remove each task branch before moving to the next task.

### 1. Prove installation on a clean Windows machine

Use the [installer acceptance checklist](windows-installer-checklist.md) and copy its
[results template](windows-installer-results-template.md). Rebuild current main, record
the exact commit/version and installer SHA-256, and test in a clean Windows
VM or separate machine without development tools. Use a standard user account.

Check installation, Start-menu launch, restart, sign-in persistence, team selection, replay
notes, themes at 100%/125% display scaling, and close protection. A human tester performs
any real search or challenge. Exercise an upgrade from one version to the next and confirm
the session, teams, notes and settings survive. Test uninstall and reinstall, recording
what data remains; make the eventual uninstall instructions match the observed behavior.

**Exit:** recorded results for install, normal use, upgrade and uninstall; no known data-loss
or launch blockers. Unpacked-app smoke tests alone do not satisfy this stage. An unsigned
build can be used for controlled testing where Windows policy permits it; signing does
not need to block writing the checklist or fixing installer defects.

### 2. Decide and verify what the downloadable build includes

The owner chooses the project license; it remains undecided today. Review the distribution
requirements for dependencies and Showdex, including its AGPL license, desktop patches
and corresponding source. Record the decision and include the required notices/source.
Do not infer that copying a license file alone settles the distribution requirements.

Then add the pinned Showdex bundle to the release package and verify it inside the
installed app: enable, load, disable, explicit reload and failure recovery. All runtimes
needed by shipped features must be included; players must not run `build:showdex`.
Until that is ready, test builds can remain launcher-only and must clearly say so.

**Exit:** documented distribution decision and a self-contained installer whose advertised
integrations work without developer setup. Ordinary Showdown still works if Showdex fails.

### 3. Finish app identity and Windows signing

Create an original app icon, settle the displayed app/publisher names, and retain the stable
app ID and user-data location across releases. The owner selects an eligible signing route
and its budget; check current pricing and identity requirements before committing to a provider.
Keep signing credentials outside Git and restrict their use to trusted release builds.

Sign and verify both the executable and installer. Test a browser-downloaded copy on clean
Windows so the download experience is represented. Signing identifies the publisher but
does not guarantee immediate SmartScreen reputation or eliminate every warning, according
to [Microsoft's signing and reputation guidance](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation).

**Exit:** consistent branding, verified signatures for the public-release candidate, and
documented real installation behavior. Do not make disabling Windows security part of normal setup.

### 4. Make releases reproducible and easy to download

Add a Windows release workflow in small steps: clean dependency install, syntax/unit/desktop
checks, package the chosen integrations, sign, inspect package contents, then smoke-test the
same build. Keep the network-dependent live Showdown check separate from deterministic CI.
Initially produce draft release artifacts for inspection; do not publish every push to main.

Use versioned GitHub Releases for the first download destination. GitHub supports attaching
installer assets and release notes; a separate website is unnecessary at this stage.
See [GitHub's release documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
Link the installer prominently from the README, distinguish it from source-code downloads,
and provide tested system requirements, online-service requirements, known issues, SHA-256
checksums, notices/source, install/uninstall instructions and a bug-report link.

**Exit:** a candidate can be built from its tagged source and downloaded/installed by a tester
who has never opened the repository. Previous release artifacts remain available for recovery.

### 5. Run an invited alpha, then publish a public alpha

Recruit the planned 8–12 Showdex users once the intended Showdex package is ready. Ask them
to download and install unaided, complete their normal play session, and try a subsequent
upgrade. Record install failures, crashes, data loss, integration failures and whether they
return to the app. Collect reports deliberately; do not silently add account tracking.

Fix launch, data-loss and battle-interruption defects before widening distribution. If the
app works but users do not return, revisit its usefulness before adding more integrations.
Publish the tested installer as a clearly labeled public alpha with its known limitations.

**Exit:** testers can install and upgrade without developer help, no unresolved critical
defects remain, and there is a maintained download/release-notes/support path.

### 6. Add automatic updates only after manual upgrades are dependable

For the first alpha, let users download and run the next installer, with clear instructions
and tested data preservation. Later add an updater compatible with the existing NSIS package,
verify downloaded updates, and test interrupted downloads and failed upgrades. Never apply
an update or restart unexpectedly during a battle. Do not confuse a downloadable app with
an app that must have an automatic updater on day one.

**Exit:** updates are recoverable, preserve user data and leave restart timing to the player.

## Constraints and next small task

The main risks are untested installer behavior, distribution/licensing decisions, signing
cost and identity setup, and changes to upstream Showdown/Showdex interfaces. There is no
evidence that another large feature is needed to make downloading/installing feasible.
Plan for ongoing Electron security updates and upstream compatibility checks after release.

The checklist and results template are written; actual clean-machine results are still
pending. When feature work is ready and installer work resumes, the next release task is
**prepare a current installer with recorded build evidence and SHA-256 for the first
clean-Windows run**, then execute the checklist on an isolated
machine. Upgrade proof additionally needs two distinct versioned installers. Building CI,
signing, an updater or the battle service is outside that task. No release date is promised until
clean-machine results and the owner's distribution decisions are available.

This is planned release work. No public download or automatic update service is live yet.

## Profiles and build tools

`electron-builder` 26.18.0 is pinned in the dependency lockfile. Package scripts always pass
`--publish never`. The profile helper runs before Electron is ready and keeps the default
profile at `%APPDATA%\showdown-desktop` in development and in the packaged app. An explicit
`app.setPath('userData', ...)` made by a test before importing main is preserved.
`SHOWDOWN_DESKTOP_USER_DATA` can select an absolute alternate directory for an isolated
test or portable profile; the helper creates it before Electron is ready.

## Build and inspect

Use Node 24 on Windows. From a clean checkout:

```powershell
npm ci
npm run check
npm test
npm run test:desktop
npm run pack:win:dir
npm run smoke:packaged
npm run pack:win
```

The unpacked executable is `out/windows/win-unpacked/Showdown Desktop.exe`. The installer is
`out/windows/Showdown Desktop Setup 0.2.0-x64.exe` for version 0.2.0. Both are ignored by Git.
The NSIS installer is per-user, creates a Start menu shortcut, and does not create a desktop
shortcut. Signing is explicitly disabled for test builds; resource/version editing remains
enabled. No custom icon is configured.

The package contains no bot runtime; Practice uses the hosted battle service described in
[playable bots](playable-bots.md).

Inspect the built `resources/app.asar` file list before distributing anything. It should contain `app/`, `renderer/`, `package.json`, and Showdex source metadata (`vendor/showdex/LICENSE`, `SOURCE.md`, and a manifest if present). It must not contain `tests/`, `scripts/`, local settings, credentials, `out/`, or `vendor/showdex/dist/`. The generated Showdex runtime stays out of the installer until the owner decides the licensing approach. The packaged UI should report Showdex as not installed, and ordinary Showdown use should still work.

`smoke:packaged` launches only the unpacked executable with a new temporary profile and a
system-only PATH. A local proxy blocks the public client. It checks Home, settings and a
temporary replay-note IPC round trip, then closes the app and cleans its test data.
Reports under `out/packaging-smoke/` measure this host only; any existing
installer size is labeled separately and is not proof that it matches the tested app.
Neither smoke installs NSIS or replaces clean-machine verification.

Before handing the installer to testers, verify it on a clean Windows x64 machine, including sign-in persistence, team selection, a real search and battle transition performed by the tester, replay notes, appearance, close confirmation, and uninstall. The unsigned installer may prompt Windows security warnings. Keep release publication and auto-update configuration separate from this alpha build.

The local build and packaged smoke test have passed. The generated `report.json` records
measurements for the current run. Startup measures the launcher bridge becoming ready with
Showdown network traffic blocked; memory is the main process working set, not total app memory.
The installer has not been installed or tested on a clean machine.

The build dependency audit currently reports a moderate minimatch glob-amplification advisory
through electron-builder. This is a development-only dependency; it is absent from app.asar,
and packaging uses fixed project-owned patterns. Do not process untrusted packaging configs.
