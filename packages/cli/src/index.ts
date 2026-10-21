#!/usr/bin/env node
/**
 * Apilot CLI — for CI and scripts. Same Workspace as the editor panel and
 * the MCP server; secrets come from APILOT_SECRET_<name> environment variables.
 *
 * A folder can hold several Apilot projects. Every command accepts
 * `--project <id>` to pick one; without it the endpoint id is looked up
 * across all of them.
 */

import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectHub, Workspace, importSpec, type DiffResult, type ImportSource, type ProjectEntry } from "@apilot/core";
import { LANGUAGES, generate, writeGenerated } from "@apilot/codegen";
import { writeAiFiles } from "@apilot/skill";

function findRoot(): string {
  const fromEnv = process.env.APILOT_PROJECT_ROOT;
  if (fromEnv) return fromEnv;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".apilot", "apilot.yaml"))) return dir;
    if (dirname(dir) === dir) return process.cwd();
  }
}

const hub = ProjectHub.forRoot(findRoot());
const program = new Command();

program.name("apilot").description("Run, diff, version, and generate code from your API endpoints.").version("0.1.0");

const icon = (level: string) => (level === "breaking" ? "✗" : level === "warning" ? "⚠" : level === "nonBreaking" ? "+" : "·");

function printDiff(diff: DiffResult): void {
  const { breaking, warning, nonBreaking, info } = diff.summary;
  console.log(`  ${breaking} breaking, ${warning} warning, ${nonBreaking} non-breaking, ${info} info`);
  for (const c of diff.changes) console.log(`  ${icon(c.level)} ${c.path} — ${c.description}`);
}

/** The project a command applies to. */
function projectOf(opts: { project?: string }): ProjectEntry {
  return opts.project ? hub.project(opts.project) : hub.defaultProject();
}

/** The endpoint a command applies to, and the project that owns it. */
function endpointOf(id: string, opts: { project?: string }): { project: ProjectEntry; ws: Workspace; endpointId: string } {
  const r = hub.resolveEndpoint(id, opts.project);
  return { project: r.project, ws: r.ws, endpointId: r.endpointId };
}

/** Every project that has an `.apilot` folder. */
function initialized(): ProjectEntry[] {
  return hub.projects.filter((p) => p.hasApilot);
}

function action<A extends unknown[]>(fn: (...args: A) => Promise<void> | void, needsProject = true) {
  return async (...args: A) => {
    try {
      if (needsProject && !hub.exists()) throw new Error("No .apilot/ project found. Run `apilot init` first.");
      await fn(...args);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  };
}

program
  .command("init")
  .description("Create a starter .apilot/ folder")
  .option("-n, --name <name>", "project name")
  .option("-p, --project <id>", "project id (defaults to the first folder without Apilot)")
  .action(action((opts: { name?: string; project?: string }) => {
    const r = hub.initProject(opts.name ?? "my-api", opts.project);
    console.log(`✓ Apilot project ready at ${r.initialized}`);
  }, false));

program
  .command("setup-ai")
  .description("Add Apilot skills for Cursor, Claude Code, and Copilot to this project (the editor extension does this automatically)")
  .action(action(() => {
    const root = hub.defaultProject().root;
    const written = writeAiFiles(root);
    console.log(written.length ? written.map((f) => `✓ ${f}`).join("\n") : "✓ AI skill files already up to date");
    console.log(`\nMCP server (for clients without the extension):\n  command: npx\n  args: ["-y", "@apilot/mcp"]\n  env: { "APILOT_PROJECT_ROOT": "${root}" }`);
  }));

program
  .command("list")
  .description("List endpoints")
  .option("-p, --project <id>", "only this project")
  .action(action((opts: { project?: string }) => {
    const rows = hub.listEndpoints(opts.project);
    if (rows.length && hub.projects.length > 1) {
      console.log(`${"METHOD".padEnd(7)} ${"ENDPOINT".padEnd(32)} ${"PROJECT".padEnd(20)} URL`);
    }
    for (const { project, endpoint } of rows) {
      console.log(
        `${endpoint.method.padEnd(7)} ${endpoint.id.padEnd(32)} ${(hub.projects.length > 1 ? project.id.padEnd(20) : "")}${endpoint.url}`
      );
    }
  }));

program
  .command("run <endpointId>")
  .description("Run one endpoint and save the (redacted) response")
  .option("-e, --env <name>", "environment")
  .option("-p, --project <id>", "project id")
  .action(action(async (id: string, opts: { env?: string; project?: string }) => {
    const { ws, endpointId } = endpointOf(id, opts);
    const r = await ws.run(endpointId, opts.env);
    const s = r.snapshot;
    console.log(`${s.passed ? "✓" : "✗"} ${s.request.method} ${s.request.url} → ${s.status} (${s.timeMs} ms)`);
    for (const f of s.failures) console.log(`  ✗ ${f.message}`);
    console.log(typeof s.body === "string" ? s.body : JSON.stringify(s.body, null, 2));
    if (r.diff?.changes.length) {
      console.log(`\nChanges vs baseline:`);
      printDiff(r.diff);
    }
    if (!s.passed || r.diff?.breaking) process.exitCode = 1;
  }));

program
  .command("run-all [collectionId]")
  .description("Run every endpoint (or one collection) in order, across every project")
  .option("-e, --env <name>", "environment")
  .option("-p, --project <id>", "only this project")
  .action(action(async (collectionId: string | undefined, opts: { env?: string; project?: string }) => {
    const projects = opts.project ? [hub.project(opts.project)] : initialized();
    let passed = 0;
    let failed = 0;
    let breaking = 0;
    for (const project of projects) {
      const r = await hub.workspace(project.id).runAll(collectionId, opts.env);
      for (const x of r.results) {
        const mark = x.error || !x.passed ? "✗" : x.breaking ? "⚠" : "✓";
        const label = projects.length > 1 ? `${x.endpointId} [${project.id}]` : x.endpointId;
        console.log(`  ${mark} ${label.padEnd(40)} ${x.error ?? `${x.status} (${x.timeMs} ms)${x.breaking ? " — breaking changes" : ""}`}`);
      }
      passed += r.passed;
      failed += r.failed;
      breaking += r.breaking;
    }
    console.log(`\n${passed} passed, ${failed} failed, ${breaking} with breaking changes`);
    if (failed || breaking) process.exitCode = 1;
  }));

program
  .command("diff <endpointId>")
  .description("Compare responses (default: baseline → latest)")
  .option("--from <snapshotId>")
  .option("--to <snapshotId>")
  .option("-p, --project <id>", "project id")
  .action(action((id: string, opts: { from?: string; to?: string; project?: string }) => {
    const { ws, endpointId } = endpointOf(id, opts);
    const diff = ws.diff(endpointId, opts.from, opts.to);
    console.log(`Diff ${endpointId}: ${diff.fromId} → ${diff.toId}`);
    printDiff(diff);
    const { matches } = ws.impact(endpointId, diff);
    if (matches.length) {
      console.log(`\nCode using changed fields:`);
      for (const m of matches) console.log(`  ${m.file}:${m.line}  [${m.field}]  ${m.text}`);
    }
    if (diff.breaking) process.exitCode = 2;
  }));

program
  .command("baseline <endpointId> [snapshotId]")
  .description("Accept a response (default: latest) as the baseline")
  .option("-p, --project <id>", "project id")
  .action(action((id: string, snapshotId: string | undefined, opts: { project?: string }) => {
    const { ws, endpointId } = endpointOf(id, opts);
    console.log(`✓ Baseline for ${endpointId} is now ${ws.setBaseline(endpointId, snapshotId)}`);
  }));

program
  .command("history <endpointId>")
  .description("Show the version history of an endpoint's request")
  .option("-p, --project <id>", "project id")
  .action(action((id: string, opts: { project?: string }) => {
    const { ws, endpointId } = endpointOf(id, opts);
    for (const r of ws.revisions(endpointId)) console.log(`  v${r.revision}  ${r.timestamp.slice(0, 19).replace("T", " ")}  ${r.label ? `[${r.label}] ` : ""}${r.summary}`);
  }));

program
  .command("codegen <endpointId>")
  .description(`Generate models + API call (${LANGUAGES.join(" | ")})`)
  .option("-l, --lang <language>", "target language", "dart")
  .option("-o, --out <dir>", "output directory (default: apilot.yaml codegen setting)")
  .option("--flavor <flavor>", "dart: freezed | plain")
  .option("-p, --project <id>", "project id")
  .action(action((id: string, opts: { lang: string; out?: string; flavor?: string; project?: string }) => {
    const { ws, endpointId } = endpointOf(id, opts);
    const r = writeGenerated(ws.root, generate(ws, endpointId, opts.lang, { outDir: opts.out, flavor: opts.flavor }));
    for (const f of r.written) console.log(`✓ wrote ${f}`);
    for (const f of r.unchanged) console.log(`· unchanged ${f}`);
    for (const f of r.skipped) console.log(`⚠ skipped ${f} (hand-written file — no Apilot header)`);
  }));

program
  .command("import <source> <file>")
  .description("Import endpoints: source = curl | postman | openapi")
  .option("-c, --collection <name>", "target collection")
  .option("-e, --env <name>", "environment for imported variables")
  .option("-p, --project <id>", "target project")
  .action(action(async (source: string, file: string, opts: { collection?: string; env?: string; project?: string }) => {
    if (!["curl", "postman", "openapi"].includes(source)) throw new Error("source must be curl, postman, or openapi");
    const content = file === "-" ? readFileSync(0, "utf-8") : readFileSync(file, "utf-8");
    const project = projectOf(opts);
    const r = await importSpec(hub.workspace(project.id), source as ImportSource, content, opts.collection, opts.env);
    for (const id of r.created) console.log(`✓ ${id}`);
    for (const n of r.notes) console.log(`⚠ ${n}`);
  }));

program
  .command("check")
  .description("CI: run everything; fail on errors or breaking changes vs baseline")
  .option("-e, --env <name>", "environment")
  .option("-p, --project <id>", "only this project")
  .option("--markdown <file>", "also write a Markdown summary (e.g. $GITHUB_STEP_SUMMARY)")
  .action(action(async (opts: { env?: string; project?: string; markdown?: string }) => {
    const projects = opts.project ? [hub.project(opts.project)] : initialized();
    const rows: string[] = [];
    let passed = 0;
    let failed = 0;
    let breaking = 0;
    for (const project of projects) {
      const r = await hub.workspace(project.id).runAll(undefined, opts.env);
      for (const x of r.results) {
        const mark = x.error || !x.passed ? "✗" : x.breaking ? "⚠" : "✓";
        console.log(`  ${mark} ${x.endpointId} ${x.error ?? x.status}`);
        rows.push(`| ${mark} | \`${x.endpointId}\` | ${project.id} | ${x.error ? `error: ${x.error.replace(/\|/g, "\\|")}` : x.status} | ${x.summary ? `${x.summary.breaking} breaking, ${x.summary.warning} warning` : "—"} |`);
        if (x.breaking) printDiff(hub.workspace(project.id).diff(x.endpointId));
      }
      passed += r.passed;
      failed += r.failed;
      breaking += r.breaking;
    }
    const ok = failed === 0 && breaking === 0;
    const md = `## Apilot check — ${ok ? "✅ passed" : "❌ failed"}\n\n${passed} passed · ${failed} failed · ${breaking} breaking\n\n| | Endpoint | Project | Status | Changes vs baseline |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
    if (opts.markdown) (existsSync(opts.markdown) ? appendFileSync : writeFileSync)(opts.markdown, md);
    console.log(ok ? "\n✅ All checks passed." : "\n❌ Checks failed — errors or breaking changes detected.");
    if (!ok) process.exitCode = 1;
  }));

program.parseAsync();
