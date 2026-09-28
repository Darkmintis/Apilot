/**
 * Snapshot manager.
 *
 * Stores redacted snapshots under .apilot/snapshots/<endpointId>/<iso-timestamp>.json
 *
 * Retention policy (from spec 7.3):
 *  - keep the last N (default 20)
 *  - always keep "baseline" snapshots
 *
 * All snapshots are redacted before writing.
 */

import type {
  SnapshotMeta,
  SnapshotRaw,
  SnapshotRedacted,
} from "./types.js";
import { Redactor, type RedactionOptions } from "./redaction.js";

export interface SnapshotStore {
  /** Persist a snapshot (redacted). */
  save(raw: SnapshotRaw, opts: RedactionOptions): Promise<SnapshotMeta>;
  /** Load a snapshot by id. */
  load(id: string): Promise<SnapshotRedacted | undefined>;
  /** List snapshots for an endpoint, newest first. */
  list(endpointId: string): Promise<SnapshotMeta[]>;
  /** Get the latest snapshot for an endpoint. */
  latest(endpointId: string): Promise<SnapshotRedacted | undefined>;
  /** Get a baseline snapshot (manually or latest). */
  baseline(endpointId: string): Promise<SnapshotRedacted | undefined>;
  /** Delete a snapshot. */
  delete(id: string): Promise<void>;
}

export interface SnapshotStoreConfig {
  /** root directory (the .apilot folder path) */
  root: string;
  /** max snapshots to keep per endpoint (non-baseline). default 20 */
  retention: number;
  /** write function — injected so core stays fs-agnostic for testing */
  writeFile: (relPath: string, content: string) => Promise<void>;
  readFile: (relPath: string) => Promise<string | undefined>;
  listDir: (relPath: string) => Promise<string[]>;
  deleteFile: (relPath: string) => Promise<void>;
  ensureDir: (relPath: string) => Promise<void>;
}

export class JsonSnapshotStore implements SnapshotStore {
  private readonly cfg: SnapshotStoreConfig;

  constructor(cfg: SnapshotStoreConfig) {
    this.cfg = { ...cfg, retention: cfg.retention ?? 20 };
  }

  async save(
    raw: SnapshotRaw,
    opts: RedactionOptions
  ): Promise<SnapshotMeta> {
    const redactor = new Redactor(opts);
    const redacted: SnapshotRedacted = {
      id: raw.id,
      endpointId: raw.endpointId,
      timestamp: raw.timestamp,
      request: {
        method: raw.request.method,
        url: redactor.redactString(raw.request.url),
        headers: redactor.redactHeaders(raw.request.headers),
        body: redactor.redactString(
          raw.request.body ?? ""
        ),
      },
      status: raw.status,
      headers: redactor.redactHeaders(raw.headers),
      body: redactor.redactObject(raw.body),
      timeMs: raw.timeMs,
      size: raw.size,
      passed: raw.passed,
      failures: raw.failures,
    };

    const safeTs = raw.timestamp.replace(/[:.]/g, "-");
    const relDir = `snapshots/${raw.endpointId}`;
    const relFile = `${relDir}/${safeTs}.${raw.id}.json`;

    await this.cfg.ensureDir(relDir);
    await this.cfg.writeFile(
      relFile,
      JSON.stringify(redacted, null, 2)
    );

    // Apply retention
    await this._applyRetention(raw.endpointId, raw.id);

    // Clear secret values from the raw snapshot (defence in depth)
    delete raw._secretValues;

    return {
      id: raw.id,
      endpointId: raw.endpointId,
      timestamp: raw.timestamp,
      status: raw.status,
      size: raw.size,
      passed: raw.passed,
    };
  }

  async load(id: string): Promise<SnapshotRedacted | undefined> {
    // Scan all endpoint snapshot dirs to find the id
    const endpointDirs = await this._listSnapshotDirs();
    for (const dir of endpointDirs) {
      const files = await this.cfg.listDir(`snapshots/${dir}`);
      for (const f of files) {
        if (f.endsWith(`.${id}.json`)) {
          const content = await this.cfg.readFile(
            `snapshots/${dir}/${f}`
          );
          if (content) {
            return JSON.parse(content) as SnapshotRedacted;
          }
        }
      }
    }
    return undefined;
  }

  async list(endpointId: string): Promise<SnapshotMeta[]> {
    const files = await this.cfg.listDir(`snapshots/${endpointId}`);
    const metas: SnapshotMeta[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const content = await this.cfg.readFile(
        `snapshots/${endpointId}/${f}`
      );
      if (!content) continue;
      const snap = JSON.parse(content) as SnapshotRedacted;
      metas.push({
        id: snap.id,
        endpointId: snap.endpointId,
        timestamp: snap.timestamp,
        status: snap.status,
        size: snap.size,
        passed: snap.passed,
      });
    }
    return metas.sort(
      (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
    );
  }

  async latest(endpointId: string): Promise<SnapshotRedacted | undefined> {
    const list = await this.list(endpointId);
    if (list.length === 0) return undefined;
    return this.load(list[0]!.id);
  }

  async baseline(endpointId: string): Promise<SnapshotRedacted | undefined> {
    const list = await this.list(endpointId);
    // A baseline is marked by filename suffix `.baseline.json`
    // For now, fall back to latest if no explicit baseline
    const baselineFile = list.find(
      (m) => m.id.endsWith(".baseline") || m.timestamp.endsWith("T00-00-00")
    );
    return baselineFile ? this.load(baselineFile.id) : this.latest(endpointId);
  }

  async delete(id: string): Promise<void> {
    const endpointDirs = await this._listSnapshotDirs();
    for (const dir of endpointDirs) {
      const files = await this.cfg.listDir(`snapshots/${dir}`);
      for (const f of files) {
        if (f.endsWith(`.${id}.json`)) {
          await this.cfg.deleteFile(`snapshots/${dir}/${f}`);
          return;
        }
      }
    }
  }

  private async _listSnapshotDirs(): Promise<string[]> {
    try {
      return await this.cfg.listDir("snapshots");
    } catch {
      return [];
    }
  }

  private async _applyRetention(
    endpointId: string,
    currentId: string
  ): Promise<void> {
    const list = await this.list(endpointId);
    // Keep baselines + current
    const nonBaseline = list.filter(
      (m) => m.id !== currentId && !m.id.endsWith(".baseline")
    );
    const toDelete = nonBaseline.slice(this.cfg.retention);
    for (const meta of toDelete) {
      await this.delete(meta.id);
    }
  }
}
