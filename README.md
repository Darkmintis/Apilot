# Apilot

**The API workspace inside your editor, built for AI.**

Define API endpoints as YAML files, run them for real, capture responses as snapshots, and detect breaking changes before they ship. AI assistants can use the built-in MCP server to discover, run, and generate code from your APIs.

## Features

- **File-based API definitions** — Endpoints as plain YAML, version-controlled
- **Real-response-first** — Run actual requests, capture responses as snapshots
- **Drift detection** — Diff responses against saved snapshots, classify breaking/warning/non-breaking changes
- **AI-native** — MCP server with 12 tools for AI assistants (list, run, diff, generate code)
- **Multi-language codegen** — Dart (freezed), TypeScript (zod), Kotlin, Swift from real response schemas
- **Secret management** — Environment variables or VS Code OS keychain, never committed
- **CI/CD integration** — `apilot check` fails builds on breaking API changes
- **Flutter capture** — Dio interceptor automatically records app traffic

## Packages

| Package | Description |
|---------|-------------|
| `@apilot/core` | File format, runner, snapshots, differ, schema, redaction |
| `@apilot/codegen` | Language templates (Dart, TS, Kotlin, Swift) |
| `@apilot/mcp` | MCP server for AI assistants |
| `@apilot/cli` | Command-line interface (`apilot run`, `check`, `codegen`) |
| `apilot` | VS Code/Cursor extension with React dashboard |
| `apilot-webview` | Interactive web UI for the dashboard |
| `@apilot/skill` | SKILL.md template generator for AI context |

## Quick Start

### VS Code Extension

1. Open a folder with an `.apilot/` directory (or run **Apilot: Open Dashboard**)
2. Run **Apilot: Connect to AI** to register the MCP server

### CLI

```bash
# Run an endpoint
apilot run orders.list --env dev

# Run all endpoints
apilot run-all --env dev

# Diff snapshots
apilot diff orders.list

# Generate Dart code
apilot codegen orders.list --lang dart --out lib/api

# CI: run all + detect breaking changes
apilot check --env dev
```

### MCP Server

```jsonc
// ~/.cursor/mcp.json or Claude Desktop config
{
  "mcpServers": {
    "apilot": {
      "command": "node",
      "args": ["/path/to/packages/mcp/dist/index.js"],
      "env": {
        "APilot_PROJECT_ROOT": "/path/to/project"
      }
    }
  }
}
```

## Project Structure

```
.apilot/
  apilot.yaml        # project config (name, default env, codegen targets)
  environments/      # env-specific variables + secrets
  collections/       # endpoint definitions (YAML, nested folders)
  snapshots/         # saved request/response pairs
  generated/         # codegen output
  SKILL.md           # AI context (auto-generated)
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm --filter @apilot/core test
pnpm --filter @apilot/codegen test
pnpm --filter apilot test       # VS Code extension tests

# Extension webview
pnpm --filter apilot-webview exec vite build
```

## License

MIT
