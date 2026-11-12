# Showdown Desktop

A desktop workspace for [Pokémon Showdown](https://play.pokemonshowdown.com/). It hosts the official client in a dedicated window that keeps your session, and adds a Home hub, replay notes with in-app review and backup, an optional Showdex calculator, and practice against the Laplace and Foul Play bots on a private hosted battle service.

Early prototype, Windows first. Nothing is published yet.

- **[Design document](docs/design.md):** goals, architecture, features, decisions, security, testing, packaging and release plan.
- **[Practice bots](docs/bots.md):** how Foul Play and Laplace work, their protocols, performance, and how to run, test and host them.

## Run

Requires Node.js 24.

```sh
npm install
npm start
```

Optional Showdex build: `npm run build:showdex`, then enable it in Settings and reload the client.

## Verify

```sh
npm run check
npm test
npm run test:desktop
```

Desktop tests use temporary profiles and simulated Showdown sessions. They never sign in, search or challenge. See [Testing](docs/design.md#7-testing) for the live and bot suites.

## Package

```sh
npm run build:practice
npm run pack:win:dir
npm run smoke:packaged
npm run pack:win
```

This builds an unsigned Windows x64 installer in `out/windows/`. See [Build, packaging and release](docs/design.md#8-build-packaging-and-release).

## License

Not chosen yet. Third-party sources and licenses are recorded under `vendor/`.
