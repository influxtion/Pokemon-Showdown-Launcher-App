# Showdex source and build

The desktop integration uses Showdex v1.4.2 from commit
`165abdb05ad08c5b286f71e21cc1907852efd76f` at
<https://github.com/doshidak/showdex>. Showdex is licensed under AGPL-3.0;
its license is preserved in `LICENSE` beside this file.

Run `node scripts/build-showdex.js` with Node.js 24 and Corepack available.
The script checks out the pinned commit into ignored `out/showdex-source`,
applies the desktop readiness patch recorded in `patches/desktop-ready.patch`,
installs the pinned pnpm 10 dependencies from upstream's lockfile, and builds
the standalone target. It writes the runtime assets and a source archive to
ignored `vendor/showdex/dist/`. The archive contains the patched source,
build inputs, and upstream license. `manifest.json` records the expected SHA-256
of each runtime asset; the script verifies the rebuilt files against it.
`--record` intentionally replaces the tracked manifest and is for reviewed
source or patch updates only.

The desktop patch reports `loaded` only when Showdex has created and rendered
the classic client's Hellodex room. It reports `failed` when that check or
startup fails. The app currently embeds Showdown's classic client.

The pinned build inputs are `BUILD_DATE=1A000000000`,
`UUID_STANDALONE_NAMESPACE=4f7f1e80-1008-4f00-a7c1-113311331133`,
`STANDALONE_RESOURCE_PROTOCOL=showdex`, and
`STANDALONE_RESOURCE_PREFIX=assets`. Assets resolve to
`showdex://assets/<filename>` in the sandboxed Showdown view.

The generated bundle is kept out of Git. Before distributing it, package the
license, the corresponding source archive, and this source record with the app.
