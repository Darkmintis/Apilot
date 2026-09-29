#!/usr/bin/env node
/**
 * Apilot CLI — for CI and scripts. Same Workspace as the editor panel and
 * the MCP server; secrets come from APILOT_SECRET_<name> environment variables.
 */

import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Workspace, importSpec, type DiffResult, type ImportSource } from "@apilot/core";
import { LANGUAGES, generate, writeGenerated } from "@apilot/codegen";
import { writeAiFiles } from "@apilot/skill";

function findRoot(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".apilot", "apilot.yaml"))) return dir;
    if (dirname(dir) === dir) return process.cwd();
  }
}

const ws = new Workspace(findRoot());
const program = new Command();

program.name("apilot").description("Run, diff, version, and generate code from your API endpoints.").version("0.1.0");

const icon = (level: string) => (level === "breaking" ? "✗" : level === "warning" ? "⚠" : level === "nonBreaking" ? "+" : "·");

function printDiff(diff: DiffResult): void {
  const { breaking, warning, nonBreaking, info } = diff.summary;
  console.log(`  ${breaking} breaking, ${warning} warning, ${nonBreaking} non-breaking, ${info} info`);
  for (const c of diff.changes) console.log(`  ${icon(c.level)} ${c.path} — ${c.description}`);
}

function action<A extends unknown[]>(fn: (...args: A) => Promise<void> | void, needsProject = true) {
  return async (...args: A) => {
    try {
      if (needsProject && !ws.exists()) throw new Error("No .apilot/ project found. Run `apilot init` first.");
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
  .action(action((opts: { name?: string }) => {
    ws.init(opts.name);
    console.log(`✓ Apilot project ready at ${ws.apilotDir}`);
  }, false));

program
  .command("setup-ai")
  .description("Add Apilot skills for Cursor, Claude Code, and Copilot to this project (the editor extension does this automatically)")
  .action(action(() => {
    const written = writeAiFiles(ws.root);
    console.log(written.length ? written.map((f) => `✓ ${f}`).join("\n") : "✓ AI skill files already up to date");
    console.log(`\nMCP server (for clients without the extension):\n  command: npx\n  args: ["-y", "@apilot/mcp"]\n  env: { "APILOT_PROJECT_ROOT": "${ws.root}" }`);
  }));

program
  .command("list")
  .description("List endpoints")
  .action(action(() => {
    for (const e of ws.registry().endpoints) console.log(`${e.method.padEnd(7)} ${e.id.padEnd(32)} ${e.url}`);
  }));

program
  .command("run <endpointId>")
  .description("Run one endpoint and save the (redacted) response")
  .option("-e, --env <name>", "environment")
  .action(action(async (id: string, opts: { env?: string }) => {
    const r = await ws.run(id, opts.env);
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
  .description("Run every endpoint (or one collection) in order")
  .option("-e, --env <name>", "environment")
  .action(action(async (collectionId: string | undefined, opts: { env?: string }) => {
    const r = await ws.runAll(collectionId, opts.env);
    for (const x of r.results) {
      const mark = x.error || !x.passed ? "✗" : x.breaking ? "⚠" : "✓";
      console.log(`  ${mark} ${x.endpointId.padEnd(32)} ${x.error ?? `${x.status} (${x.timeMs} ms)${x.breaking ? " — breaking changes" : ""}`}`);
    }
    console.log(`\n${r.passed} passed, ${r.failed} failed, ${r.breaking} with breaking changes (env: ${r.env})`);
    if (r.failed || r.breaking) process.exitCode = 1;
  }));

program
  .command("diff <endpointId>")
  .description("Compare responses (default: baseline → latest)")
  .option("--from <snapshotId>")
  .option("--to <snapshotId>")
  .action(action((id: string, opts: { from?: string; to?: string }) => {
    const diff = ws.diff(id, opts.from, opts.to);
    console.log(`Diff ${id}: ${diff.fromId} → ${diff.toId}`);
    printDiff(diff);
    const { matches } = ws.impact(id, diff);
    if (matches.length) {
      console.log(`\nCode using changed fields:`);
      for (const m of matches) console.log(`  ${m.file}:${m.line}  [${m.field}]  ${m.text}`);
    }
    if (diff.breaking) process.exitCode = 2;
  }));

program
  .command("baseline <endpointId> [snapshotId]")
  .description("Accept a response (default: latest) as the baseline")
  .action(action((id: string, snapshotId?: string) => {
    console.log(`✓ Baseline for ${id} is now ${ws.setBaseline(id, snapshotId)}`);
  }));

program
  .command("history <endpointId>")
  .description("Show the version history of an endpoint's request")
  .action(action((id: string) => {
    for (const r of ws.revisions(id)) console.log(`  v${r.revision}  ${r.timestamp.slice(0, 19).replace("T", " ")}  ${r.label ? `[${r.label}] ` : ""}${r.summary}`);
  }));

program
  .command("codegen <endpointId>")
  .description(`Generate models + API call (${LANGUAGES.join(" | ")})`)
  .option("-l, --lang <language>", "target language", "dart")
  .option("-o, --out <dir>", "output directory (default: apilot.yaml codegen setting)")
  .option("--flavor <flavor>", "dart: freezed | plain")
  .action(action((id: string, opts: { lang: string; out?: string; flavor?: string }) => {
    const r = writeGenerated(ws.root, generate(ws, id, opts.lang, { outDir: opts.out, flavor: opts.flavor }));
    for (const f of r.written) console.log(`✓ wrote ${f}`);
    for (const f of r.unchanged) console.log(`· unchanged ${f}`);
    for (const f of r.skipped) console.log(`⚠ skipped ${f} (hand-written file — no Apilot header)`);
  }));

program
  .command("import <source> <file>")
  .description("Import endpoints: source = curl | postman | openapi")
  .option("-c, --collection <name>", "target collection")
  .option("-e, --env <name>", "environment for imported variables")
  .action(action(async (source: string, file: string, opts: { collection?: string; env?: string }) => {
    if (!["curl", "postman", "openapi"].includes(source)) throw new Error("source must be curl, postman, or openapi");
    const content = file === "-" ? readFileSync(0, "utf-8") : readFileSync(file, "utf-8");
    const r = await importSpec(ws, source as ImportSource, content, opts.collection, opts.env);
    for (const id of r.created) console.log(`✓ ${id}`);
    for (const n of r.notes) console.log(`⚠ ${n}`);
  }));

program
  .command("check")
  .description("CI: run everything; fail on errors or breaking changes vs baseline")
  .option("-e, --env <name>", "environment")
  .option("--markdown <file>", "also write a Markdown summary (e.g. $GITHUB_STEP_SUMMARY)")
  .action(action(async (opts: { env?: string; markdown?: string }) => {
    const r = await ws.runAll(undefined, opts.env);
    const rows: string[] = [];
    for (const x of r.results) {
      const mark = x.error || !x.passed ? "✗" : x.breaking ? "⚠" : "✓";
      console.log(`  ${mark} ${x.endpointId} ${x.error ?? x.status}`);
      rows.push(`| ${mark} | \`${x.endpointId}\` | ${x.error ? `error: ${x.error.replace(/\|/g, "\\|")}` : x.status} | ${x.summary ? `${x.summary.breaking} breaking, ${x.summary.warning} warning` : "—"} |`);
      if (x.breaking) printDiff(ws.diff(x.endpointId));
    }
    const ok = r.failed === 0 && r.breaking === 0;
    const md = `## Apilot check — ${ok ? "✅ passed" : "❌ failed"}\n\n${r.passed} passed · ${r.failed} failed · ${r.breaking} breaking (env \`${r.env}\`)\n\n| | Endpoint | Status | Changes vs baseline |\n|---|---|---|---|\n${rows.join("\n")}\n`;
    if (opts.markdown) (existsSync(opts.markdown) ? appendFileSync : writeFileSync)(opts.markdown, md);
    console.log(ok ? "\n✅ All checks passed." : "\n❌ Checks failed — errors or breaking changes detected.");
    if (!ok) process.exitCode = 1;
  }));

program.parseAsync();
