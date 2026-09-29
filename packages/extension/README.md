# Apilot

Keep your API requests and their real responses in your repo, next to the code that uses them. When a response changes shape, Apilot shows a GitHub-style diff, marks what is breaking, and points to the lines of code that use the changed fields.

## What you get

- **Endpoints as YAML** in `.apilot/collections/`, reviewed and versioned like code. Folders can share headers and auth (`_folder.yaml`).
- **Real responses, saved.** Every run saves a redacted snapshot. The first successful run becomes the **baseline**, and later runs are compared to it.
- **Breaking-change alerts.** Removed fields, type changes, and values becoming nullable are breaking. Added fields are safe. The Changes tab shows a split diff and the lines of code that are affected.
- **Versions.** Every edit to a request is recorded as v1, v2, … ("added query expand"), whether it comes from the panel, the YAML, or your AI. You can compare any two versions and restore one in a click.
- **Typed models from real data.** Generate Dart (freezed or plain, plus Dio), TypeScript (zod + fetch), Kotlin (kotlinx + Retrofit), or Swift (Codable). Files you wrote by hand are never overwritten.
- **Chaining.** Capture `$.data[0].id` from one response and use `{{orderId}}` in the next request.
- **Import** from cURL, Postman v2, or OpenAPI/Swagger. Credentials in the import become keychain secrets automatically.
- **Your AI already knows it.** When you open a project, Apilot adds skills for Cursor, Claude Code, and Copilot and registers its MCP server. There is no "connect" step. The AI can do everything the panel can: run endpoints, diff, find impact, generate models, edit requests, and manage versions.

## Secrets stay secret

- Secret values live only in your OS keychain. They are never written to files and never reach git.
- Saved responses are redacted: tokens, JWTs, and sensitive keys are replaced before anything is written.
- The AI can declare that a secret exists, but it can never read or set the value. You enter it in **Environments**.
- In CI, provide secrets as `APILOT_SECRET_<name>` environment variables.

## Getting started

1. Open the **Apilot** view in the activity bar and choose **Initialize Apilot Project**, or **Import…** existing requests.
2. Pick an endpoint and press **Send** (Ctrl/Cmd+Enter).
3. After the backend changes, send it again. The Changes tab shows exactly what changed.

## CI

```bash
npx @apilot/cli check --env dev --markdown "$GITHUB_STEP_SUMMARY"
```

This fails the build on errors or breaking changes against the committed baselines.

## Settings

| Setting | Default | |
|---|---|---|
| `apilot.ai.autoSetup` | `true` | Add AI skills and register the MCP server automatically |
| `apilot.timeout` | `30000` | Request timeout (ms) |

To undo the AI setup, run **Apilot: Remove AI Assistant Setup**. It deletes only the files Apilot created.
