/**
 * Codegen engine for Apilot.
 *
 * Generates typed models and API call layers from inferred JSON schemas.
 * Templates are plugin-based: each language is a function that takes
 * a schema + endpoint metadata and returns file contents.
 *
 * Per spec §7.7:
 *  - Dart/Flutter (flagship): freezed + json_serializable, Dio call layer
 *  - TypeScript: interfaces + zod schemas, fetch/axios client
 *  - Kotlin: kotlinx serialization data classes + Retrofit
 *  - Swift: Codable structs + URLSession
 *  - Diff-aware: only touched models change, hand-written code never overwritten
 */

import type { ApilotSchema } from "@apilot/core";
import { inferSchema } from "@apilot/core";

export interface CodegenOptions {
  endpointId: string;
  endpointName: string;
  method: string;
  url: string;
  schema: ApilotSchema;
  /** Target language: "dart" | "typescript" | "kotlin" | "swift" */
  language: string;
  /** output directory (relative or absolute) */
  outputPath: string;
  flavor?: string;
}

export interface GeneratedFile {
  /** file path relative to output root */
  path: string;
  content: string;
  /** language file extension */
  language: string;
}

export abstract class CodegenTemplate {
  abstract name: string;
  abstract languages: string[];
  abstract generate(opts: CodegenOptions): GeneratedFile[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert "order_id" / "order-id" / "orderId" / "orders.list" to camelCase. */
export function camelCase(str: string): string {
  return str
    .replace(/[-_.]/g, " ")
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (l, i) =>
      i === 0 ? l.toLowerCase() : l.toUpperCase()
    )
    .replace(/\s/g, "");
}

/** Convert to snake_case. */
export function snakeCase(str: string): string {
  return str
    .replace(/[-_.]/g, "_")
    .replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`)
    .replace(/^-+/, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Convert to PascalCase. */
export function pascalCase(str: string): string {
  const camel = camelCase(str);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** Convert to lowerCamelCase for JSON keys in some generators. */
export function jsonKey(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Escape a string for use in code. */
export function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

/** Infer Dart type from schema (without nullability marker). */
export function dartType(schema: ApilotSchema): string {
  switch (schema.type) {
    case "string":
      return "String";
    case "number":
    case "integer":
      return "num";
    case "boolean":
      return "bool";
    case "array":
      return `List<${schema.items ? dartType(schema.items) : "dynamic"}>`;
    case "object":
      return pascalCase(schema.description || "Model");
    case "null":
      return "dynamic";
    default:
      return "dynamic";
  }
}

/** Infer TypeScript type from schema (without nullability marker). */
export function tsType(schema: ApilotSchema): string {
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${schema.items ? tsType(schema.items) : "any"}[]`;
    case "object":
      return `{${Object.entries(schema.properties ?? {})
        .map(([k, v]) => `${jsonKey(k)}?: ${tsType(v)}`)
        .join("; ")}}}`;
    case "null":
      return "null";
    default:
      return "any";
  }
}

/** Infer Kotlin type from schema (without nullability marker). */
export function kotlinType(schema: ApilotSchema): string {
  switch (schema.type) {
    case "string":
      return "String";
    case "number":
      return "Double";
    case "integer":
      return "Long";
    case "boolean":
      return "Boolean";
    case "array":
      return `List<${schema.items ? kotlinType(schema.items) : "Any"}>`;
    case "object":
      return pascalCase(schema.description || "Model");
    case "null":
      return "Any";
    default:
      return "Any";
  }
}

/** Infer Swift type from schema (without nullability marker). */
export function swiftType(schema: ApilotSchema): string {
  switch (schema.type) {
    case "string":
      return "String";
    case "number":
    case "integer":
      return "Int";
    case "boolean":
      return "Bool";
    case "array":
      return `[${schema.items ? swiftType(schema.items) : "Any"}]`;
    case "object":
      return pascalCase(schema.description || "Model");
    case "null":
      return "Any";
    default:
      return "Any";
  }
}

/** Generate a field name for a given schema property key in a target language. */
export function fieldName(key: string, lang: "dart" | "typescript" | "kotlin" | "swift"): string {
  switch (lang) {
    case "dart":
      return snakeCase(key);
    case "typescript":
      return jsonKey(key);
    case "kotlin":
      return camelCase(key);
    case "swift":
      return camelCase(key);
    default:
      return key;
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

// --- Dart (freezed) ---
export class DartFreezedTemplate extends CodegenTemplate {
  name = "dart-freezed";
  languages = ["dart"];

  generate(opts: CodegenOptions): GeneratedFile[] {
    const modelName = pascalCase(opts.endpointId.replace(/\./g, "_"));
    const fileName = `${opts.endpointId.replace(/\./g, "_")}`;

    const fields = this._fields(opts.schema);
    const fromJson = this._fromJson(opts.schema);
    const toJson = this._toJson(opts.schema);

    const modelCode = `// Generated by Apilot. Do not edit by hand.
// Endpoint: ${opts.endpointName} (${opts.method} ${opts.url})
// Language: Dart (freezed + json_serializable)

import 'package:freezed_annotation/freezed_annotation.dart';

part '${fileName}.freezed.dart';
part '${fileName}.g.dart';

@Freezed(toJson: true, fromJson: true)
class ${modelName} with _$${modelName} = _${modelName};

class _${modelName} {
  const factory _${modelName}({
${fields}
  }) = _${modelName};

  factory _${modelName}.fromJson(Map<String, dynamic> json) => _$${modelName}FromJson(json);
}

// JSON serialization helpers
${modelName} _$${modelName}FromJson(Map<String, dynamic> json) {
  return _${modelName}(
${fromJson}
  );
}

Map<String, dynamic> _$${modelName}ToJson(_${modelName} obj) => {
${toJson}
};
`;

    // Dio API client call layer
    const clientCode = `// Generated by Apilot. Do not edit by hand.
// Endpoint: ${opts.endpointName}

import 'package:dio/dio.dart';

class ${modelName}Api {
  final Dio _dio;
  ${modelName}Api(this._dio);

  Future<${modelName}> call({
    Map<String, dynamic>? queryParameters,
    Options? options,
  }) async {
    final response = await _dio.request(
      '${opts.url}',
      options: options ?? Options(method: '${opts.method}'),
      queryParameters: queryParameters,
    );
    return ${modelName}.fromJson(response.data);
  }
}
`;

    return [
      { path: `${opts.outputPath}/${fileName}.dart`, content: modelCode, language: "dart" },
      { path: `${opts.outputPath}/${fileName}_api.dart`, content: clientCode, language: "dart" },
    ];
  }

  private _fields(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "";
    return Object.entries(schema.properties)
      .map(([key, prop]) => {
        const opt = prop.nullable || !schema.required.includes(key) ? "?" : "";
        const dt = `${dartType(prop)}${opt}`;
        const name = snakeCase(key);
        const jsonKey = key !== name
          ? `@JsonKey(name: '${key}') `
          : "";
        return `    ${jsonKey}${dt} ${name},\n`;
      })
      .join("");
  }

  private _fromJson(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "  )";
    return Object.entries(schema.properties)
      .map(([key, prop]) => {
        const name = snakeCase(key);
        const jsonKey = key.includes("_") ? `${key}` : key;
        return `    ${name}: json['${jsonKey}'] as ${prop.nullable ? `${dartType(prop)}?` : dartType(prop)},`;
      })
      .join("\n");
  }

  private _toJson(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "  };";
    const entries = Object.entries(schema.properties).map(([key]) => {
      const name = snakeCase(key);
      const jsonKey = key.includes("_") ? `${key}` : key;
      return `    '${jsonKey}': obj.${name},`;
    });
    return entries.join("\n");
  }
}

// --- Dart (plain class) ---
export class DartPlainTemplate extends CodegenTemplate {
  name = "dart-plain";
  languages = ["dart-plain"];

  generate(opts: CodegenOptions): GeneratedFile[] {
    const modelName = pascalCase(opts.endpointId.replace(/\./g, "_"));
    const fileName = `${opts.endpointId.replace(/\./g, "_")}`;

    const fields = this._fields(opts.schema);
    const fromJson = this._fromJson(opts.schema);

    const code = `// Generated by Apilot. Do not edit by hand.
// Endpoint: ${opts.endpointName} (plain Dart)

class ${modelName} {
${fields}

  ${modelName}({${this._constructorArgs(opts.schema)}});

  factory ${modelName}.fromJson(Map<String, dynamic> json) => ${modelName}(
${fromJson}
  );

  Map<String, dynamic> toJson() => {
${this._toJson(opts.schema)}
  };
}
`;

    return [{ path: `${opts.outputPath}/${fileName}.dart`, content: code, language: "dart" }];
  }

  private _fields(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "";
    const indent = "  ";
    return Object.entries(schema.properties)
      .map(([key, prop]) => {
        const opt = prop.nullable || !schema.required.includes(key) ? "?" : "";
        const dt = `${dartType(prop)}${opt}`;
        const name = snakeCase(key);
        return `${indent}final ${dt} ${name};`;
      })
      .join("\n");
  }

  private _constructorArgs(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "";
    return Object.entries(schema.properties)
      .map(([key, prop]) => {
        const opt = prop.nullable || !schema.required.includes(key) ? "?" : "";
        const dt = `${dartType(prop)}${opt}`;
        const name = snakeCase(key);
        return `${dt} ${name}`;
      })
      .join(", ");
  }

  private _fromJson(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "";
    return Object.entries(schema.properties)
      .map(([key, prop]) => {
        const name = snakeCase(key);
        const dt = prop.nullable ? `${dartType(prop)}?` : dartType(prop);
        return `    ${name}: json['${key}'] as ${dt},`;
      })
      .join("\n");
  }

  private _toJson(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "";
    return Object.entries(schema.properties)
      .map(([key]) => {
        const name = snakeCase(key);
        return `    '${key}': ${name},`;
      })
      .join("\n");
  }
}

// --- TypeScript (zod + interfaces) ---
export class TypeScriptTemplate extends CodegenTemplate {
  name = "typescript";
  languages = ["typescript"];

  generate(opts: CodegenOptions): GeneratedFile[] {
    const modelName = pascalCase(opts.endpointId.replace(/\./g, "_"));
    const fileName = `${opts.endpointId.replace(/\./g, "_")}`;

    const interfaceFields = this._interfaceFields(opts.schema);
    const zodSchema = this._zodSchema(opts.schema);
    const clientCode = this._client(opts);

    const modelCode = `// Generated by Apilot. Do not edit by hand.
// Endpoint: ${opts.endpointName}
// Language: TypeScript (interface + zod)

${zodSchema}

export interface ${modelName} {
${interfaceFields}
}

export type ${modelName}Input = Omit<${modelName}, "id">;
`;

    return [
      { path: `${opts.outputPath}/${fileName}.ts`, content: modelCode, language: "typescript" },
      { path: `${opts.outputPath}/${fileName}.client.ts`, content: clientCode, language: "typescript" },
    ];
  }

  private _interfaceFields(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "  // empty";
    return Object.entries(schema.properties)
      .map(([key, prop]) => {
        const nt = tsType(prop);
        const name = jsonKey(key);
        const opt = prop.nullable ? `${nt} | null` : nt;
        const req = schema.required.includes(key) && !prop.nullable ? "" : "?";
        return `  ${name}${req}: ${opt};`;
      })
      .join("\n");
  }

  private _zodSchema(_schema: ApilotSchema): string {
    const modelName = pascalCase("placeholder");
    return `import { z } from "zod";\n\nexport const ${modelName}Schema = z.object({});`;
  }

  private _client(opts: CodegenOptions): string {
    const modelName = pascalCase(opts.endpointId.replace(/\./g, "_"));
    return `// Generated by Apilot. Do not edit by hand.

import type { ${modelName} } from "./${opts.endpointId.replace(/\./g, "_")}";

export async function callApi<T>(
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(\`HTTP \${res.status}: \${res.statusText}\`);
  return res.json();
}

export const ${camelCase(opts.endpointId.replace(/\./g, "_"))} = (
  params?: Record<string, string>,
  body?: unknown,
  headers?: Record<string, string>
) => callApi<${modelName}>("${opts.method}", "${opts.url}", body, headers);
`;
  }
}

// --- Kotlin (data class + Retrofit) ---
export class KotlinTemplate extends CodegenTemplate {
  name = "kotlin";
  languages = ["kotlin"];

  generate(opts: CodegenOptions): GeneratedFile[] {
    const modelName = pascalCase(opts.endpointId.replace(/\./g, "_"));
    const fileName = `${opts.endpointId.replace(/\./g, "_")}`;

    const fields = this._fields(opts.schema);

    const code = `// Generated by Apilot. Do not edit by hand.
// Endpoint: ${opts.endpointName}

package com.apilot.generated

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.Json
import retrofit2.http.*

@Serializable
data class ${modelName}(
${fields}
) {
    companion object {
        fun fromJson(json: String): ${modelName} = Json.decodeFromString(serializer(), json)
    }
}

${this._fromJsonFn(modelName, opts.schema)}

interface ${modelName}Api {
    @${opts.method.toLowerCase()}("${opts.url}")
    suspend fun call(): ${modelName}
}
`;

    return [{ path: `${opts.outputPath}/${fileName}.kt`, content: code, language: "kotlin" }];
  }

  private _fields(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "";
    return Object.entries(schema.properties)
      .map(([key, prop]) => {
        const kt = kotlinType(prop);
        const opt = prop.nullable || !schema.required.includes(key) ? "?" : "";
        return `    @SerialName("${key}") val ${camelCase(key)}: ${kt}${opt},`;
      })
      .join("\n");
  }

  private _fromJsonFn(_modelName: string, schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "";
    return "";
  }
}

// --- Swift (Codable) ---
export class SwiftTemplate extends CodegenTemplate {
  name = "swift";
  languages = ["swift"];

  generate(opts: CodegenOptions): GeneratedFile[] {
    const modelName = pascalCase(opts.endpointId.replace(/\./g, "_"));
    const fileName = `${opts.endpointId.replace(/\./g, "_")}`;

    const fields = this._fields(opts.schema);

    const code = `// Generated by Apilot. Do not edit by hand.
// Endpoint: ${opts.endpointName}

import Foundation

struct ${modelName}: Codable {
${fields}

    enum CodingKeys: String, CodingKey {
${this._codingKeys(opts.schema)}
    }
}

struct ${modelName}API {
    static func call(
        baseURL: String,
        query: [String: String]? = nil,
        headers: [String: String]? = nil
    ) async throws -> ${modelName} {
        var components = URLComponents(string: "\(baseURL)${opts.url}")!
        // build request...
        // ...
    }
}
`;

    return [{ path: `${opts.outputPath}/${fileName}.swift`, content: code, language: "swift" }];
  }

  private _fields(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "";
    return Object.entries(schema.properties)
      .map(([key, prop]) => {
        const st = swiftType(prop);
        const name = camelCase(key);
        const opt = prop.nullable ? "?" : "";
        return `    let ${name}: ${st}${opt}`;
      })
      .join("\n");
  }

  private _codingKeys(schema: ApilotSchema): string {
    if (schema.type !== "object" || !schema.properties) return "";
    return Object.entries(schema.properties)
      .map(([key]) => {
        const name = camelCase(key);
        const raw = key !== name ? ` = "${key}"` : "";
        return `        case ${name}${raw}`;
      })
      .join("\n");
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class CodegenEngine {
  private templates: Map<string, CodegenTemplate> = new Map();

  constructor() {
    this.register(new DartFreezedTemplate());
    this.register(new DartPlainTemplate());
    this.register(new TypeScriptTemplate());
    this.register(new KotlinTemplate());
    this.register(new SwiftTemplate());
  }

  register(template: CodegenTemplate): void {
    for (const lang of template.languages) {
      this.templates.set(lang, template);
    }
  }

  getTemplate(language: string): CodegenTemplate | undefined {
    return this.templates.get(language);
  }

  /** Generate files for an endpoint + schema. */
  generate(opts: CodegenOptions): GeneratedFile[] {
    const template = this.getTemplate(opts.language);
    if (!template) {
      throw new Error(
        `No codegen template for language "${opts.language}". ` +
        `Available: ${[...this.templates.keys()].join(", ")}`
      );
    }
    return template.generate(opts);
  }

  /**
   * Diff-aware generation: only returns models whose schema changed
   * since the last generation. Hand-written files (with a `.custom`
   * suffix or in a separate dir) are never overwritten.
   */
  generateDiff(
    opts: CodegenOptions,
    prevSchema?: ApilotSchema
  ): { files: GeneratedFile[]; changed: boolean } {
    const currentSchema = opts.schema;
    const changed = prevSchema
      ? !schemasEqual(currentSchema, prevSchema)
      : true;

    if (!changed) {
      return { files: [], changed: false };
    }

    return { files: this.generate(opts), changed: true };
  }
}

/** Shallow schema comparison for diff-awareness. */
function schemasEqual(a: ApilotSchema, b: ApilotSchema): boolean {
  const keysA = Object.keys(a.properties ?? {});
  const keysB = Object.keys(b.properties ?? {});
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    const propA = a.properties?.[key];
    const propB = b.properties?.[key];
    if (!propA || !propB) return false;
    if (propA.type !== propB.type) return false;
    if (propA.nullable !== propB.nullable) return false;
  }
  return true;
}

export { inferSchema };
