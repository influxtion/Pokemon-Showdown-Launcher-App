# Showdown Desktop

A Windows app for playing [Pokémon Showdown](https://play.pokemonshowdown.com/). It runs the official Showdown client in its own window and adds a few tools around it.

**This is a work in progress.** Nothing has been released yet. A Windows installer is coming, but until then expect missing features, rough edges and things that change between versions.

Showdown Desktop is a fan project. It is not made by or affiliated with Pokémon Showdown, Smogon, Nintendo or The Pokémon Company.

## What it does

- **The real client.** You play on the official Showdown site with your own account. The app restyles it to match, but battles, teams and chat work exactly as they do on the website. If something in the app breaks, you're back to plain Showdown.
- **Home.** Pick a format and team and start a battle. Home also shows your rating and record for that format, plus news, your friends and chat rooms.
- **Stats.** Your ladder record across every format: rating, win rate, wins, losses and GXE.
- **Replay notes.** Save replays, write notes on them, rewatch them in the app, and back them up to a file.
- **Showdex.** Optionally turn on the [Showdex](https://github.com/doshidak/showdex) damage calculator inside battles.
- **Practice bots.** Play Gen 9 Random Battles against two bots, Laplace and Foul Play. The bots run on a separate private server and never touch your Showdown account or the public ladder. This isn't open to players yet because that server hasn't gone live.
- **Light and dark themes.** Pick one in Settings or let the app follow Windows.

The app never searches for battles, challenges anyone or plays on your account by itself.

## For developers

- [docs/design.md](docs/design.md) covers how the app is built, how to run it from source, testing and packaging.
- [docs/bots.md](docs/bots.md) explains how the practice bots work and how to run and host them.

## License

No license has been chosen yet. Third-party code and its licenses are listed under `vendor/`.
