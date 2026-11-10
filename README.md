# Showdown Desktop

A desktop workspace for [Pokémon Showdown](https://play.pokemonshowdown.com/). It wraps the official client in a compact window that keeps your session, and adds space for tools and replay notes.

Early prototype. Replay notes are stored locally. Showdex and practice are not implemented yet.

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

Only the notes and links are stored in `replays.json` in Electron's userData folder
(normally `%APPDATA%/showdown-desktop` on Windows); Showdown hosts the replay itself.
Titles are limited to 120 characters, notes to 5,000, and the collection to 1,000 entries / 8 MiB.
Writes use a temporary file and atomic replacement. An unreadable or invalid file is reported
and left unchanged. Unsaved edits survive launcher navigation; closing with unsaved edits asks
whether to discard them. Deleting a note leaves the hosted replay intact.

Before an alpha release, manually verify sign-in persistence, ratings, team selection,
challenges, a real search becoming a battle, and the friends list using your own account.
Settings include appearance, start page, close confirmation, explicit client reload, logs,
sign out, and launcher reset. The client stays loaded across page changes. Sign out clears
the Showdown partition, including locally stored teams and preferences; export teams first.
Launcher reset removes settings, launcher preferences, and replay notes while keeping the
Showdown partition. Both destructive actions ask for confirmation. Logs contain fixed event
names and numeric error codes, not usernames, credentials, replay URLs or note content.

Showdex, packaging, and licensing remain pending.
