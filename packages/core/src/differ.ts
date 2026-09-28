/**
 * Structural diff engine.
 *
 * Compares two JSON snapshots and classifies changes as breaking, warning,
 * non-breaking, or info, per the rules in master-plan §7.4.
 *
 * Classification is based on JSON-Schema types inferred from the snapshots.
 */

import type {
  ApilotSchema,
  BreakingLevel,
  DiffChange,
  DiffResult,
  SnapshotRedacted,
} from "./types.js";
import { inferSchema } from "./schema.js";

export interface DiffOptions {
  endpointId: string;
  from: SnapshotRedacted;
  to: SnapshotRedacted;
}

export type DiffClassifier = (change: DiffChange, ctx: {
  fromType: string | undefined;
  toType: string | undefined;
}) => BreakingLevel;

const DEFAULT_CLASSIFIER: DiffClassifier = (change, _ctx) => {
  switch (change.kind) {
    case "fieldRemoved":
      return "breaking";
    case "fieldTypeChanged": {
      // Type change is always breaking regardless of nullability
      return "breaking";
    }
    case "fieldAdded":
      return "nonBreaking";
    case "enumValueRemoved":
      return "breaking";
    case "enumValueAdded":
      return "warning";
    case "statusChanged":
      return "breaking";
    case "errorShapeChanged":
      return "breaking";
    case "nonNullableToNullable":
      return "nonBreaking";
    case "nullableToNonNullable":
      return "breaking";
    case "renamed":
      return "breaking";
    default:
      return "info";
  }
};

export class Differ {
  constructor(private readonly classify: DiffClassifier = DEFAULT_CLASSIFIER) {}

  diff(opts: DiffOptions): DiffResult {
    const endpointId = opts.endpointId;
    const fromBody = opts.from.body;
    const toBody = opts.to.body;

    const fromSchema =
      typeof fromBody === "object" && fromBody !== null
        ? inferSchema(fromBody)
        : undefined;
    const toSchema =
      typeof toBody === "object" && toBody !== null
        ? inferSchema(toBody)
        : undefined;

    const changes: DiffChange[] = [];

    // Status code
    if (opts.from.status !== opts.to.status) {
      changes.push({
        path: "@status",
        kind: "statusChanged",
        level: this.classify(
          { path: "@status", kind: "statusChanged", level: "breaking", description: "" },
          { fromType: undefined, toType: undefined }
        ),
        fromValue: opts.from.status,
        toValue: opts.to.status,
        description: `Status changed from ${opts.from.status} to ${opts.to.status}`,
      });
    }

    // Body diff
    if (fromBody !== null && toBody !== null) {
      this._diffValues(
        fromBody,
        toBody,
        "$",
        fromSchema,
        toSchema,
        changes,
        opts
      );
    } else if (fromBody === null && toBody !== null) {
      changes.push({
        path: "$.body",
        kind: "fieldAdded",
        level: "nonBreaking",
        description: "Response body went from null/empty to an object.",
      });
    } else if (fromBody !== null && toBody === null) {
      changes.push({
        path: "$.body",
        kind: "fieldRemoved",
        level: "breaking",
        description: "Response body was removed.",
      });
    }

    const summary: Record<BreakingLevel, number> = {
      breaking: 0,
      warning: 0,
      nonBreaking: 0,
      info: 0,
    };
    for (const c of changes) {
      summary[c.level] = (summary[c.level] ?? 0) + 1;
    }

    const breaking = summary.breaking > 0 || summary.warning > 0;

    return {
      fromId: opts.from.id,
      toId: opts.to.id,
      endpointId,
      breaking,
      changes,
      summary,
    };
  }

  private _diffValues(
    fromVal: unknown,
    toVal: unknown,
    path: string,
    fromSchema: ApilotSchema | undefined,
    toSchema: ApilotSchema | undefined,
    changes: DiffChange[],
    opts: DiffOptions
  ): void {
    const fromType = typeOf(fromVal);
    const toType = typeOf(toVal);

    // Handle null transitions explicitly (nullability changes)
    if (fromVal === null && toVal !== null) {
      changes.push({
        path,
        kind: "nullableToNonNullable",
        level: this.classify(
          { path, kind: "nullableToNonNullable", level: "breaking", description: "" },
          { fromType, toType }
        ),
        fromValue: fromVal,
        toValue: toVal,
        description: `Field "${path}" became non-nullable (was null, now non-null).`,
      });
      return;
    }
    if (fromVal !== null && toVal === null) {
      changes.push({
        path,
        kind: "nonNullableToNullable",
        level: this.classify(
          { path, kind: "nonNullableToNullable", level: "nonBreaking", description: "" },
          { fromType, toType }
        ),
        fromValue: fromVal,
        toValue: toVal,
        description: `Field "${path}" became nullable (was non-null, now null).`,
      });
      return;
    }

    if (fromType !== toType) {
      // Could be a rename (detected by matching type + position + value)
      if (this._isRename(fromVal, toVal, opts)) {
        changes.push({
          path,
          kind: "renamed",
          level: "breaking",
          fromValue: fromVal,
          toValue: toVal,
          confidence: this._renameConfidence(fromVal, toVal),
          description: `Field "${path}" was likely renamed.`,
        });
        return;
      }

      changes.push({
        path,
        kind: "fieldTypeChanged",
        level: this.classify(
          { path, kind: "fieldTypeChanged", level: "breaking", description: "" },
          { fromType, toType }
        ),
        fromValue: fromVal,
        toValue: toVal,
        description: `Type changed from ${fromType} to ${toType}`,
      });
      return;
    }

    if (fromType === "object" && fromType === "object") {
      const fromObj = fromVal as Record<string, unknown>;
      const toObj = toVal as Record<string, unknown>;
      const allKeys = new Set([...Object.keys(fromObj), ...Object.keys(toObj)]);

      for (const key of allKeys) {
        const childPath = `${path}.${key}`;
        const childFrom = fromObj[key];
        const childTo = toObj[key];
        const childFromSchema = (fromSchema?.properties?.[key]) ??
          (fromSchema ? inferSchema(childFrom) : undefined);
        const childToSchema = (toSchema?.properties?.[key]) ??
          (toSchema ? inferSchema(childTo) : undefined);

        if (childFrom === undefined) {
          // field added
          const nullable = childTo === null;
          changes.push({
            path: childPath,
            kind: "fieldAdded",
            level: nullable ? "info" : "nonBreaking",
            toValue: childTo,
            description: `Field "${key}" was added${nullable ? " (nullable)" : ""}.`,
          });
        } else if (childTo === undefined) {
          // field removed
          changes.push({
            path: childPath,
            kind: "fieldRemoved",
            level: "breaking",
            fromValue: childFrom,
            description: `Field "${key}" was removed.`,
          });
        } else {
          this._diffValues(
            childFrom,
            childTo,
            childPath,
            childFromSchema,
            childToSchema,
            changes,
            opts
          );
        }
      }
    } else if (fromType === "array") {
      // Compare array element schemas (first element is representative)
      const fromArr = fromVal as unknown[];
      const toArr = toVal as unknown[];
      const fromElem = fromArr[0];
      const toElem = toArr[0];

      if (fromElem !== undefined && toElem !== undefined) {
        this._diffValues(
          fromElem,
          toElem,
          `${path}[0]`,
          fromSchema?.items,
          toSchema?.items,
          changes,
          opts
        );
      }
    }

    // Enum detection: if values are constrained to a known set, detect
    // added/removed enum values
    this._checkEnumChanges(fromVal, toVal, path, changes);
  }

  /**
   * Rename detection: a field was "renamed" if the type+position+value match
   * but the key changed. We approximate by checking if the from-value's content
   * appears under a different key in the to-schema.
   */
  private _isRename(
    fromVal: unknown,
    toVal: unknown,
    _opts: DiffOptions
  ): boolean {
    if (typeof fromVal !== "object" || typeof toVal !== "object") {
      return false;
    }

    const fromObj = fromVal as Record<string, unknown>;
    const toObj = toVal as Record<string, unknown>;

    const fromKeys = Object.keys(fromObj);
    const toKeys = Object.keys(toObj);

    if (fromKeys.length !== toKeys.length) return false;

    // Check if values are structurally similar (same types, same positions)
    for (let i = 0; i < fromKeys.length; i++) {
      const fv = fromObj[fromKeys[i]!];
      const tv = toObj[toKeys[i]!];
      if (typeOf(fv) !== typeOf(tv)) return false;
    }

    return true;
  }

  private _renameConfidence(_from: unknown, _to: unknown): number {
    // Heuristic: type-match + same position = high confidence
    return 0.85;
  }

  /**
   * Detect enum value additions/removals when both values are primitives
   * that appear to be from a constrained set.
   * This is a lightweight heuristic; the schema engine does the real work.
   */
  private _checkEnumChanges(
    fromVal: unknown,
    toVal: unknown,
    path: string,
    changes: DiffChange[]
  ): void {
    // For now, enum detection is schema-level (see schema.ts)
    // This hook exists for future value-based enum detection
    void { fromVal, toVal, path, changes };
  }
}

function typeOf(val: unknown): string {
  if (val === null) return "null";
  if (Array.isArray(val)) return "array";
  return typeof val;
}
