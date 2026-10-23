# Security

Apilot reads HTTP responses and stores them in your repository, so it has two jobs that can
go wrong quietly: keeping secrets out of files, and not silently corrupting the record of
what your API returned.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting on this repository:

[Report a vulnerability](https://github.com/Darkmintis/Apilot/security/advisories/new)

That opens a private advisory visible only to you and the maintainer. If you cannot use it,
open an issue that says only "I have a security report" and wait to be contacted.

Useful reports, in rough order of severity:

- A secret value (token, password, key, cookie) reaching a file that is committed, a
  snapshot, a log, or an MCP tool result.
- The bridge in `.apilot/.local/bridge.json` accepting calls without the token, leaking the
  token, or being reachable beyond `127.0.0.1`.
- A way to make the MCP server or a generated file write outside the project directory.
- Code execution through an imported spec, a cURL command, or a crafted `apilot.yaml`.

This is a single-maintainer project. You will get an acknowledgement as soon as possible,
but no contractual response time. Please give a reasonable window before disclosing.

## What Apilot guarantees, and what it does not

Secret *values* are never written to `.apilot/`: the editor keeps them in the OS keychain
and CI reads `APILOT_SECRET_<name>`. Responses are redacted before they are saved.

But redaction only knows about values you declared. **If an endpoint returns a secret that
is not modelled as a variable — a session token in a response body, a personal identifier —
it can land in `.apilot/snapshots/` and be committed.** Treat snapshots as data you publish:
review them before committing, and keep secrets out of response bodies where the API allows.

Snapshots are written by design. That is the feature, and also the risk.

## Supported versions

The latest published release. This project is pre-1.0: fixes ship in the next release rather
than as backports to older ones.
