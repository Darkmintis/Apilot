import type { ApilotProject, CollectionEntry, EndpointEntry } from "@apilot/core";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): any; setState(s: unknown): void };

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage: () => {}, getState: () => undefined, setState: () => {} };

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const listeners = new Set<(msg: any) => void>();

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type === "result") {
    const p = pending.get(msg.reqId);
    pending.delete(msg.reqId);
    if (msg.error) p?.reject(new Error(msg.error));
    else p?.resolve(msg.result);
  } else {
    listeners.forEach((l) => l(msg));
  }
});

/** Ask the extension host. `tool:<name>` runs the same tool the AI uses. */
export function call<T = any>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const reqId = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    vscode.postMessage({ type: "call", reqId, method, args });
  });
}

export function onHostMessage(fn: (msg: any) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const persisted = { get: () => vscode.getState() ?? {}, set: (s: unknown) => vscode.setState(s) };

export type Health = { status?: number; state: "none" | "passed" | "failed" | "breaking" | "changed" };

export interface AppState {
  hasProject: boolean;
  hasFolder: boolean;
  project?: ApilotProject;
  env?: string;
  environments?: string[];
  collections?: CollectionEntry[];
  endpoints?: (EndpointEntry & { health: Health })[];
}

export const pretty = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 2));

export const timeAgo = (iso: string): string => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
