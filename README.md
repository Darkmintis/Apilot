# Apilot

**Your API requests and real responses, versioned in the codebase.**

Apilot keeps endpoint definitions as YAML next to your code. It saves every real response (secrets redacted) and alerts you when a response changes shape, with a GitHub-style diff and the lines of code that are affected. It also generates typed models from real data. Your AI assistant gets Apilot skills and tools automatically and can do everything the GUI can, except see your secrets.

It is not a Postman replacement. It exists to keep your API contract, its history, and your code in sync.

## Features

- **GUI first.** The Apilot panel has a request editor, response view, **Changes** (split diff of baseline vs latest, with breaking/warning/safe labels and code impact), **History** (every saved response; set any as the baseline), **Versions** (v1, v2, … of the request definition, with diff and restore), **Schema**, **Code**, **Environments**, **Import**, and **Run all**.
- **Breaking-change detection.** Removed fields, type changes, non-null becoming nullable, and removed enum values are breaking. Added fields are safe.
- **Lightweight version control for endpoints.** Every save is recorded in `.apilot/history/`, whether it comes from the GUI, a hand edit, or the AI.
- **Codegen.** Dart (freezed or plain + Dio), TypeScript (zod + fetch), Kotlin (kotlinx + Retrofit), and Swift (Codable). Quicktype-style: identical shapes share one class, array items get singular names, repeated strings become enums with an `unknown` fallback, ISO dates become date types, and id-keyed objects become maps. Files you wrote by hand are never overwritten.
- **Chaining and folder defaults.** Chain values with `after: [{ set: { orderId: "$.data[0].id" } }]`. `_folder.yaml` can set shared headers and auth, plus the run `order`.
- **Import** from cURL, Postman v2, or OpenAPI/Swagger.
- **AI with no setup.** The extension writes skills to `.cursor/skills/`, `.claude/skills/`, and `.github/instructions/`, and registers the MCP server (24 tools) with Cursor or VS Code. There is no "connect" button.
- **CI.** `apilot check` fails the build on errors or breaking changes.

## Secrets

Secret values never touch files, git, or the AI.

| Where | Secret values come from |
|---|---|
| Editor | OS keychain (VS Code SecretStorage), entered in **Environments** or when a request needs them |
| CI / CLI / standalone MCP | `APILOT_SECRET_<name>` environment variables |

Snapshots are redacted before they are written. The AI can declare a secret variable, but it cannot read or set its value.

## Packages

| Package | Description |
|---|---|
| `@apilot/core` | File format, `Workspace` (the shared action layer), runner, snapshots, differ, schema, revisions, importers, redaction |
| `@apilot/codegen` | Model and API-call generators |
| `@apilot/mcp` | MCP server and tool table, shared with the extension |
| `@apilot/cli` | `apilot` CLI for CI and scripts |
| `@apilot/skill` | AI skill and instruction files |
| `apilot` | VS Code / Cursor extension (bundles the MCP server and panel) |
| `apilot-webview` | The panel UI (React) |
| `dart/apilot_capture` | Dio interceptor that records Flutter app traffic |

## CLI

```bash
apilot init                       # starter .apilot/
apilot list
apilot run orders.list --env dev
apilot run-all [collection] --env dev
apilot diff orders.list           # baseline → latest, with code impact
apilot baseline orders.list       # accept the latest response
apilot history orders.list        # request versions
apilot codegen orders.list --lang dart
apilot import openapi spec.yaml
apilot check --env dev --markdown "$GITHUB_STEP_SUMMARY"
apilot setup-ai                   # skills for editors without the extension
```

## MCP without the extension

The extension registers the server itself. For other clients:

```jsonc
{
  "mcpServers": {
    "apilot": {
      "command": "npx",
      "args": ["-y", "@apilot/mcp"],
      "env": { "APILOT_PROJECT_ROOT": "/path/to/project" }
    }
  }
}
```

When the editor is open, the MCP server forwards calls to the extension over a local, token-protected bridge (`.apilot/.local/bridge.json`, gitignored), so requests use your keychain secrets and the panel updates live.

## Project layout

```
.apilot/
  apilot.yaml          # name, default environment, codegen targets
  environments/        # variables (secret values are never stored here)
  collections/         # endpoint YAML, nested folders, _folder.yaml defaults
  snapshots/           # redacted responses + baseline marker per endpoint
  history/             # request versions (v1, v2, …)
  .local/              # machine-local state, gitignored
```

## Development

```bash
pnpm install
pnpm build                                    # all packages + webview
pnpm --filter apilot compile                  # extension + bundled MCP server
pnpm --filter @apilot/core exec vitest run
pnpm --filter @apilot/codegen exec vitest run
node scripts/verify-mcp.js                    # MCP over stdio
node scripts/verify-dart-codegen.mjs          # generated Dart compiles + round-trips (needs Dart)
pnpm --filter apilot test                     # integration tests in real VS Code
pnpm --filter apilot package                  # build the .vsix
```

## License

MIT
