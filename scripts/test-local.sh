#!/usr/bin/env bash
#
# test-local.sh — Local testing workflow for the Apilot VS Code extension.
#
# Usage:
#   ./scripts/test-local.sh dev      # Launch VS Code with the extension in development mode (live reload)
#   ./scripts/test-local.sh vsix     # Build + package a .vsix, install it, and launch the editor
#   ./scripts/test-local.sh install  # Build + package a .vsix and install into your editor (no launch)
#   ./scripts/test-local.sh test     # Run the full automated test suite (unit + integration + MCP + CLI)
#   ./scripts/test-local.sh watch    # Start the extension bundle in watch mode (for `dev`)
#   ./scripts/test-local.sh clean    # Remove all build artifacts
#
# Editor selection:
#   The script uses Cursor if installed, otherwise VS Code. Override with:
#     export APILOT_EDITOR=code     # force VS Code
#     export APILOT_EDITOR=cursor   # force Cursor
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── helpers ────────────────────────────────────────────────────────────────────

info()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

PROJECT="${ROOT}/packages/mcp/test-project"

# Pick the editor: honour APILOT_EDITOR, fall back to cursor → code.
pick_editor() {
  if [ -n "${APILOT_EDITOR:-}" ]; then
    command -v "$APILOT_EDITOR" >/dev/null 2>&1 && echo "$APILOT_EDITOR" && return
  fi
  command -v cursor >/dev/null 2>&1 && echo cursor && return
  echo code
}

EDITOR_BIN="$(pick_editor)"

# ── build helpers ─────────────────────────────────────────────────────────────

build_all() {
  info "Building all packages (core, codegen, mcp, cli, skill)"
  pnpm -r --filter "./packages/*" --filter "!apilot" --filter "!apilot-webview" build

  info "Building webview (React UI)"
  pnpm --filter apilot-webview build

  info "Building extension bundle (esbuild)"
  pnpm --filter apilot compile
  ok "All packages built"
}

latest_vsix() {
  ls -t "$ROOT"/packages/extension/apilot-*.vsix 2>/dev/null | head -1
}

# ── subcommands ───────────────────────────────────────────────────────────────

cmd_watch() {
  info "Starting watch mode (extension host + MCP bundle)…"
  info "Edit TypeScript source files and see the extension reload in the editor."
  info "Note: the webview (React UI) is NOT rebuilt by watch — rerun"
  info "      'pnpm --filter apilot-webview build' for webview changes."
  info "Press Ctrl-C when done."
  pnpm --filter apilot watch
}

cmd_dev() {
  # Make sure dist exists (extension host bundle + webview).
  if [ ! -f "$ROOT/packages/extension/dist/extension.js" ] || [ ! -f "$ROOT/packages/extension/dist/webview/index.js" ]; then
    info "No dist found — building first…"
    build_all
  fi

  info "Launching VS Code with Apilot in development mode…"
  info "  • The extension is loaded from ./packages/extension (not installed)."
  info "  • Start 'test-local.sh watch' in another terminal to rebuild on save."
  info "  • UI/webview changes: rerun 'pnpm --filter apilot-webview build'"
  info "  • Opening the sample project at packages/mcp/test-project"

  code \
    --extensionDevelopmentPath="$ROOT/packages/extension" \
    --disable-extension apilot-dev.apilot \
    "$PROJECT"
}

cmd_install() {
  build_all

  info "Packaging .vsix (production bundle)…"
  pnpm --filter apilot exec vsce package --no-dependencies

  VSIX="$(latest_vsix)"
  if [ -z "$VSIX" ]; then
    warn "No .vsix found after packaging — did vsce fail?"
    exit 1
  fi
  ok "Built $(basename "$VSIX")"

  info "Installing into $EDITOR_BIN…"
  "$EDITOR_BIN" --install-extension "$VSIX" --force 2>&1 || true
  ok "Installed apilot-dev.apilot into $EDITOR_BIN"
  echo
  info "Open any project folder to test:"
  info "  $EDITOR_BIN /path/to/your/project"
  info "Or open the sample project:"
  info "  $EDITOR_BIN $PROJECT"
}

cmd_vsix() {
  cmd_install
  info "Launching $EDITOR_BIN with the sample project…"
  "$EDITOR_BIN" "$PROJECT"
}

cmd_test() {
  info "Running full automated test suite…"
  build_all

  # 1. Unit tests
  info "Unit tests — @apilot/core"
  pnpm --filter @apilot/core exec vitest run

  info "Unit tests — @apilot/codegen"
  pnpm --filter @apilot/codegen exec vitest run

  info "Unit tests — @apilot/mcp"
  pnpm --filter @apilot/mcp exec vitest run

  info "Unit tests — apilot-webview"
  pnpm --filter apilot-webview exec vitest run

  # 2. MCP smoke test (source + bundled)
  info "MCP smoke test — source build"
  node scripts/verify-mcp.js

  info "MCP smoke test — extension bundle"
  node scripts/verify-mcp.js packages/extension/dist/mcp.mjs

  # 3. Extension integration tests (real VS Code via @vscode/test-electron)
  info "Extension integration tests"
  pnpm --filter apilot test

  # 4. CLI check against the sample project
  info "CLI check — apilot check against sample project"
  (cd "$PROJECT" && APILOT_SECRET_authToken=ci-test-token \
    node "$ROOT/packages/cli/dist/index.js" check --env dev --markdown "$ROOT/.local/last-check-summary.md")

  ok "All tests passed ✅"
}

cmd_clean() {
  info "Cleaning build artifacts…"
  pnpm -r --filter "./packages/*" --filter "!apilot" --filter "!apilot-webview" clean
  pnpm --filter apilot clean
  rm -rf "$ROOT/packages/extension/dist" "$ROOT/packages/webview/dist"
  rm -f "$ROOT/packages/extension/apilot-*.vsix"
  rm -rf "$ROOT/.local/last-check-summary.md"
  ok "Clean done"
}

# ── dispatch ───────────────────────────────────────────────────────────────────

case "${1:-}" in
  watch)  cmd_watch ;;
  dev)    cmd_dev ;;
  vsix)   cmd_vsix ;;
  install) cmd_install ;;
  test)   cmd_test ;;
  clean)  cmd_clean ;;
  ""|help|-h|--help)
    cat <<'EOF'
Apilot local testing workflow

  test-local.sh dev      Launch VS Code with the extension in development mode
  test-local.sh install  Build + package a .vsix and install into your editor
  test-local.sh vsix     Build + package + install + launch the editor
  test-local.sh watch    Start extension bundle watch mode (for `dev`)
  test-local.sh test     Run full automated test suite
  test-local.sh clean    Remove all build artifacts

Set APILOT_EDITOR=code or APILOT_EDITOR=cursor to choose your editor.
Default: Cursor if installed, otherwise VS Code.
EOF
    ;;
  *)
    echo "Unknown command: $1" >&2
    exit 1
    ;;
esac
