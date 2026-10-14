# Local Testing Guide

This guide explains how to test the Apilot VS Code extension locally — from rapid
development iteration to full automated verification — before publishing.

## Quick start

```bash
# Run the full automated test suite (unit + integration + MCP + CLI)
./scripts/test-local.sh test

# Quick iteration: rebuild on save + live reload in VS Code
./scripts/test-local.sh watch   # terminal 1
./scripts/test-local.sh dev     # terminal 2

# Package + install as a real .vsix (what marketplace users get), then launch
./scripts/test-local.sh vsix

# Just build + install the .vsix without launching the editor
./scripts/test-local.sh install
```

> By default the script targets **Cursor** if installed, otherwise **VS Code**.
> Override with: `export APILOT_EDITOR=code` or `export APILOT_EDITOR=cursor`

---

## Project structure

```
Apilot/                          ← monorepo root (pnpm workspace)
  packages/
    core/                         ← File format, Workspace, runner, snapshots, differ
    codegen/                      ← Model generators (Dart, TS, Kotlin, Swift)
    mcp/                          ← MCP server (24 tools), shared with the extension
    cli/                          ← `apilot` CLI for CI and scripts
    skill/                        ← AI skill + instruction files
    extension/                    ← VS Code/Cursor extension (panel UI + commands)
      dist/                       ← Compiled extension.js + mcp.mjs + webview/
      src/extension.ts            ← Extension entry point (566 lines)
    webview/                      ← React UI for the panel
      dist/                       ← Built React app (loaded by the webview)
  scripts/
    verify-mcp.js                 ← MCP over-stdio smoke test
    verify-dart-codegen.mjs       ← Verifies generated Dart compiles + round-trips
    test-local.sh                 ← ← This workflow script
  packages/mcp/test-project/      ← Persistent sample project (real API, JSONPlaceholder)
      .apilot/
        apilot.yaml               # project config: name, default env, codegen targets
        environments/dev.yaml     # variables (baseUrl, authToken as secret, userId)
        collections/orders/       # endpoint YAML files
          _folder.yaml            # shared headers + run order
          list.yaml               # GET /posts?userId=1
          get.yaml                # GET /posts/{postId}
```

---

## Testing workflows

### 1. Rapid development (`dev` + `watch`)

This is the fastest loop for day-to-day development:

**Terminal 1 — watch mode:**
```bash
./scripts/test-local.sh watch
```
This runs `pnpm --filter apilot watch`, which uses esbuild to rebuild
`dist/extension.js` and `dist/mcp.mjs` on every source save. VS Code
auto-reloads the extension when the bundled files change.

**Terminal 2 — launch VS Code:**
```bash
./scripts/test-local.sh dev
```
This launches VS Code with `--extensionDevelopmentPath=packages/extension` and
opens the sample test project. The extension is loaded from source (under `dist/`),
not from an installed `.vsix`.

> **Webview changes:** The React UI is built into `dist/webview/`. esbuild's watch
> mode does **not** rebuild the webview. After editing the webview, rerun:
> ```bash
> pnpm --filter apilot-webview build
> ```

> If the extension is already installed (from a previous `.vsix` install), the `dev`
> command adds `--disable-extension apilot-dev.apilot` to prevent conflicts.

### 2. VSIX install (`install` / `vsix`)

This builds a **production bundle** and installs it as a real `.vsix` — exactly what
a marketplace user would get. This is the closest you can get to the published
experience without actually publishing.

```bash
./scripts/test-local.sh install  # build + package + install (no launch)
./scripts/test-local.sh vsix     # same + launches the editor
```

What it does:
1. Builds all packages (core → codegen → mcp → cli → skill → webview → extension)
2. Packages the `.vsix` with `vsce package --no-dependencies`
3. Installs it into **Cursor** (if available) or **VS Code** with `--force`
4. (`vsix` only) Opens the sample test project

**The `.vsix` is self-contained.** It bundles:
- `dist/extension.js` — the extension host code
- `dist/mcp.mjs` — the MCP server (24 tools, esbuild-bundled)
- `dist/webview/index.js` + `dist/webview/style.css` — the React panel UI
- Icons and license

No separate installation of CLI, MCP server, or codegen is needed in the editor —
they're all bundled inside.

**To install manually:**
```bash
# Build everything
pnpm build
pnpm --filter apilot compile

# Package
pnpm --filter apilot exec vsce package --no-dependencies

# Install into VS Code (or `cursor --install-extension … --force`)
code --install-extension packages/extension/apilot-0.1.0.vsix --force

# Open any project folder to test
code /path/to/your/project
```

### 3. Automated tests (`test`)

Runs the full suite that CI runs (minus the optional Dart codegen job):

```bash
./scripts/test-local.sh test
```

This runs:
| Step | What it tests |
|---|---|
| Unit tests (core) | 53 tests: schema, differ, redaction, variables, file-format, workspace |
| Unit tests (codegen) | 23 tests: model generation for all 4 languages |
| Unit tests (mcp) | 43 tests: all 24 MCP tools |
| Unit tests (webview) | 24 tests: React components (JSON diff, result tabs, App) |
| MCP smoke test (source) | Starts the MCP server over stdio, lists 24 tools, calls `list_endpoints` |
| MCP smoke test (bundle) | Same test against the esbuild-bundled `dist/mcp.mjs` |
| Extension integration tests | 4 tests in a real VS Code: commands, AI auto-setup, bridge auth, panel opens |
| CLI check | `apilot check` against the sample project (HTTP 200 on both endpoints) |

**Individual commands you can run separately:**

```bash
# Unit tests (any package)
pnpm --filter @apilot/core exec vitest run
pnpm --filter @apilot/codegen exec vitest run
pnpm --filter @apilot/mcp exec vitest run
pnpm --filter apilot-webview exec vitest run

# MCP smoke test
node scripts/verify-mcp.js                           # source build
node scripts/verify-mcp.js packages/extension/dist/mcp.mjs  # extension bundle

# Extension integration tests (launches real VS Code)
pnpm --filter apilot test

# CLI check against the sample project
(cd packages/mcp/test-project && \
  APILOT_SECRET_authToken=ci-test-token \
  node ../../cli/dist/index.js check --env dev)

# Dart codegen verification (requires Dart SDK)
node scripts/verify-dart-codegen.mjs
```

### 4. Clean (`clean`)

```bash
./scripts/test-local.sh clean
```

Removes all `dist/`, `.tsbuildinfo`, and `.vsix` files across every package.

---

## Testing in other projects

To test the extension in a project of your own:

1. **Install the `.vsix`:**
   ```bash
   ./scripts/test-local.sh install
   ```

2. **Open your project in Cursor/VS Code:**
   ```bash
   cursor /path/to/your/project
   # or
   code /path/to/your/project
   ```

3. **If your project doesn't have an `.apilot/` folder yet:**
   - The Apilot panel will show a welcome view with **Initialize Apilot Project**.
   - Or run `Cmd/Ctrl+Shift+P` → "Apilot: Initialize Project" and enter a name.

4. **If your project already has an `.apilot/` folder:**
   - The extension activates automatically.
   - Endpoints show up in the **Apilot** sidebar view.
   - Open the panel with the "Apilot: Open Panel" command.

5. **After making code changes, reinstall:**
   ```bash
   ./scripts/test-local.sh install   # rebuilds + reinstalls the .vsix
   ```
   Then reload the window (`Ctrl+Shift+P` → "Developer: Reload Window").

---

## The sample test project

`packages/mcp/test-project/` is a ready-to-use Apilot project with two endpoints
hitting the public [JSONPlaceholder](https://jsonplaceholder.typicode.com) API
(no auth required):

- **orders.list** — `GET /posts?userId=1` (chains `postId` into the next request)
- **orders.get** — `GET /posts/{postId}`

The `dev` environment has:
- `baseUrl` → `https://jsonplaceholder.typicode.com` (text)
- `authToken` → a secret variable (set via `APILOT_SECRET_authToken` in CI)
- `userId` → `1` (text)

Snapshots and history are gitignored (`.apilot/snapshots/` and `.apilot/history/`).
This means:
- Running the endpoints saves fresh snapshots for testing
- The baseline/comparison logic stays consistent across runs
- You can test breaking-change detection by modifying a request

---

## Testing workflow for CI parity

The `scripts/test-local.sh test` command mirrors what `.github/workflows/ci.yml` does
(excluding the optional Dart codegen job and VSIX packaging + artifact upload).
You can use it as a pre-push gate:

```bash
./scripts/test-local.sh test  # manually before publishing
```

Before packaging for publish:
```bash
./scripts/test-local.sh clean
./scripts/test-local.sh vsix   # verifies the full build + package pipeline
```
