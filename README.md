# Showdown Desktop

A desktop workspace for [Pokémon Showdown](https://play.pokemonshowdown.com/). It wraps the official client in a compact window that keeps your session, and adds space for tools and replay notes.

Early prototype. Replay notes are stored locally. Showdex is an optional pinned integration;
local Laplace practice has a pinned runtime build and is included in Windows test packages.

The goal is an app players can download and install without development tools.
See the [Windows delivery plan](docs/windows.md#feasibility-and-intended-experience)
for the stages from the current local installer to a public alpha.
Current priority is finishing features; installer validation and release delivery come last.
Replay notes now include export, import review, conflict resolution and undo of the last import.
Saved replays can also be reviewed inside the app beside their notes.

## Run

Requires Node.js 24.

```sh
npm install
npm start
```

## Verify

```sh
npm run check
npm test
npm run test:desktop
```

Unit tests cover bridge sanitization, action validation, navigation timing, settings persistence,
and replay URL validation and safe storage.
The desktop smoke tests launch Electron with temporary profiles and simulated Showdown
responses; outbound client requests are blocked. It checks connection feedback, client-view
survival and sizing, theme changes, battle navigation, and replay-note editing and persistence
without sending searches or challenges. Replay browser launches and confirmation dialogs are
stubbed in the replay smoke test. Screenshots are written to `out/desktop-smoke/`.
These checks do not verify live account behavior.

## Replay notes

Choose **Add replay** in Replay notes, paste a link from Showdown's **Upload and share replay**
action, enter a title and save. **Save replay note** on the Showdown screen prefills the current
battle's players and format when available; it does not upload the battle. Paste the full private
link, including its access suffix, for a private replay.

Search matches titles, formats and note text. Saved replay links cannot be changed. Adding a
duplicate link offers the existing note without replacing it. **Open replay** explicitly opens
the saved link in your default browser.

Choose **Review replay** on a saved note to watch the official Showdown replay beside the
note editor. **Hide notes** gives the player more space; **Reload replay** only reloads that
replay. Save with the button or Ctrl+S while editing notes. Returning to the notes list or
another page stops replay playback and keeps your unsaved draft. The live Showdown client
stays connected, and a newly started player battle still takes priority. **Open in browser**
remains available for the full replay site. See [Replay review](docs/replay-review.md).

**Export notes…** saves all saved notes to a JSON file you choose, including notes hidden by
the current search/filter. It preserves titles, note text, timestamps and full replay links,
including private access links. Keep the file private if those links should stay private.
Unsaved edits are not included; save them first. Export does not download hosted replays or
change your notes.

**Import notes…** opens an exported file for review before making changes. New notes are
added, identical notes are skipped, and conflicts default to keeping the existing version.
Compare both versions and choose which to keep per note, or apply one choice to all conflicts.
Notes absent from the file are kept. Save any unsaved edit before applying the import.
**Undo import…** restores the previous saved notes until they change or the app restarts.
See [Replay-note backups and restore](docs/replay-backups.md) for the full workflow and limits.

In Replay notes, **Ctrl+F** focuses search, **Escape** clears the focused search, and **Ctrl+S**
saves the current note. The app also remembers window size, position, and maximized state,
and repositions a saved window when its monitor is no longer available.

Only the notes and links are stored in `replays.json` in Electron's userData folder
(normally `%APPDATA%/showdown-desktop` on Windows); Showdown hosts the replay itself.
Titles are limited to 120 characters, notes to 5,000, and the collection to 1,000 entries / 8 MiB.
Writes use a temporary file and atomic replacement. An unreadable or invalid file is reported
and left unchanged. Unsaved edits survive launcher navigation; closing with unsaved edits asks
whether to discard them. Deleting a note leaves the hosted replay intact.

Before an alpha release, manually verify sign-in persistence, ratings, team selection,
challenges, a real search becoming a battle, and the friends list using your own account.

Home reads structured friends presence when the signed-in account and server support it.
Online, idle, busy, and offline are displayed as reported; busy is not treated as battling.
The list refreshes at most every 30 seconds and keeps **Open friends list** as a fallback.
No battle links or trainer avatars are inferred from presence data.
Settings include appearance, start page, close confirmation, explicit client reload, logs,
sign out, and launcher reset. The client stays loaded across page changes. Sign out clears
the Showdown partition, including locally stored teams and preferences; export teams first.
Launcher reset removes settings, launcher preferences, and replay notes while keeping the
Showdown partition. Both destructive actions ask for confirmation. Logs contain fixed event
names and numeric error codes, not usernames, credentials, replay URLs or note content.

## Optional Showdex integration

```sh
npm run build:showdex
npm start
```

The first build needs network access, Git, Corepack, and Node.js 24. It checks out the pinned
Showdex revision, applies the recorded readiness patch, and verifies every generated asset
against the committed SHA-256 manifest. Generated runtime files stay out of Git. Build inputs,
the upstream AGPL-3.0 license, and source details are in `vendor/showdex/SOURCE.md`.

Enable Showdex in Settings, then reload the client explicitly. Preference changes never
reload a battle automatically. The status says Loaded only after the pinned bootstrap has
rendered its room; a failed integration leaves ordinary Showdown play available. Showdex
runs inside the sandboxed client without Node or the launcher preload. It downloads public
competitive data from upstream services.

Showdex panels follow the desktop Appearance setting (cobalt light or steel-blue dark).
The desktop stylesheet flattens its chrome while preserving Pokémon type, HP, stat,
and damage colors. Calculator behavior stays upstream.

`npm run test:showdex:live` is an optional network-dependent smoke test with a temporary guest
profile. It checks Hellodex, settings, and a populated standalone Honkdex calculator
in both themes and at two window sizes, including readable damage, preserved type
colors, and reachable footer controls. It requires the local Showdex build; it never signs
in, searches, or challenges.
The default desktop suite uses simulated sessions instead.

`npm run test:replays:live` is a separate optional guest test of a real public replay. It
checks upstream playback/pause, the review layout in both themes at both target sizes,
and view cleanup. It does not sign in, upload, search for opponents or challenge anyone.

## Local practice

Practice runs Gen 9 Random Battle against Laplace on a separate loopback server. It never
uses your online account. Choose a computation setting and **Start practice**. The full
upstream search setting is the default; quieter options use fewer search threads. These
are computation settings, not Elo ratings. Navigation keeps both local and online games
loaded, and **Stop practice…** ends the local session and its processes.

Build the optional Windows x64 development runtime from the desktop checkout:

```powershell
npm run build:practice
npm start
```

See the [runtime build prerequisites and source pins](vendor/laplace/SOURCE.md) for the
required Windows compiler, Rust toolchain and other build tools. The build stages pinned
Python 3.12.16, the CPU engine and model, the local server and the classic battle client.
Practice verifies the runtime in a background worker before launching. Artwork loads from
the official Showdown image host. Windows test packages include the Practice runtime.
Public distribution still awaits licensing/signing decisions and clean-machine testing.

`npm run test:practice` exercises a real local battle through the desktop with an isolated
profile and the public battle client blocked. See the [performance measurements](docs/laplace-performance.md),
[local comparison pilot](docs/laplace-pilot.md), and [remaining implementation gates](docs/laplace-plan.md).
Clean-machine performance and the playing-strength comparison remain open.

## Windows alpha

```sh
npm run build:practice
npm run pack:win:dir
npm run smoke:packaged
npm run smoke:practice-packaged
npm run pack:win
```

The unsigned x64 installer is written to `out/windows/`. The packaged app excludes the optional
Showdex runtime while distribution licensing remains undecided. See [Windows packaging](docs/windows.md)
for installation behavior, isolated smoke checks, measurements, and outstanding clean-machine testing.
Nothing is automatically published. The project's own license remains undecided.
