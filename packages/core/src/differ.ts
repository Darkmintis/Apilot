/**
 * Structural diff engine.
 *
 * Compares the inferred schemas of two responses and classifies every change
 * as breaking, warning, non-breaking, or info (master plan §7.4). Working on
 * schemas rather than raw values means every array item is considered and
 * value-only changes (a different name, a new id) never raise an alarm.
 */

import type {
  ApilotSchema,
  BreakingLevel,
  ChangeKind,
  DiffChange,
  DiffResult,
  SnapshotRedacted,
} from "./types.js";
import { inferSchema } from "./schema.js";

export interface DiffOptions {
  endpointId: string;
  from: SnapshotRedacted;
  to: SnapshotRedacted;
  /** Pre-merged schemas (e.g. learned from many samples). Inferred from the bodies when omitted. */
  fromSchema?: ApilotSchema;
  toSchema?: ApilotSchema;
}

export type DiffClassifier = (kind: ChangeKind) => BreakingLevel;

const DEFAULT_LEVELS: Record<ChangeKind, BreakingLevel> = {
  fieldRemoved: "breaking",
  fieldTypeChanged: "breaking",
  nonNullableToNullable: "breaking",
  enumValueRemoved: "info",
  statusChanged: "breaking",
  errorShapeChanged: "breaking",
  renamed: "breaking",
  enumValueAdded: "warning",
  fieldAdded: "nonBreaking",
  nullableToNonNullable: "nonBreaking",
  unchanged: "info",
};

export class Differ {
  constructor(private readonly classify: DiffClassifier = (k) => DEFAULT_LEVELS[k]) {}

  diff(opts: DiffOptions): DiffResult {
    const changes: DiffChange[] = [];
    const push = (path: string, kind: ChangeKind, description: string, extra: Partial<DiffChange> = {}) =>
      changes.push({ path, kind, level: this.classify(kind), description, ...extra });

    if (opts.from.status !== opts.to.status) {
      push("@status", "statusChanged", `Status changed from ${opts.from.status} to ${opts.to.status}`,
        { fromValue: opts.from.status, toValue: opts.to.status });
    }

    // An error response has a different shape by nature; comparing it to a
    // success body would only produce noise on top of the status change.
    if (isOk(opts.from.status) === isOk(opts.to.status)) {
      const fromSchema = opts.fromSchema ?? inferSchema(opts.from.body);
      const toSchema = opts.toSchema ?? inferSchema(opts.to.body);
      compare(fromSchema, toSchema, "$", push);
    }

    const summary: Record<BreakingLevel, number> = { breaking: 0, warning: 0, nonBreaking: 0, info: 0 };
    for (const c of changes) summary[c.level]++;

    return {
      fromId: opts.from.id,
      toId: opts.to.id,
      endpointId: opts.endpointId,
      breaking: summary.breaking > 0,
      changes,
      summary,
    };
  }
}

type Push = (path: string, kind: ChangeKind, description: string, extra?: Partial<DiffChange>) => void;

function compare(from: ApilotSchema, to: ApilotSchema, path: string, push: Push): void {
  const fromType = from.type;
  const toType = to.type;

  // Nullability. A schema with no type was only ever seen as null.
  if (!from.nullable && to.nullable && fromType) {
    push(path, "nonNullableToNullable", `"${path}" can now be null.`, { fromValue: fromType, toValue: `${toType ?? fromType} | null` });
  } else if (from.nullable && !to.nullable && toType && fromType) {
    push(path, "nullableToNonNullable", `"${path}" is no longer null.`, { fromValue: `${fromType} | null`, toValue: toType });
  }
  if (!fromType || !toType) return;

  if (fromType !== toType) {
    if (fromType === "number" && toType === "integer") return; // ints are valid numbers
    push(path, "fieldTypeChanged", `"${path}" changed type from ${fromType} to ${toType}.`, { fromValue: fromType, toValue: toType });
    return;
  }

  if (fromType === "object") {
    const fp = from.properties ?? {};
    const tp = to.properties ?? {};
    const removed = Object.keys(fp).filter((k) => !(k in tp));
    const added = Object.keys(tp).filter((k) => !(k in fp));

    // ponytail: rename = exactly one removed + one added of the same type in the same object.
    // Upgrade path: compare sample values when snapshots carry them.
    if (removed.length === 1 && added.length === 1 && fp[removed[0]!]!.type === tp[added[0]!]!.type) {
      push(`${path}.${removed[0]}`, "renamed", `"${removed[0]}" was likely renamed to "${added[0]}".`,
        { fromValue: removed[0], toValue: added[0], confidence: 0.6 });
    } else {
      for (const k of removed) push(`${path}.${k}`, "fieldRemoved", `Field "${k}" was removed.`, { fromValue: fp[k]!.type });
      for (const k of added) push(`${path}.${k}`, "fieldAdded", `Field "${k}" was added.`, { toValue: tp[k]!.type });
    }

    for (const k of Object.keys(fp)) {
      if (!(k in tp)) continue;
      const childPath = `${path}.${k}`;
      const wasRequired = from.required.includes(k);
      const isRequired = to.required.includes(k);
      // Only report "became optional" when nullability didn't already explain it.
      if (wasRequired && !isRequired && !tp[k]!.nullable) {
        push(childPath, "nonNullableToNullable", `"${childPath}" is no longer always present.`);
      }
      compare(fp[k]!, tp[k]!, childPath, push);
    }
  } else if (fromType === "array") {
    if (from.items && to.items) compare(from.items, to.items, `${path}[]`, push);
  } else if (from.enum && to.enum) {
    for (const v of to.enum) if (!from.enum.includes(v)) push(path, "enumValueAdded", `New value ${JSON.stringify(v)} for "${path}".`, { toValue: v });
    for (const v of from.enum) if (!to.enum.includes(v)) push(path, "enumValueRemoved", `Value ${JSON.stringify(v)} for "${path}" was not seen in the newer response.`, { fromValue: v });
  }
}

function isOk(status: number): boolean {
  return status >= 200 && status < 400;
}
