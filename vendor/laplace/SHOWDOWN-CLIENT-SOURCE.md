# Showdown practice client

Practice uses the classic Pokémon Showdown client from commit [`49b54209ebee54ceb8fff62a5eb5bedf7efcf6dc`](https://github.com/smogon/pokemon-showdown-client/tree/49b54209ebee54ceb8fff62a5eb5bedf7efcf6dc), under the GNU Affero General Public License v3. See `SHOWDOWN-CLIENT-LICENSE`.

The client data build uses [`202b6b385c2536977c60a97bf12d931c2d449586`](https://github.com/smogon/pokemon-showdown/tree/202b6b385c2536977c60a97bf12d931c2d449586) of the Pokémon Showdown server for its Dex and translation tooling. This build input is separate from the pinned simulator used for local battles.

From the Desktop checkout, run `node scripts/laplace/build-client.cjs` with Node.js 24.12 or later, Git and npm. The builder fetches the two pinned sources under `out/practice-client-source`, uses their dependency locks, runs the upstream client build, and stages the needed browser files under `vendor/laplace/dist/client`. The builder contains the changes applied to the staged client. It switches to a fixed raw WebSocket URL, skips online color and rating lookups, keeps preferences and teams within the practice partition, and uses the local logo. `practice-client.html`, `practice-client.css` and `client-bootstrap.js` provide the entry page and local guest flow.

The practice build skips automatic chat room joins and keeps the battle open after forfeiting so the result and rematch are available.

Battle code and data are staged locally. The client uses upstream static sprite fallbacks and battle images from the official asset host. Pokémon names and artwork retain their respective ownership.
