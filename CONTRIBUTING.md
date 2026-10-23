# Contributing

Thanks for taking the time. Apilot is small and opinionated, so a short conversation before a
large change beats a large pull request that has to be reworked.

## Before you start

- **Bugs**: open an issue using the bug template. Include the editor (VS Code or Cursor), its
  version, the Apilot version, and which **profile** you use — profile mismatches look exactly
  like "the extension is not installed".
- **Features**: open an issue first. Apilot is deliberately not a Postman replacement; changes
  that push it toward one will be declined.

## Requirements

- **Node 24** (`.nvmrc`), pnpm 11 via corepack: run `corepack enable` once.
- **Dart** only if you touch codegen (`node scripts/verify-dart-codegen.mjs`).

## Setup

```bash
corepack enable
pnpm install
pnpm build                       # all packages + webview
pnpm --filter apilot compile     # extension bundle + bundled MCP server
```

`pnpm build` must run before packaging or testing the extension: `dist/mcp.mjs` and
`dist/webview/` are produced there, and the extension does not build them itself.

## Tests

```bash
pnpm --filter @apilot/core exec vitest run --pool=threads
pnpm --filter @apilot/codegen exec vitest run --pool=threads
pnpm --filter @apilot/mcp exec vitest run --pool=threads
pnpm --filter apilot-webview exec vitest run --pool=threads

node scripts/verify-mcp.js                       # MCP over stdio
node scripts/verify-mcp.js packages/extension/dist/mcp.mjs   # the bundled copy

pnpm --filter apilot test        # integration suite in a real VS Code window
```

The integration suite downloads VS Code on first run and needs a display; on a headless Linux
machine use `xvfb-run -a pnpm --filter apilot test`. It never waits on the OS file watcher, so
do not add assertions that do — re-scan through `apilot.refresh` instead.

## Layout

Everything is a package under `packages/`; the README has the one-line summary of each. The
rule of thumb: `core` owns behaviour, `mcp` owns the tool table, `extension` and `webview` own
the editor, `cli` owns CI. Logic in the extension that could live in `core` belongs in `core`.

## Commits and pull requests

- Conventional commits with a package scope: `feat(mcp): …`, `fix(core): …`, `docs: …`.
- One logical change per commit. Do not mix a refactor with a behaviour change.
- Before opening a PR: build, run the unit tests for the packages you touched, and run the
  integration suite if you changed the extension or the webview.
- Do not commit `dist/`, `.vsix` files, `node_modules/`, or anything under `.apilot/`.

## Versions

All packages share one version and move together: bump every `packages/*/package.json`,
commit, then tag. The release workflow refuses a tag that does not match
`packages/extension/package.json`, and builds the `.vsix` from that commit. Do not tag from a
branch whose CI is red.

```bash
VERSION="$(node -p "require('./packages/extension/package.json').version")"
git tag "v$VERSION"
git push origin "v$VERSION"
```
