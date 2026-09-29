/**
 * File-format layer.
 *
 * Responsibilities:
 *  - Parse .apilot/apilot.yaml
 *  - Parse environments/*.yaml
 *  - Parse collections folder endpoint files
 *  - Build an in-memory ProjectRegistry
 *
 * The core never imports `fs` directly; it takes file-read callbacks so it
 * can run in Node, the webview, or tests.  Only the extension/CLI layer
 * supplies the real filesystem.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ApilotProject,
  CollectionEntry,
  EndpointEntry,
  EndpointFile,
  EnvironmentEntry,
  EnvironmentFile,
  ProjectRegistry,
} from "./types.js";

export interface FileResolver {
  /** Read a file at a path relative to the project root. */
  read(relPath: string): string | undefined;
  /** Does the path exist? */
  exists(relPath: string): boolean;
  /** List entries in a directory relative to project root. */
  listDir(relPath: string): string[];
  /** Root path of the project. */
  root: string;
}

export class NodeFileResolver implements FileResolver {
  constructor(public root: string) {}

  read(relPath: string): string | undefined {
    try {
      return readFileSync(resolve(this.root, relPath), "utf-8");
    } catch {
      return undefined;
    }
  }

  exists(relPath: string): boolean {
    return existsSync(resolve(this.root, relPath));
  }

  listDir(relPath: string): string[] {
    try {
      return readdirSync(resolve(this.root, relPath));
    } catch {
      return [];
    }
  }
}

/**
 * Parses and validates a single endpoint file.
 * Throws `EndpointParseError` on structural problems.
 */
export function parseEndpointFile(
  raw: string,
  file: string
): EndpointFile {
  const doc = parseYaml(raw) as Partial<EndpointFile>;

  if (!doc || typeof doc !== "object") {
    throw new EndpointParseError(file, "File is empty or not a YAML mapping");
  }

  const required = ["name", "method", "url"];
  for (const field of required) {
    if (doc[field as keyof EndpointFile] === undefined) {
      throw new EndpointParseError(file, `Missing required field: "${field}"`);
    }
  }

  const method = String(doc.method).toUpperCase();
  if (!isValidMethod(method)) {
    throw new EndpointParseError(
      file,
      `Invalid method "${method}". Must be one of GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.`
    );
  }

  return {
    name: doc.name!,
    method: method as EndpointFile["method"],
    url: doc.url!,
    auth: doc.auth as EndpointFile["auth"] | undefined,
    query: doc.query as Record<string, string> | undefined,
    headers: doc.headers as Record<string, string> | undefined,
    body: doc.body ?? null,
    expect: doc.expect as EndpointFile["expect"] | undefined,
    after: doc.after as EndpointFile["after"] | undefined,
  };
}

export function parseEnvironmentFile(
  raw: string,
  file: string
): EnvironmentFile {
  const doc = parseYaml(raw) as Partial<EnvironmentFile>;

  if (!doc || typeof doc !== "object") {
    throw new EndpointParseError(file, "File is empty or not a YAML mapping");
  }
  if (!doc.name) {
    throw new EndpointParseError(file, 'Missing required field: "name"');
  }

  return {
    name: doc.name!,
    variables: (doc.variables ?? {}) as EnvironmentFile["variables"],
  };
}

const VALID_METHODS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
]);

function isValidMethod(m: string): m is EndpointFile["method"] {
  return VALID_METHODS.has(m) as boolean;
}

export class EndpointParseError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`[${file}] ${message}`);
    this.name = "EndpointParseError";
  }
}

/**
 * Walk the .apilot/collections directory and build a registry of every
 * collection + endpoint.
 */
export class Registry {
  constructor(private files: FileResolver) {}

  /** Discover and index all collections and endpoints. */
  build(): ProjectRegistry {
    const projRaw = this.files.read(".apilot/apilot.yaml");
    const project: ApilotProject = projRaw
      ? (parseYaml(projRaw) as ApilotProject)
      : { name: "apilot-project", codegen: {} };

    const collections: CollectionEntry[] = [];
    const endpoints: EndpointEntry[] = [];
    const environments: EnvironmentEntry[] = [];

    // --- Collections ---
    const collRoot = ".apilot/collections";
    if (this.files.exists(`${collRoot}/`)) {
      const topDirs = this.files.listDir(collRoot).sort();
      for (const dir of topDirs) {
        this._walkCollection(collRoot, dir, "", collections, endpoints);
      }
    }

    // --- Environments ---
    const envRoot = ".apilot/environments";
    if (this.files.exists(`${envRoot}/`)) {
      for (const file of this.files.listDir(envRoot)) {
        if (file.endsWith(".yaml") || file.endsWith(".yml")) {
          environments.push({
            name: file.replace(/\.(yaml|yml)$/, ""),
            path: `${envRoot}/${file}`,
          });
        }
      }
    }

    return {
      project,
      collections,
      endpoints,
      environments,
    };
  }

  /** Recursively walk collection folders. A folder is a collection if it
   * contains endpoint files or a `_folder.yaml`. */
  private _walkCollection(
    base: string,
    name: string,
    relPrefix: string,
    collections: CollectionEntry[],
    endpoints: EndpointEntry[]
  ): void {
    const path = `${base}/${relPrefix}${name}`;
    const entries = this.files.listDir(path);

    // Is this a collection? (has endpoint files or subfolders)
    // `_folder.yaml` may list `order: [slug, …]` so chained requests run in sequence.
    let order: string[] = [];
    try {
      order = (parseYaml(this.files.read(`${path}/_folder.yaml`) ?? "") as { order?: string[] } | null)?.order ?? [];
    } catch {
      /* invalid folder file — ignore ordering */
    }
    const rank = (f: string) => {
      const i = order.indexOf(f.replace(/\.(yaml|yml)$/, ""));
      return i === -1 ? order.length : i;
    };
    const endpointFiles = entries
      .filter((e) => e.endsWith(".yaml") && e !== "_folder.yaml")
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const subFolders = entries.filter((e) => !e.includes(".")).sort();

    if (endpointFiles.length > 0 || subFolders.length > 0) {
      const collectionId = (relPrefix + name).replace(/^\//, "");
      collections.push({
        id: collectionId,
        name: name.charAt(0).toUpperCase() + name.slice(1),
        path: path,
      });

      for (const ef of endpointFiles) {
        const epId = `${collectionId}.${ef.replace(/\.(yaml|yml)$/, "")}`;
        const epFile = `${path}/${ef}`;
        const epRaw = this.files.read(epFile);
        let epName = ef.replace(/\.(yaml|yml)$/, "");
        let epMethod: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" = "GET";
        let epUrl = "";
        if (epRaw) {
          try {
            const doc = parseYaml(epRaw) as any;
            epName = doc.name ?? epName;
            epMethod = (doc.method ?? "GET").toUpperCase() as any;
            epUrl = doc.url ?? "";
          } catch {
            /* keep defaults */
          }
        }
        endpoints.push({
          id: epId,
          collectionId,
          name: epName,
          method: epMethod,
          url: epUrl,
          file: epFile,
        });
      }

      for (const sub of subFolders) {
        this._walkCollection(
          base,
          sub,
          `${relPrefix}${name}/`,
          collections,
          endpoints
        );
      }
    }
  }

  /** Load and parse a single endpoint file by its absolute repo path. */
  loadEndpoint(file: string): EndpointEntry {
    const ep = this.build().endpoints.find((e) => e.file === file);
    if (!ep) {
      throw new EndpointParseError(file, "Endpoint not found in registry");
    }
    return ep;
  }
}

export { parseYaml };
