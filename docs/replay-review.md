# In-app replay review

Select a saved note in Replay notes and choose **Review replay**. The official replay page
opens next to the same note editor. The app does not reconstruct the battle or calculate
its outcome; Showdown's player provides playback, turns, speed and viewpoint controls.
Its current player implementation is documented in the
[upstream replay source](https://github.com/smogon/pokemon-showdown-client/blob/master/replay.pokemonshowdown.com/src/replays-battle.tsx).

## Working with a replay

- Use the official playback controls in the player pane. The pane can scroll independently
  so controls and the battle log remain accessible at smaller sizes.
- Edit and save the title, format and notes beside the replay. The saved replay link stays
  read-only. **Ctrl+S** saves while focus is in the launcher note editor; keys pressed inside
  the replay player belong to Showdown's player.
- Choose **Hide notes** for a wider player and **Show notes** to continue writing.
- **Reload replay** restarts the replay page only. It keeps the saved note, unsaved draft
  and live Showdown connection intact.
- **Back to notes** returns to the selected note. Leaving review closes its player and
  stops audio. Unsaved notes survive navigation, including automatic navigation when a
  new player battle begins. Closing the app with an unsaved note still asks before discarding it.
- **Open in browser** explicitly opens the saved replay's full URL. Use it for replay-site
  links or features unavailable in the embedded view. Private access suffixes are preserved.

Playback position is not saved when leaving review or reloading. Re-entering starts a new
replay page. Review does not automatically upload a battle, download a replay archive,
save an unsaved note, or add AI analysis. An internet connection and a still-accessible
hosted replay are required.

## Status and errors

**Replay page loaded** confirms a successful page navigation, not that every upstream
asset or replay is available. The upstream page may show an unavailable replay or a
service error. Network failures, HTTP errors and renderer crashes produce a launcher
error state with an explicit reload action; resizing never triggers a silent retry.

The view is tied to the note's replay link. If the site changes to a different replay or
search page, the app stops that view rather than displaying a different battle beside
your notes. Reload returns to the saved replay. If a different note's unsaved draft is
already open, return to Replay notes to resolve it before reviewing another replay.

## Isolation and implementation

`app/replay-review.js` owns a separate `WebContentsView` using a nonpersistent
`replay-review` session. It has no Node integration or preload, stays sandboxed and
context-isolated, denies permission requests, and cancels downloads and popup windows.
The signed-in `persist:showdown` client and its running rooms are separate and remain alive.

Only the local review route can request this view. Main resolves the saved note ID and
reads its validated URL; renderer IPC never accepts a replay URL. Subsequent resize/status
messages use the active note ID without re-reading the whole note store. Bounds are
validated and clipped to the main window. Navigation away, reload and app close dispose
the remote view, and events from disposed views cannot alter a newer review.

Allowed in-page routes retain the exact saved replay path, including the private suffix.
Only upstream playback query parameters are permitted. Other navigation and popup routes
are blocked; opening the system browser requires the launcher button. No replay URL or
note content is added to logs.

`app/replay-theme.css` uses the client theme palette for replay-site chrome. The battle
field, Pokémon, health bars and game colors remain under the upstream renderer. The
desktop layout leaves space for the upstream player's own narrow-screen scaling.

## Verification

The default desktop suite uses a deterministic replay page in an isolated session. It
checks IPC guards, sandbox preferences, private URLs, resizing without playback reloads,
draft preservation, HTTP failure/retry, different-replay navigation, view disposal and
automatic priority for a simulated new player battle.

`npm run test:replays:live` separately loads a public upstream example replay in a temporary
guest profile. It operates Play/Pause, verifies both themes at 1366×768 and 1024×640,
checks horizontal overflow and captures both the launcher and native replay surface under
ignored `out/desktop-smoke/`. Native view pixels are absent from the launcher-only capture,
so the player capture must also be inspected. The test blocks the live battle client's
network and never uses an account or starts a battle.
