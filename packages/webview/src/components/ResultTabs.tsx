import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, GitCompare, Info, XCircle } from "lucide-react";
import type { ApilotSchema, BreakingLevel, DiffResult, Revision, RevisionChange, SnapshotMeta, SnapshotRedacted } from "@apilot/core";
import { call, persisted, pretty, timeAgo } from "../api";
import { JsonDiff } from "./JsonDiff";
import type { RunView } from "./EndpointView";

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; reload: () => void } {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((data) => live && setState({ data }), (e: Error) => live && setState({ error: e.message }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

const snapLabel = (s: SnapshotMeta) => `${new Date(s.timestamp).toLocaleString()} · ${s.status}${s.baseline ? " · baseline" : ""}${s.revision ? ` · v${s.revision}` : ""}`;
const copy = (text: string) => navigator.clipboard.writeText(text);

// ---------------------------------------------------------------------------

export function ResponseTab({ run }: { run: RunView | null }) {
  const [showHeaders, setShowHeaders] = useState(false);
  if (!run) return <Empty>Send the request to see its response. Every response is saved (secrets redacted) so you and your AI can compare later.</Empty>;
  const s = run.snapshot;
  const body = pretty(s.body);
  return (
    <div className="response">
      <div className="row gap meta">
        <span className={`status s${String(s.status)[0]}`}>{s.status || "ERR"}</span>
        <span className="muted">{s.timeMs} ms</span>
        <span className="muted">{formatSize(s.size)}</span>
        <span className="muted">{timeAgo(s.timestamp)}</span>
        <span className="muted small">{s.request.method} {s.request.url}</span>
        <span className="spacer" />
        <button className="icon" title="Copy body" aria-label="Copy body" onClick={() => copy(body)}>
          <Copy size={14} />
        </button>
      </div>
      {s.failures.length > 0 && (
        <div className="banner error">
          {s.failures.map((f, i) => (
            <div key={i}>
              <b>{f.field}</b>: {f.message}
            </div>
          ))}
        </div>
      )}
      {run.captured && Object.keys(run.captured).length > 0 && (
        <div className="banner info">
          Captured for next requests: {Object.entries(run.captured).map(([k, v]) => <code key={k}>{`${k}=${v}`}</code>)}
        </div>
      )}
      <button className="link small" onClick={() => setShowHeaders(!showHeaders)}>
        {showHeaders ? "Hide" : "Show"} {Object.keys(s.headers).length} response headers
      </button>
      {showHeaders && (
        <table className="kv readonly">
          <tbody>
            {Object.entries(s.headers).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <pre className="code body">{body || <span className="muted">(empty body)</span>}</pre>
    </div>
  );
}

const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// ---------------------------------------------------------------------------

const LEVELS: { level: BreakingLevel; label: string; icon: JSX.Element }[] = [
  { level: "breaking", label: "Breaking", icon: <XCircle size={14} /> },
  { level: "warning", label: "Warning", icon: <AlertTriangle size={14} /> },
  { level: "nonBreaking", label: "Safe", icon: <CheckCircle2 size={14} /> },
  { level: "info", label: "Info", icon: <Info size={14} /> },
];

interface Pair {
  diff: DiffResult;
  from: SnapshotRedacted;
  to: SnapshotRedacted;
  impact: { fields: string[]; matches: { file: string; line: number; field: string; text: string }[] };
}

export function ChangesTab({ id, snapshots, version }: { id: string; snapshots: SnapshotMeta[]; version: number }) {
  const [from, setFrom] = useState<string>();
  const [to, setTo] = useState<string>();
  const { data, error, reload } = useLoad<Pair>(() => call("snapshotPair", { id, from, to }), [id, from, to, version]);

  if (snapshots.length < 1) return <Empty>No responses yet. Send the request — the first successful response becomes the baseline, and later responses are compared to it.</Empty>;
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Empty>Comparing…</Empty>;
  const { diff } = data;
  const same = diff.fromId === diff.toId;

  return (
    <div className="changes">
      <div className="row gap wrap">
        <select value={diff.fromId} onChange={(e) => setFrom(e.target.value)} aria-label="Compare from">
          {snapshots.map((s) => <option key={s.id} value={s.id}>{snapLabel(s)}</option>)}
        </select>
        <span className="muted">→</span>
        <select value={diff.toId} onChange={(e) => setTo(e.target.value)} aria-label="Compare to">
          {snapshots.map((s) => <option key={s.id} value={s.id}>{snapLabel(s)}</option>)}
        </select>
        <span className="spacer" />
        {!same && (
          <>
            <button onClick={() => call("nativeDiff", { kind: "snapshot", id, from: diff.fromId, to: diff.toId })}>
              <GitCompare size={14} /> Open in editor
            </button>
            <button className="primary" onClick={() => call("tool:set_baseline", { endpointId: id, snapshotId: diff.toId }).then(() => (setFrom(undefined), setTo(undefined), reload()))}>
              Accept as baseline
            </button>
          </>
        )}
      </div>

      {same ? (
        <div className="banner ok">This response is the baseline. Future runs are compared against it.</div>
      ) : diff.changes.length === 0 ? (
        <div className="banner ok">No shape changes — the response structure matches{snapshots.find((s) => s.id === diff.fromId)?.baseline ? " the baseline" : ""}.</div>
      ) : (
        <>
          <div className="chips">
            {LEVELS.filter((l) => diff.summary[l.level]).map((l) => (
              <span key={l.level} className={`chip ${l.level}`}>
                {l.icon} {diff.summary[l.level]} {l.label.toLowerCase()}
              </span>
            ))}
          </div>
          <ul className="change-list">
            {LEVELS.flatMap((l) =>
              diff.changes
                .filter((c) => c.level === l.level)
                .map((c, i) => (
                  <li key={`${l.level}${i}`} className={c.level}>
                    {l.icon}
                    <code>{c.path}</code>
                    <span>{c.description}</span>
                  </li>
                ))
            )}
          </ul>
          {data.impact.fields.length > 0 && (
            <div className="impact">
              <h3>Code that uses changed fields</h3>
              {data.impact.matches.length === 0 ? (
                <p className="muted small">No references to {data.impact.fields.join(", ")} found in the codebase.</p>
              ) : (
                <ul>
                  {data.impact.matches.slice(0, 50).map((m, i) => (
                    <li key={i}>
                      <button className="link" onClick={() => call("openFile", { file: m.file, line: m.line })}>
                        {m.file}:{m.line}
                      </button>{" "}
                      <code className="muted">{m.text.trim().slice(0, 120)}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {!same && (
        <JsonDiff
          left={`// status ${data.from.status}\n${pretty(data.from.body)}`}
          right={`// status ${data.to.status}\n${pretty(data.to.body)}`}
          leftTitle={`${snapshots.find((s) => s.id === diff.fromId)?.baseline ? "Baseline" : "Before"} · ${new Date(data.from.timestamp).toLocaleString()}`}
          rightTitle={`After · ${new Date(data.to.timestamp).toLocaleString()}`}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function HistoryTab({ id, snapshots, shownId, show }: { id: string; snapshots: SnapshotMeta[]; shownId?: string; show: (id: string) => void }) {
  if (!snapshots.length) return <Empty>No saved responses yet.</Empty>;
  const baseline = snapshots.find((s) => s.baseline);
  return (
    <table className="history">
      <thead>
        <tr>
          <th>When</th>
          <th>Status</th>
          <th>Time</th>
          <th>Request</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {snapshots.map((s) => (
          <tr key={s.id} className={s.id === shownId ? "active" : ""}>
            <td title={s.timestamp}>{timeAgo(s.timestamp)}</td>
            <td>
              <span className={`status s${String(s.status)[0]}`}>{s.status || "ERR"}</span> {s.baseline && <span className="chip baseline">baseline</span>}
            </td>
            <td className="muted">{s.timeMs} ms</td>
            <td className="muted">{s.revision ? `v${s.revision}` : ""}</td>
            <td className="actions">
              <button className="link" onClick={() => show(s.id)}>View</button>
              {baseline && !s.baseline && (
                <button className="link" onClick={() => call("nativeDiff", { kind: "snapshot", id, from: baseline.id, to: s.id })}>Diff vs baseline</button>
              )}
              {!s.baseline && s.passed && <button className="link" onClick={() => call("tool:set_baseline", { endpointId: id, snapshotId: s.id })}>Make baseline</button>}
              {!s.baseline && <button className="link danger" onClick={() => call("tool:delete_snapshot", { endpointId: id, snapshotId: s.id })}>Delete</button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------

export function VersionsTab({ id, revisions, dirty }: { id: string; revisions: Revision[]; dirty: boolean }) {
  const latest = revisions[0]?.revision ?? 0;
  const [from, setFrom] = useState<number>();
  const [to, setTo] = useState<number>();
  const enough = revisions.length >= 2;
  const { data, error } = useLoad<{ from: Revision; to: Revision; changes: RevisionChange[] }>(
    () => (enough ? call("tool:diff_revisions", { endpointId: id, from, to }) : Promise.resolve(undefined as never)),
    [id, from, to, latest]
  );

  return (
    <div className="versions">
      <ul className="timeline">
        {revisions.map((r) => (
          <li key={r.revision}>
            <span className="chip">v{r.revision}</span>
            <span>{r.label ? <b>{r.label}</b> : null} {r.summary}</span>
            <span className="muted small">{timeAgo(r.timestamp)}</span>
            {r.revision !== latest && (
              <button className="link" disabled={dirty} title={dirty ? "Save or discard your edits first" : ""} onClick={() => call("tool:restore_revision", { endpointId: id, revision: r.revision })}>
                Restore
              </button>
            )}
          </li>
        ))}
      </ul>
      {!enough ? (
        <Empty>Every save creates a version (v1, v2, …), whether you edit here, in YAML, or your AI does. Change the request and save to see what changed.</Empty>
      ) : error ? (
        <div className="banner error">{error}</div>
      ) : data ? (
        <>
          <div className="row gap">
            <select value={data.from.revision} onChange={(e) => setFrom(Number(e.target.value))} aria-label="Compare from version">
              {revisions.map((r) => <option key={r.revision} value={r.revision}>v{r.revision}</option>)}
            </select>
            <span className="muted">→</span>
            <select value={data.to.revision} onChange={(e) => setTo(Number(e.target.value))} aria-label="Compare to version">
              {revisions.map((r) => <option key={r.revision} value={r.revision}>v{r.revision}</option>)}
            </select>
            <span className="spacer" />
            <button onClick={() => call("nativeDiff", { kind: "revision", id, from: data.from.revision, to: data.to.revision })}>
              <GitCompare size={14} /> Open in editor
            </button>
          </div>
          <ul className="change-list">
            {data.changes.map((c, i) => (
              <li key={i} className={c.change === "removed" ? "warning" : c.change === "added" ? "nonBreaking" : "info"}>
                <span className="chip">{c.change}</span>
                <code>{c.field}</code>
                <span className="muted">{c.change === "changed" ? `${short(c.from)} → ${short(c.to)}` : short(c.change === "added" ? c.to : c.from)}</span>
              </li>
            ))}
          </ul>
          <JsonDiff left={pretty(data.from.definition)} right={pretty(data.to.definition)} leftTitle={`v${data.from.revision}`} rightTitle={`v${data.to.revision}`} />
        </>
      ) : null}
    </div>
  );
}

const short = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 80 ? `${s.slice(0, 80)}…` : s ?? "";
};

// ---------------------------------------------------------------------------

export function SchemaTab({ id, version }: { id: string; version: number }) {
  const { data, error } = useLoad<ApilotSchema>(() => call("schema", { id }), [id, version]);
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Empty>Loading…</Empty>;
  return (
    <div>
      <p className="muted small">Learned from every successful response. Required = present in all of them; nullable = seen as null.</p>
      <table className="schema">
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <SchemaRows schema={data} name="(root)" depth={0} required />
        </tbody>
      </table>
    </div>
  );
}

function SchemaRows({ schema, name, depth, required }: { schema: ApilotSchema; name: string; depth: number; required: boolean }) {
  const type = schema.type === "array" ? `${schema.items?.type ?? "any"}[]` : schema.type ?? "any";
  const child = schema.type === "array" ? schema.items : schema;
  return (
    <>
      <tr>
        <td style={{ paddingLeft: 8 + depth * 16 }}>
          <code>{name}</code>
        </td>
        <td>
          <span className={`type t-${schema.type}`}>{type}</span>
          {schema.nullable && <span className="muted">?</span>}
          {schema.format && <span className="muted small"> ({schema.format})</span>}
        </td>
        <td className="muted small">
          {!required && "optional "}
          {schema.enum && `one of: ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`}
        </td>
      </tr>
      {child?.properties &&
        Object.entries(child.properties).map(([k, v]) => <SchemaRows key={k} schema={v} name={k} depth={depth + 1} required={child.required.includes(k)} />)}
    </>
  );
}

// ---------------------------------------------------------------------------

const LANGS = [
  ["dart", "Dart (Flutter)"],
  ["typescript", "TypeScript"],
  ["kotlin", "Kotlin"],
  ["swift", "Swift"],
] as const;

export function CodeTab({ id, version }: { id: string; version: number }) {
  const [language, setLanguage] = useState<string>(() => persisted.get().lang ?? "dart");
  const [flavor, setFlavor] = useState("freezed");
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [result, setResult] = useState<{ written: string[]; unchanged: string[]; skipped: string[] } | null>(null);
  const [error, setError] = useState("");
  const args = { endpointId: id, language, flavor: language === "dart" ? flavor : undefined };

  useEffect(() => {
    persisted.set({ ...persisted.get(), lang: language });
    setResult(null);
    call<{ files: { path: string; content: string }[] }>("tool:generate_code", { ...args, write: false })
      .then((r) => (setFiles(r.files), setError("")))
      .catch((e: Error) => (setFiles([]), setError(e.message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, language, flavor, version]);

  return (
    <div className="code-tab">
      <div className="row gap wrap">
        <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">
          {LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {language === "dart" && (
          <select value={flavor} onChange={(e) => setFlavor(e.target.value)} aria-label="Dart flavor">
            <option value="freezed">freezed + json_serializable</option>
            <option value="plain">plain classes</option>
          </select>
        )}
        <span className="spacer" />
        <button className="primary" disabled={!files.length} onClick={() => call("tool:generate_code", args).then(setResult, (e: Error) => setError(e.message))}>
          Write files
        </button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {result && (
        <div className="banner ok">
          {result.written.length ? <>Wrote {result.written.map((f) => <FileLink key={f} file={f} />)} </> : null}
          {result.unchanged.length ? <>Up to date: {result.unchanged.map((f) => <FileLink key={f} file={f} />)} </> : null}
          {result.skipped.length ? <>Skipped hand-written: {result.skipped.map((f) => <FileLink key={f} file={f} />)}</> : null}
        </div>
      )}
      {files.map((f) => (
        <div key={f.path} className="file">
          <div className="row file-head">
            <code>{f.path}</code>
            <span className="spacer" />
            <button className="icon" aria-label={`Copy ${f.path}`} title="Copy" onClick={() => copy(f.content)}>
              <Copy size={14} />
            </button>
          </div>
          <pre className="code">{f.content}</pre>
        </div>
      ))}
    </div>
  );
}

function FileLink({ file }: { file: string }) {
  return (
    <button className="link" onClick={() => call("openFile", { file })}>
      {file}
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty muted">{children}</div>;
}
