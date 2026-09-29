import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode2, Play, Save, Trash2 } from "lucide-react";
import type { EndpointAuth, EndpointFile, HttpMethod, Revision, SnapshotMeta, SnapshotRedacted } from "@apilot/core";
import { call } from "../api";
import type { View } from "../App";
import { ChangesTab, CodeTab, HistoryTab, ResponseTab, SchemaTab, VersionsTab } from "./ResultTabs";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

interface Detail {
  id: string;
  file: string;
  collectionId: string;
  definition: EndpointFile;
  snapshots: SnapshotMeta[];
  revisions: Revision[];
  latest: SnapshotRedacted | null;
}

export interface RunView {
  snapshot: SnapshotRedacted;
  captured?: Record<string, string>;
}

const EMPTY: EndpointFile = { name: "", method: "GET", url: "{{baseUrl}}/" };

export function EndpointView(props: { id?: string; env: string; tab?: string; version: number; setView: (v: View) => void; collections?: string[] }) {
  const { id, env, version, setView } = props;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<EndpointFile>(EMPTY);
  const [collection, setCollection] = useState(props.collections?.[0] ?? "");
  const [dirty, setDirty] = useState(!id);
  const [reqTab, setReqTab] = useState("params");
  const [resTab, setResTab] = useState(props.tab ?? "response");
  const [shown, setShown] = useState<RunView | null>(null);
  const [busy, setBusy] = useState<"" | "run" | "save">("");
  const [error, setError] = useState("");
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (props.tab) setResTab(props.tab);
  }, [props.tab]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await call<Detail>("endpoint", { id });
      setDetail(d);
      if (!dirtyRef.current) setDraft(d.definition);
      setShown((cur) => (cur && d.snapshots.some((s) => s.id === cur.snapshot.id) ? cur : d.latest ? { snapshot: d.latest } : null));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load, version]);

  const edit = (patch: Partial<EndpointFile>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const save = async (): Promise<string | undefined> => {
    if (!draft.name.trim()) {
      setError("Give the endpoint a name.");
      return;
    }
    setBusy("save");
    try {
      const r = await call<{ id: string }>("save", { ...clean(draft), id, collection: id ? undefined : collection || undefined });
      setDirty(false);
      setError("");
      if (!id) setView({ kind: "endpoint", id: r.id });
      return r.id;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const send = async () => {
    const target = dirty ? await save() : id;
    if (!target) return;
    if (!id) return; // new endpoint: the view switches to it; run from there
    setBusy("run");
    setError("");
    try {
      const r = await call<{ snapshot: SnapshotRedacted; captured: Record<string, string>; diff?: { changes: unknown[] } }>("run", { id: target, env });
      setShown({ snapshot: r.snapshot, captured: r.captured });
      setResTab(r.diff?.changes.length ? "changes" : "response");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!id) return;
    await call("tool:delete_endpoint", { endpointId: id });
    setView({ kind: "home" });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      save();
    }
  };

  const tabs: [string, string, number?][] = [
    ["params", "Params", Object.keys(draft.query ?? {}).length],
    ["headers", "Headers", Object.keys(draft.headers ?? {}).length],
    ["auth", "Auth"],
    ["body", "Body"],
    ["tests", "Tests"],
  ];

  if (id && !detail) return error ? <div className="banner error pad">{error}</div> : <div className="center muted">Loading…</div>;

  return (
    <div className="endpoint" onKeyDown={onKey}>
      <div className="ep-header">
        <input className="ep-title" value={draft.name} placeholder="Endpoint name" onChange={(e) => edit({ name: e.target.value })} aria-label="Endpoint name" />
        {!id && props.collections && (
          <label className="row gap-s small">
            Collection
            <input list="apilot-collections" value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="e.g. orders" />
            <datalist id="apilot-collections">
              {props.collections.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
        )}
        {detail && (
          <span className="muted small">
            {detail.id}
            {detail.revisions[0] ? ` · v${detail.revisions[0].revision}` : ""}
            {dirty ? " · unsaved" : ""}
          </span>
        )}
        <span className="spacer" />
        {detail && (
          <>
            <button className="icon" title="Open YAML file" aria-label="Open YAML file" onClick={() => call("openFile", { file: detail.file })}>
              <FileCode2 size={14} />
            </button>
            <button className="icon danger" title="Delete endpoint" aria-label="Delete endpoint" onClick={remove}>
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>

      <div className="urlbar">
        <select value={draft.method} onChange={(e) => edit({ method: e.target.value as HttpMethod })} className={`method-select m-${draft.method}`} aria-label="HTTP method">
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input className="url" value={draft.url} onChange={(e) => edit({ url: e.target.value })} placeholder="{{baseUrl}}/path/{{id}}" spellCheck={false} aria-label="URL" />
        <button className="primary" onClick={send} disabled={!!busy || !id} title={id ? "Send (Ctrl+Enter)" : "Save first"}>
          <Play size={14} /> {busy === "run" ? "Sending…" : "Send"}
        </button>
        <button onClick={save} disabled={!!busy || !dirty} title="Save (Ctrl+S)">
          <Save size={14} /> Save
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="tabs">
        {tabs.map(([k, label, n]) => (
          <button key={k} className={reqTab === k ? "active" : ""} onClick={() => setReqTab(k)}>
            {label}
            {n ? <span className="count">{n}</span> : null}
          </button>
        ))}
      </div>
      <div className="tab-body req">
        {reqTab === "params" && <KeyValues value={draft.query} onChange={(query) => edit({ query })} keyLabel="Parameter" />}
        {reqTab === "headers" && <KeyValues value={draft.headers} onChange={(headers) => edit({ headers })} keyLabel="Header" />}
        {reqTab === "auth" && <AuthEditor value={draft.auth} onChange={(auth) => edit({ auth })} />}
        {reqTab === "body" && <BodyEditor key={detail?.revisions[0]?.revision ?? 0} value={draft.body} onChange={(body) => edit({ body })} />}
        {reqTab === "tests" && <TestsEditor draft={draft} edit={edit} />}
      </div>

      {id && detail && (
        <>
          <div className="tabs results">
            {[
              ["response", "Response"],
              ["changes", "Changes"],
              ["history", `History (${detail.snapshots.length})`],
              ["versions", `Versions (${detail.revisions.length})`],
              ["schema", "Schema"],
              ["code", "Code"],
            ].map(([k, label]) => (
              <button key={k} className={resTab === k ? "active" : ""} onClick={() => setResTab(k!)}>
                {label}
              </button>
            ))}
          </div>
          <div className="tab-body">
            {resTab === "response" && <ResponseTab run={shown} />}
            {resTab === "changes" && <ChangesTab id={id} snapshots={detail.snapshots} version={version} />}
            {resTab === "history" && (
              <HistoryTab
                id={id}
                snapshots={detail.snapshots}
                shownId={shown?.snapshot.id}
                show={async (sid) => {
                  setShown({ snapshot: await call("snapshot", { id, snapshotId: sid }) });
                  setResTab("response");
                }}
              />
            )}
            {resTab === "versions" && <VersionsTab id={id} revisions={detail.revisions} dirty={dirty} />}
            {resTab === "schema" && <SchemaTab id={id} version={version} />}
            {resTab === "code" && <CodeTab id={id} version={version} />}
          </div>
        </>
      )}
    </div>
  );
}

/** Drop empty optional fields so the YAML stays minimal. */
function clean(d: EndpointFile): EndpointFile {
  const out: EndpointFile = { name: d.name.trim(), method: d.method, url: d.url.trim() };
  if (d.query && Object.keys(d.query).length) out.query = d.query;
  if (d.headers && Object.keys(d.headers).length) out.headers = d.headers;
  if (d.auth) out.auth = d.auth;
  if (d.body !== undefined && d.body !== null && d.body !== "") out.body = d.body;
  if (d.expect?.status) out.expect = d.expect;
  if (d.after?.length) out.after = d.after;
  return out;
}

// ---------------------------------------------------------------------------
// Request editors
// ---------------------------------------------------------------------------

function KeyValues({ value, onChange, keyLabel }: { value?: Record<string, string>; onChange: (v: Record<string, string> | undefined) => void; keyLabel: string }) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value ?? {}));
  const lastSent = useRef(JSON.stringify(value ?? {}));
  useEffect(() => {
    const s = JSON.stringify(value ?? {});
    if (s !== lastSent.current) {
      lastSent.current = s;
      setRows(Object.entries(value ?? {}));
    }
  }, [value]);

  const commit = (next: [string, string][]) => {
    setRows(next);
    const obj = Object.fromEntries(next.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
    lastSent.current = JSON.stringify(obj);
    onChange(Object.keys(obj).length ? obj : undefined);
  };
  const all = [...rows, ["", ""] as [string, string]];

  return (
    <table className="kv">
      <thead>
        <tr>
          <th>{keyLabel}</th>
          <th>Value</th>
          <th aria-label="Remove" />
        </tr>
      </thead>
      <tbody>
        {all.map(([k, v], i) => (
          <tr key={i}>
            <td>
              <input value={k} placeholder={i === rows.length ? `Add ${keyLabel.toLowerCase()}` : ""} onChange={(e) => commit(set(all, i, [e.target.value, v], rows.length))} spellCheck={false} aria-label={keyLabel} />
            </td>
            <td>
              <input value={v} placeholder={i === rows.length ? "value or {{variable}}" : ""} onChange={(e) => commit(set(all, i, [k, e.target.value], rows.length))} spellCheck={false} aria-label="Value" />
            </td>
            <td>
              {i < rows.length && (
                <button className="icon" aria-label="Remove row" onClick={() => commit(rows.filter((_, j) => j !== i))}>
                  ×
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function set(all: [string, string][], i: number, row: [string, string], realLen: number): [string, string][] {
  const next = all.map((r, j) => (j === i ? row : r));
  return i === realLen ? next : next.slice(0, realLen);
}

function AuthEditor({ value, onChange }: { value?: EndpointAuth; onChange: (v: EndpointAuth | undefined) => void }) {
  const type = value?.type ?? "none";
  const pick = (t: string) =>
    onChange(
      t === "bearer" ? { type: "bearer", token: "{{authToken}}" }
      : t === "basic" ? { type: "basic", username: "", password: "{{basicPassword}}" }
      : t === "apiKey" ? { type: "apiKey", in: "header", name: "X-API-Key", key: "{{apiKey}}" }
      : t === "custom" ? { type: "custom", headers: { Authorization: "{{authHeader}}" } }
      : undefined
    );
  const field = (label: string, key: string, v: string) => (
    <label className="field">
      <span>{label}</span>
      <input value={v} onChange={(e) => onChange({ ...value, [key]: e.target.value } as EndpointAuth)} spellCheck={false} />
    </label>
  );
  return (
    <div className="form">
      <label className="field">
        <span>Type</span>
        <select value={type} onChange={(e) => pick(e.target.value)}>
          <option value="none">None (or inherited from the folder)</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic</option>
          <option value="apiKey">API key</option>
          <option value="custom">Custom headers</option>
        </select>
      </label>
      {value?.type === "bearer" && field("Token", "token", value.token)}
      {value?.type === "basic" && (
        <>
          {field("Username", "username", value.username)}
          {field("Password", "password", value.password)}
        </>
      )}
      {value?.type === "apiKey" && (
        <>
          <label className="field">
            <span>Send in</span>
            <select value={value.in} onChange={(e) => onChange({ ...value, in: e.target.value as "header" | "query" })}>
              <option value="header">Header</option>
              <option value="query">Query parameter</option>
            </select>
          </label>
          {field("Name", "name", value.name)}
          {field("Key", "key", value.key)}
        </>
      )}
      {value?.type === "custom" && <KeyValues value={value.headers} onChange={(headers) => onChange({ type: "custom", headers: headers ?? {} })} keyLabel="Header" />}
      {type !== "none" && (
        <p className="muted small">
          Reference secrets as <code>{"{{name}}"}</code> and enter their values under Environments. Values go to your OS keychain — never into files, git, or the AI.
        </p>
      )}
    </div>
  );
}

function BodyEditor({ value, onChange }: { value: EndpointFile["body"]; onChange: (v: EndpointFile["body"]) => void }) {
  const initialMode = value === undefined || value === null || value === "" ? "none" : typeof value === "string" ? "text" : "json";
  const [mode, setMode] = useState(initialMode);
  const [text, setText] = useState(typeof value === "string" ? value : value ? JSON.stringify(value, null, 2) : "");
  const [err, setErr] = useState("");

  const update = (t: string, m = mode) => {
    setText(t);
    if (m === "none") return onChange(undefined);
    if (m === "text") return onChange(t);
    try {
      onChange(t.trim() ? JSON.parse(t) : undefined);
      setErr("");
    } catch (e) {
      setErr(`Invalid JSON: ${(e as Error).message}`);
    }
  };

  return (
    <div className="form">
      <div className="row gap-s" role="radiogroup" aria-label="Body type">
        {["none", "json", "text"].map((m) => (
          <label key={m} className="radio">
            <input type="radio" checked={mode === m} onChange={() => (setMode(m), update(text, m))} /> {m === "json" ? "JSON" : m === "text" ? "Raw text" : "None"}
          </label>
        ))}
      </div>
      {mode !== "none" && <textarea className="code" rows={10} value={text} onChange={(e) => update(e.target.value)} spellCheck={false} aria-label="Request body" />}
      {err && <div className="banner error">{err}</div>}
    </div>
  );
}

function TestsEditor({ draft, edit }: { draft: EndpointFile; edit: (p: Partial<EndpointFile>) => void }) {
  const captures = Object.fromEntries((draft.after ?? []).flatMap((s) => Object.entries(s.set)));
  return (
    <div className="form">
      <label className="field">
        <span>Expected status</span>
        <input
          type="number"
          value={draft.expect?.status ?? ""}
          placeholder="any 2xx/3xx"
          onChange={(e) => edit({ expect: e.target.value ? { ...draft.expect, status: Number(e.target.value) } : undefined })}
        />
      </label>
      <h3>Chaining</h3>
      <p className="muted small">
        Capture values from this response for later requests, e.g. <code>orderId</code> = <code>$.data[0].id</code>, then use <code>{"{{orderId}}"}</code>. Captured values live in memory only.
      </p>
      <KeyValues value={captures} onChange={(v) => edit({ after: v ? [{ set: v }] : undefined })} keyLabel="Variable" />
    </div>
  );
}
