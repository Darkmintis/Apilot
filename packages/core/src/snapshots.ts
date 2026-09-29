/**
 * Snapshot store.
 *
 * Layout: .apilot/snapshots/<endpointId>/<timestamp>.<id>.json
 *         .apilot/snapshots/<endpointId>/baseline   (contains the baseline snapshot id)
 *
 * Retention (master plan §7.3): keep the newest N plus the baseline.
 * Everything is redacted before it touches disk.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SnapshotMeta, SnapshotRaw, SnapshotRedacted } from "./types.js";
import { Redactor } from "./redaction.js";

export class SnapshotStore {
  constructor(
    /** absolute path of the .apilot folder */
    private readonly apilotDir: string,
    private readonly retention = 20
  ) {}

  dir(endpointId: string): string {
    return join(this.apilotDir, "snapshots", ...endpointId.split("/"));
  }

  /** Redact and persist a run. Returns the stored (redacted) snapshot. */
  save(raw: SnapshotRaw, secretValues: Record<string, string>, revision?: number): SnapshotRedacted {
    const r = new Redactor({ secretValues });
    const redacted: SnapshotRedacted = {
      id: raw.id,
      endpointId: raw.endpointId,
      timestamp: raw.timestamp,
      revision,
      request: {
        method: raw.request.method,
        url: r.redactString(raw.request.url),
        headers: r.redactHeaders(raw.request.headers),
        body: raw.request.body === null ? null : r.redactString(raw.request.body),
      },
      status: raw.status,
      headers: r.redactHeaders(raw.headers),
      body: r.redactObject(raw.body),
      timeMs: raw.timeMs,
      size: raw.size,
      passed: raw.passed,
      failures: raw.failures,
    };

    const dir = this.dir(raw.endpointId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${raw.timestamp.replace(/[:.]/g, "-")}.${raw.id}.json`), JSON.stringify(redacted, null, 2) + "\n");
    this.applyRetention(raw.endpointId);
    return redacted;
  }

  /** Newest first. */
  list(endpointId: string): SnapshotMeta[] {
    const baseline = this.baselineId(endpointId);
    return this.files(endpointId)
      .map(({ file }) => {
        const s = JSON.parse(readFileSync(file, "utf-8")) as SnapshotRedacted;
        return {
          id: s.id,
          endpointId: s.endpointId,
          timestamp: s.timestamp,
          status: s.status,
          size: s.size,
          timeMs: s.timeMs,
          passed: s.passed,
          revision: s.revision,
          baseline: s.id === baseline,
        };
      });
  }

  load(endpointId: string, id: string): SnapshotRedacted | undefined {
    const file = this.path(endpointId, id);
    return file ? (JSON.parse(readFileSync(file, "utf-8")) as SnapshotRedacted) : undefined;
  }

  /** Absolute file path of a snapshot (used for the editor's native diff). */
  path(endpointId: string, id: string): string | undefined {
    return this.files(endpointId).find((f) => f.id === id)?.file;
  }

  latest(endpointId: string): SnapshotRedacted | undefined {
    const first = this.files(endpointId)[0];
    return first ? this.load(endpointId, first.id) : undefined;
  }

  all(endpointId: string): SnapshotRedacted[] {
    return this.files(endpointId).map(({ file }) => JSON.parse(readFileSync(file, "utf-8")) as SnapshotRedacted);
  }

  baselineId(endpointId: string): string | undefined {
    try {
      const id = readFileSync(join(this.dir(endpointId), "baseline"), "utf-8").trim();
      return this.path(endpointId, id) ? id : undefined;
    } catch {
      return undefined;
    }
  }

  baseline(endpointId: string): SnapshotRedacted | undefined {
    const id = this.baselineId(endpointId);
    return id ? this.load(endpointId, id) : undefined;
  }

  setBaseline(endpointId: string, id: string): void {
    if (!this.path(endpointId, id)) throw new Error(`Snapshot "${id}" not found for ${endpointId}`);
    writeFileSync(join(this.dir(endpointId), "baseline"), id + "\n");
  }

  delete(endpointId: string, id: string): void {
    const file = this.path(endpointId, id);
    if (file) unlinkSync(file);
    if (this.baselineId(endpointId) === undefined) rmSync(join(this.dir(endpointId), "baseline"), { force: true });
  }

  private files(endpointId: string): { id: string; file: string }[] {
    const dir = this.dir(endpointId);
    if (!existsSync(dir)) return [];
    // File names start with the ISO timestamp, so a reverse sort is newest first.
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f) => ({ id: f.slice(f.indexOf(".") + 1, -".json".length), file: join(dir, f) }));
  }

  private applyRetention(endpointId: string): void {
    const baseline = this.baselineId(endpointId);
    const extra = this.files(endpointId).filter((f) => f.id !== baseline).slice(this.retention);
    for (const f of extra) unlinkSync(f.file);
  }
}
