#!/usr/bin/env node
/**
 * Apilot CLI — run endpoints, diff snapshots, and generate code from
 * the command line. Designed for CI pipelines and scriptable workflows.
 *
 * Usage:
 *   apilot run <endpoint-id> --env dev
 *   apilot run-all --env dev
 *   apilot diff <endpoint-id>
 *   apilot codegen <endpoint-id> --lang dart --out lib/api
 *   apilot check                       # CI: run all + diff (non-zero exit on failure)
 */

import { Command } from "commander";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  Registry,
  NodeFileResolver,
  resolveContext,
  RequestRunner,
  JsonSnapshotStore,
  Differ,
  inferSchema,
  parseEndpointFile,
  parseEnvironmentFile,
  Redactor,
} from "@apilot/core";

const program = new Command();
const SECRET_PREFIX = "apilot_secret_";

program
  .name("apilot")
  .description("API workspace CLI — run, diff, and generate code from endpoints.")
  .version("0.1.0");

function findProjectRoot(start?: string): string {
  let dir = start ?? process.cwd();
  while (dir !== "/" && !fs.existsSync(path.join(dir, ".apilot", "apilot.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function makeSnapshotStore(projectRoot: string): JsonSnapshotStore {
  return new JsonSnapshotStore({
    root: path.join(projectRoot, ".apilot"),
    retention: 20,
    writeFile: async (rel: string, content: string) => {
      const full = path.join(projectRoot, ".apilot", rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
    },
    readFile: async (rel: string) => {
      try { return fs.readFileSync(path.join(projectRoot, ".apilot", rel), "utf-8"); } catch { return undefined; }
    },
    listDir: async (rel: string) => {
      try { return fs.readdirSync(path.join(projectRoot, ".apilot", rel)); } catch { return []; }
    },
    deleteFile: async (rel: string) => {
      try { fs.unlinkSync(path.join(projectRoot, ".apilot", rel)); } catch {}
    },
    ensureDir: async (rel: string) => {
      fs.mkdirSync(path.join(projectRoot, ".apilot", rel), { recursive: true });
    },
  });
}

async function loadRunContext(projectRoot: string, envName: string) {
  const files = new NodeFileResolver(projectRoot);
  const registry = new Registry(files).build();

  const envEntry = registry.environments.find((e) => e.name === envName);
  if (!envEntry) {
    throw new Error(
      `Environment "${envName}" not found. Available: ${registry.environments.map((e) => e.name).join(", ")}`
    );
  }

  const envRaw = files.read(`.apilot/environments/${envName}.yaml`) ?? "";
  const env = parseEnvironmentFile(envRaw, envEntry.path);

  const variables: Record<string, string> = {};
  const secretValues: Record<string, string> = {};

  for (const [name, def] of Object.entries(env.variables ?? {})) {
    const d = def as any;
    if (d?.type === "secret") {
      const val = process.env[`${SECRET_PREFIX}${name}`] ?? process.env[`${name}`];
      if (val) secretValues[name] = val;
      else console.warn(`⚠  Missing secret: ${name} (set ${SECRET_PREFIX}${name} or ${name})`);
    } else if (d?.value !== undefined) {
      variables[name] = String(d.value);
    }
  }

  const ctx = await resolveContext(env, {
    resolve: async (secretName: string) => secretValues[secretName] ?? "",
  });
  (ctx as any)._secretValues = secretValues;

  return { files, registry, env, ctx, secretValues };
}

// --- run <endpointId> ---

program
  .command("run <endpointId>")
  .description("Run a single endpoint")
  .option("-e, --env <name>", "Environment name", "dev")
  .option("--dry-run", "Resolve and print the request without executing it")
  .action(async (endpointId: string, opts: { env: string; dryRun: boolean }) => {
    const projectRoot = findProjectRoot();
    const { registry, ctx, secretValues } = await loadRunContext(projectRoot, opts.env);

    const ep = registry.endpoints.find((e) => e.id === endpointId);
    if (!ep) {
      console.error(`Endpoint "${endpointId}" not found.`);
      process.exit(1);
    }

    const files = new NodeFileResolver(projectRoot);
    const epRaw = files.read(ep.file) ?? "";
    const endpoint = parseEndpointFile(epRaw, ep.file);

    const runner = new RequestRunner();
    const request = runner.resolve(endpoint, ctx);

    if (opts.dryRun) {
      console.log("Method:", request.method);
      console.log("URL:", request.url);
      console.log("Headers:", JSON.stringify(request.headers, null, 2));
      if (request.body) console.log("Body:", request.body);
      return;
    }

    const snapshot = await runner.run(request, ctx, endpointId);
    const redactor = new Redactor({ secretValues });

    console.log(`\n${ep.name} — ${request.method} ${request.url}`);
    console.log("Status:", snapshot.status, snapshot.passed ? "✓" : "✗");
    console.log("Duration:", snapshot.timeMs, "ms");
    console.log("Response:", JSON.stringify(redactor.redactObject(snapshot.body), null, 2));

    const store = makeSnapshotStore(projectRoot);
    await store.save(snapshot, { secretValues });
  });

// --- run-all ---

program
  .command("run-all")
  .description("Run all endpoints")
  .option("-e, --env <name>", "Environment name", "dev")
  .action(async (opts: { env: string }) => {
    const projectRoot = findProjectRoot();
    const { registry, ctx, secretValues } = await loadRunContext(projectRoot, opts.env);

    const runner = new RequestRunner();
    let passed = 0;
    let failed = 0;
    const store = makeSnapshotStore(projectRoot);

    for (const ep of registry.endpoints) {
      try {
        const files = new NodeFileResolver(projectRoot);
        const epRaw = files.read(ep.file);
        if (!epRaw) throw new Error(`Cannot read: ${ep.file}`);
        const endpoint = parseEndpointFile(epRaw, ep.file);
        const request = runner.resolve(endpoint, ctx);
        const snapshot = await runner.run(request, ctx, ep.id);

        const ok = snapshot.status >= 200 && snapshot.status < 400;
        console.log(`  ${ok ? "✓" : "✗"} ${ep.id} — ${snapshot.status}`);
        if (ok) passed++;
        else failed++;

        await store.save(snapshot, { secretValues });
      } catch (err) {
        failed++;
        console.log(`  ✗ ${ep.id} — ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`\n${passed} passed, ${failed} failed out of ${registry.endpoints.length}`);
    if (failed > 0) process.exit(1);
  });

// --- diff <endpointId> ---

program
  .command("diff <endpointId>")
  .description("Diff the two most recent snapshots for an endpoint")
  .action(async (endpointId: string) => {
    const projectRoot = findProjectRoot();
    const store = makeSnapshotStore(projectRoot);

    const snaps = await store.list(endpointId);
    if (snaps.length < 2) {
      console.error("Need at least 2 snapshots to diff. Run the endpoint twice.");
      process.exit(1);
    }

    const from = await store.load(snaps[snaps.length - 1]!.id);
    const to = await store.load(snaps[0]!.id);
    if (!from || !to) {
      console.error("Failed to load snapshots.");
      process.exit(1);
    }

    const differ = new Differ();
    const diff = differ.diff({ endpointId, from, to });

    console.log(`\nDiff: ${endpointId}`);
    console.log(`  ${diff.summary.breaking} breaking, ${diff.summary.warning} warnings, ${diff.summary.nonBreaking} non-breaking`);
    for (const change of diff.changes) {
      const icon = change.level === "breaking" ? "✗" : change.level === "warning" ? "⚠" : "✓";
      console.log(`  ${icon} ${change.path} — ${change.description}`);
    }
    if (diff.summary.breaking > 0) process.exit(2);
  });

// --- codegen <endpointId> ---

program
  .command("codegen <endpointId>")
  .description("Generate code for an endpoint")
  .option("-l, --lang <language>", "Target language: dart|typescript|kotlin|swift", "dart")
  .option("-o, --out <dir>", "Output directory")
  .action(async (endpointId: string, opts: { lang: string; out?: string }) => {
    const projectRoot = findProjectRoot();
    const files = new NodeFileResolver(projectRoot);
    const registry = new Registry(files).build();

    const ep = registry.endpoints.find((e) => e.id === endpointId);
    if (!ep) {
      console.error(`Endpoint "${endpointId}" not found.`);
      process.exit(1);
    }

    const store = makeSnapshotStore(projectRoot);
    const snap = await store.latest(endpointId);
    if (!snap) {
      console.error("No snapshot available. Run the endpoint first.");
      process.exit(1);
    }

    const schema = inferSchema(snap.body);
    const outDir = opts.out ?? path.join(projectRoot, ".apilot", "generated", ep.id.replace(/\./g, "/"));
    console.log(`Generating ${opts.lang} code for ${endpointId} → ${outDir}`);

    const fileName = ep.id.replace(/\./g, "_");
    const modelName = fileName.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace(/^([a-z])/, (_, c) => c.toUpperCase());

    // Include schema info in generated comments
    const schemaComment = `// Inferred schema: ${JSON.stringify(schema, null, 2)}`;

    if (opts.lang === "dart") {
      const code = `// Generated by Apilot. Do not edit by hand.\n// Endpoint: ${ep.name} (${ep.method} ${ep.url})\n${schemaComment}\n\nclass ${modelName} {\n  // TODO: Add fields based on inferred schema\n}\n`;
      const fullPath = path.join(outDir, `${fileName}.dart`);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, code, "utf-8");
      console.log(`Wrote ${fullPath}`);
    } else if (opts.lang === "typescript") {
      const code = `// Generated by Apilot. Do not edit by hand.\n// Endpoint: ${ep.name}\n${schemaComment}\n\nexport interface ${modelName} {\n  // TODO: Add fields based on inferred schema\n}\n`;
      const fullPath = path.join(outDir, `${fileName}.ts`);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, code, "utf-8");
      console.log(`Wrote ${fullPath}`);
    } else {
      console.error(`Unsupported language: ${opts.lang}. Use --lang dart|typescript|kotlin|swift`);
      process.exit(1);
    }
  });

// --- check (CI mode) ---

program
  .command("check")
  .description("CI mode: run all endpoints and check for breaking diffs")
  .option("-e, --env <name>", "Environment name", "dev")
  .action(async (opts: { env: string }) => {
    const projectRoot = findProjectRoot();
    const { registry, ctx, secretValues } = await loadRunContext(projectRoot, opts.env);

    const runner = new RequestRunner();
    let allPassed = true;
    const store = makeSnapshotStore(projectRoot);

    console.log("Running all endpoints...");
    for (const ep of registry.endpoints) {
      try {
        const files = new NodeFileResolver(projectRoot);
        const epRaw = files.read(ep.file);
        if (!epRaw) throw new Error(`Cannot read: ${ep.file}`);
        const endpoint = parseEndpointFile(epRaw, ep.file);
        const request = runner.resolve(endpoint, ctx);
        const snapshot = await runner.run(request, ctx, ep.id);

        const ok = snapshot.status >= 200 && snapshot.status < 400;
        console.log(`  ${ok ? "✓" : "✗"} ${ep.id} — ${snapshot.status}`);
        if (!ok) allPassed = false;

        await store.save(snapshot, { secretValues });

        // Diff if we have previous snapshots
        const snaps = await store.list(ep.id);
        if (snaps.length >= 2) {
          const from = await store.load(snaps[snaps.length - 1]!.id);
          const to = await store.load(snaps[0]!.id);
          if (from && to) {
            const differ = new Differ();
            const diff = differ.diff({ endpointId: ep.id, from, to });
            if (diff.summary.breaking > 0) {
              console.log(`    ⚠ ${diff.summary.breaking} breaking changes!`);
              allPassed = false;
            }
          }
        }
      } catch (err) {
        allPassed = false;
        console.log(`  ✗ ${ep.id} — ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!allPassed) {
      console.error("\n❌ Checks failed — breaking changes or errors detected.");
      process.exit(1);
    }
    console.log("\n✅ All checks passed.");
  });

program.parse();
