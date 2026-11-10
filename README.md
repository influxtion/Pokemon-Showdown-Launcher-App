# Showdown Desktop

A desktop workspace for [Pokémon Showdown](https://play.pokemonshowdown.com/). It wraps the official client in a compact window that keeps your session, and adds space for tools and replay notes.

Early prototype. Showdex, replay notes and practice are not implemented yet.

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

Unit tests cover bridge sanitization, action validation, navigation timing and settings persistence.
The desktop smoke test launches Electron with a temporary profile and simulated Showdown
responses; outbound client requests are blocked. It checks connection feedback, client-view
survival and sizing, theme changes, and battle navigation without sending searches or challenges.
These checks do not verify live account behavior.

Before an alpha release, manually verify sign-in persistence, ratings, team selection,
challenges, a real search becoming a battle, and the friends list using your own account.
Showdex, replay-note persistence, settings beyond appearance, packaging, and licensing remain pending.
