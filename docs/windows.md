# Windows alpha packaging

The alpha target is a Windows x64 NSIS installer. The same configuration can also produce an unpacked app for inspection and smoke testing. Neither command installs or publishes the app. The installer is unsigned and uses Electron's default icon until project licensing and release branding are settled.

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

The unpacked executable is `out/windows/win-unpacked/Showdown Desktop.exe`. The installer is `out/windows/Showdown Desktop Setup 0.1.0-x64.exe` for version 0.1.0. Both are ignored by Git. The NSIS installer is per-user, creates a Start menu shortcut, and does not create a desktop shortcut. No custom icon or signing certificate is configured.

Inspect the built `resources/app.asar` file list before distributing anything. It should contain `app/`, `renderer/`, `package.json`, and Showdex source metadata (`vendor/showdex/LICENSE`, `SOURCE.md`, and a manifest if present). It must not contain `tests/`, `scripts/`, local settings, credentials, `out/`, or `vendor/showdex/dist/`. The generated Showdex runtime stays out of the installer until the owner decides the licensing approach. The packaged UI should report Showdex as not installed, and ordinary Showdown use should still work.

`smoke:packaged` launches only the unpacked executable with a new temporary profile. It also points the child process's Windows app-data environment to that temporary directory. A local proxy target prevents client network access; the script never clicks Battle! or sends a challenge. It checks the Home page, reads settings through the launcher bridge, saves and reads a temporary replay note through IPC, closes only its child process tree, then verifies deletion from that temporary store. It writes `out/packaging-smoke/home.png` and `report.json` with measured startup time, unpacked size, installer size if it already exists, and main-process working set where available. These numbers describe one run on the current machine, not a performance claim. The script does not install the NSIS artifact or test it on a clean Windows machine.

Before handing the installer to testers, verify it on a clean Windows x64 machine, including sign-in persistence, team selection, a real search and battle transition performed by the tester, replay notes, appearance, close confirmation, and uninstall. The unsigned installer may prompt Windows security warnings. Keep release publication and auto-update configuration separate from this alpha build.

The local build and packaged smoke test have passed. The generated `report.json` records
measurements for the current run. Startup measures the launcher bridge becoming ready with
Showdown network traffic blocked; memory is the main process working set, not total app memory.
The installer has not been installed or tested on a clean machine.

The build dependency audit currently reports a moderate minimatch glob-amplification advisory
through electron-builder. This is a development-only dependency; it is absent from app.asar,
and packaging uses fixed project-owned patterns. Do not process untrusted packaging configs.
