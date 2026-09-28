/**
 * Schema inference engine.
 *
 * Builds a simplified JSON-Schema-like structure from a sample response.
 * Merges across multiple samples to learn optional/nullable fields.
 *
 * Per spec §7.3: "Multiple samples per endpoint to learn optional/
 * nullable fields."
 */

import type { ApilotSchema } from "./types.js";

export class SchemaBuilder {
  /**
   * Infer a schema from one or more sample values.
   * Samples can be null/undefined to indicate nullability.
   */
  infer(samples: unknown[]): ApilotSchema {
    const validSamples = samples.filter(
      (s) => s !== undefined
    );

    if (validSamples.length === 0) {
      return { required: [], nullable: true };
    }

    // Track nullability across samples
    const hasNull = validSamples.some((s) => s === null);
    const nonNull = validSamples.filter((s) => s !== null);

    if (nonNull.length === 0) {
      return { required: [], nullable: true };
    }

    // If all non-null samples share the same type, infer it
    const types = new Set(nonNull.map(typeOf));

    if (types.size === 1) {
      const t = types.values().next().value as string;

      switch (t) {
        case "object": {
          return this._inferObject(nonNull as object[], hasNull);
        }
        case "array": {
          return this._inferArray(nonNull as unknown[][], hasNull);
        }
        case "string": {
          const schema: ApilotSchema = {
            type: "string",
            required: [],
            nullable: hasNull,
          };
          // Enum detection
          const vals = new Set(nonNull as string[]);
          if (vals.size <= 20 && nonNull.length >= 3) {
            schema.enum = [...vals];
          }
          return schema;
        }
        case "number":
        case "integer":
        case "boolean": {
          return {
            type: t as ApilotSchema["type"],
            required: [],
            nullable: hasNull,
          };
        }
        default:
          return { required: [], nullable: hasNull };
      }
    }

    // Mixed types
    return {
      required: [],
      nullable: hasNull,
      description: "Mixed type — needs manual review",
    };
  }

  private _inferObject(
    samples: object[],
    hasNull: boolean
  ): ApilotSchema {
    const allKeys = new Set<string>();
    for (const s of samples) {
      for (const k of Object.keys(s)) {
        allKeys.add(k);
      }
    }

    const properties: Record<string, ApilotSchema> = {};
    const required: string[] = [];

    for (const key of allKeys) {
      const valuesForKey = samples
        .map((s) => (s as Record<string, unknown>)[key])
        .filter((v) => v !== undefined);

      // Required = present (non-undefined) AND non-null in ALL samples
      const presentInAll = valuesForKey.length === samples.length;
      const neverNull = valuesForKey.every((v) => v !== null);
      if (presentInAll && neverNull) {
        required.push(key);
      }

      const subSamples = valuesForKey.filter((v) => v !== undefined);
      properties[key] = this.infer(subSamples);
      properties[key].nullable = valuesForKey.some((v) => v === null);
    }

    return {
      type: "object",
      properties,
      required,
      nullable: hasNull,
    };
  }

  private _inferArray(
    samples: unknown[][],
    hasNull: boolean
  ): ApilotSchema {
    const items: unknown[] = [];
    for (const arr of samples) {
      for (const item of arr) {
        items.push(item);
      }
    }

    return {
      type: "array",
      items: items.length > 0 ? this.infer(items) : undefined,
      required: [],
      nullable: hasNull,
    };
  }
}

/** Convenience: infer a schema from a single value. */
export function inferSchema(value: unknown): ApilotSchema {
  return new SchemaBuilder().infer([value]);
}

/** Merge two schemas (used for diff classification). */
export function mergeSchemas(a: ApilotSchema, b: ApilotSchema): ApilotSchema {
  // For now, return a simple merge — the differ handles the real comparison
  return {
    ...a,
    nullable: a.nullable || b.nullable,
    required: [...new Set([...a.required, ...b.required])],
    properties: { ...a.properties, ...b.properties },
  };
}

export function schemaToJsonSchema(schema: ApilotSchema): object {
  const result: Record<string, unknown> = {
    type: schema.type ?? "object",
    nullable: schema.nullable,
  };
  if (schema.properties) {
    result.properties = {};
    const props = result.properties as Record<string, unknown>;
    for (const [key, val] of Object.entries(schema.properties)) {
      props[key] = schemaToJsonSchema(val);
    }
    result.required = schema.required;
  }
  if (schema.items) {
    result.items = schemaToJsonSchema(schema.items);
  }
  if (schema.enum) {
    result.enum = schema.enum;
  }
  if (schema.description) {
    result.description = schema.description;
  }
  return result;
}

function typeOf(val: unknown): string {
  if (val === null) return "null";
  if (Array.isArray(val)) return "array";
  return typeof val;
}
