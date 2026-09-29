import { useEffect, useRef, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { call, type AppState } from "../api";
import type { View } from "../App";
import { Empty } from "./ResultTabs";

interface Variable {
  name: string;
  type: "text" | "secret";
  value?: string;
  hasValue?: boolean;
}

export function WelcomePage({ hasFolder }: { hasFolder: boolean }) {
  return (
    <div className="page welcome">
      <h1>Apilot</h1>
      <p>Keep your API requests and their real responses in this repo, next to the code that uses them.</p>
      <ul className="features">
        <li><b>Response diffs with alerts</b>: every response is saved (secrets redacted) and compared to a baseline. Breaking changes are flagged, along with the lines of code they affect.</li>
        <li><b>Versions</b>: every edit to a request is recorded as v1, v2, … with a GitHub-style diff and one-click restore.</li>
        <li><b>Typed models</b>: generate Dart, TypeScript, Kotlin, or Swift from real responses.</li>
        <li><b>AI that knows your API</b>: Cursor, Claude Code, and Copilot get Apilot skills and tools automatically. Secret values never reach them.</li>
      </ul>
      {hasFolder ? (
        <button className="primary" onClick={() => call("init")}>Initialize Apilot in this project</button>
      ) : (
        <p className="muted">Open a folder to get started.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function EnvironmentsPage({ env, environments, version, changeEnv }: { env: string; environments: string[]; version: number; changeEnv: (e: string) => void }) {
  const [vars, setVars] = useState<Variable[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newVar, setNewVar] = useState<{ name: string; type: "text" | "secret"; value: string }>({ name: "", type: "text", value: "" });
  const [newEnv, setNewEnv] = useState("");

  const load = () => call<{ variables: Variable[] }>("variables", { env }).then((r) => setVars(r.variables), (e: Error) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, version]);

  const act = async (p: Promise<unknown>, msg?: string) => {
    try {
      await p;
      setError("");
      if (msg) setNotice(msg);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const add = async () => {
    const name = newVar.name.trim();
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) return setError("Variable names start with a letter or _ and contain letters, digits, _ . -");
    if (newVar.type === "secret") {
      await act(call("tool:set_variable", { env, name, type: "secret" }));
      if (newVar.value) await act(call("setSecret", { env, name, value: newVar.value }), `${name} saved to your keychain.`);
    } else {
      await act(call("tool:set_variable", { env, name, type: "text", value: newVar.value }));
    }
    setNewVar({ name: "", type: newVar.type, value: "" });
  };

  const missing = vars.filter((v) => v.type === "secret" && !v.hasValue);

  return (
    <div className="page">
      <h1>Environments</h1>
      <div className="row gap wrap">
        <div className="seg" role="tablist">
          {environments.map((e) => (
            <button key={e} role="tab" aria-selected={e === env} className={e === env ? "active" : ""} onClick={() => changeEnv(e)}>
              {e}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <input value={newEnv} placeholder="new environment, e.g. staging" onChange={(e) => setNewEnv(e.target.value)} aria-label="New environment name" />
        <button disabled={!newEnv.trim()} onClick={() => act(call("tool:create_environment", { name: newEnv.trim(), copyFrom: env }), `Created ${newEnv} (copied from ${env}; secret values are not copied).`).then(() => setNewEnv(""))}>
          Add environment
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      {missing.length > 0 && <div className="banner warn">Missing secret values in “{env}”: {missing.map((m) => m.name).join(", ")}. Requests that use them will ask for them.</div>}

      <table className="vars">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Value</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {vars.map((v) => (
            <VariableRow key={`${env}:${v.name}`} env={env} v={v} act={act} />
          ))}
          <tr className="new">
            <td>
              <input value={newVar.name} placeholder="name" onChange={(e) => setNewVar({ ...newVar, name: e.target.value })} aria-label="New variable name" />
            </td>
            <td>
              <select value={newVar.type} onChange={(e) => setNewVar({ ...newVar, type: e.target.value as "text" | "secret" })} aria-label="New variable type">
                <option value="text">text</option>
                <option value="secret">secret</option>
              </select>
            </td>
            <td>
              <input
                type={newVar.type === "secret" ? "password" : "text"}
                value={newVar.value}
                placeholder={newVar.type === "secret" ? "stored in OS keychain" : "value"}
                onChange={(e) => setNewVar({ ...newVar, value: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && add()}
                aria-label="New variable value"
              />
            </td>
            <td>
              <button disabled={!newVar.name.trim()} onClick={add}>Add</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        Text variables live in <code>.apilot/environments/{env}.yaml</code> and are committed. Secret values live only in your OS keychain. In CI, set <code>APILOT_SECRET_&lt;name&gt;</code>. Your AI can declare secrets, but it can never read or set their values.
      </p>
    </div>
  );
}

function VariableRow({ env, v, act }: { env: string; v: Variable; act: (p: Promise<unknown>, msg?: string) => Promise<void> }) {
  const [value, setValue] = useState(v.value ?? "");
  const [secret, setSecret] = useState("");
  const saved = useRef(v.value ?? "");
  useEffect(() => {
    setValue(v.value ?? "");
    saved.current = v.value ?? "";
  }, [v.value]);

  return (
    <tr>
      <td>
        <code>{v.name}</code>
      </td>
      <td>{v.type === "secret" ? <span className="chip"><KeyRound size={11} /> secret</span> : "text"}</td>
      <td>
        {v.type === "text" ? (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => value !== saved.current && act(call("tool:set_variable", { env, name: v.name, type: "text", value }))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            spellCheck={false}
            aria-label={`${v.name} value`}
          />
        ) : (
          <div className="row gap-s">
            <span className={`dot ${v.hasValue ? "passed" : "failed"}`} />
            <input type="password" value={secret} placeholder={v.hasValue ? "•••••••• (set; type to replace)" : "not set"} onChange={(e) => setSecret(e.target.value)} aria-label={`${v.name} secret value`} />
            <button disabled={!secret} onClick={() => act(call("setSecret", { env, name: v.name, value: secret }), `${v.name} saved to your keychain.`).then(() => setSecret(""))}>
              Save
            </button>
          </div>
        )}
      </td>
      <td>
        <button className="icon danger" aria-label={`Delete ${v.name}`} title="Delete variable" onClick={() => act(call("tool:delete_variable", { env, name: v.name }))}>
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------

export function ImportPage({ env, setView }: { env: string; setView: (v: View) => void }) {
  const [source, setSource] = useState<"curl" | "postman" | "openapi">("curl");
  const [content, setContent] = useState("");
  const [collection, setCollection] = useState("");
  const [result, setResult] = useState<{ created: string[]; notes: string[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const onFile = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    setContent(text);
    if (/"_postman_id"|schema\.getpostman\.com/.test(text)) setSource("postman");
    else if (/openapi|swagger/i.test(text.slice(0, 500))) setSource("openapi");
  };

  const run = async () => {
    setBusy(true);
    try {
      setResult(await call("tool:import_spec", { source, content, collection: collection || undefined, env }));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>Import</h1>
      <div className="row gap wrap">
        <div className="seg" role="tablist">
          {(["curl", "postman", "openapi"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={source === s} className={source === s ? "active" : ""} onClick={() => setSource(s)}>
              {s === "curl" ? "cURL" : s === "postman" ? "Postman" : "OpenAPI / Swagger"}
            </button>
          ))}
        </div>
        <label className="button">
          Choose file…
          <input type="file" accept=".json,.yaml,.yml,.txt,.sh" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        <input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="collection (optional)" aria-label="Target collection" />
      </div>
      <textarea
        className="code"
        rows={14}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        placeholder={source === "curl" ? "curl https://api.example.com/orders -H 'Authorization: Bearer …'" : "Paste the collection / spec JSON or YAML"}
        aria-label="Import content"
      />
      <p className="muted small">Tokens, passwords, and API keys found in the import are saved to your keychain as secret variables for “{env}”. They are never written to files.</p>
      <button className="primary" disabled={!content.trim() || busy} onClick={run}>{busy ? "Importing…" : "Import"}</button>
      {error && <div className="banner error">{error}</div>}
      {result && (
        <div className="banner ok">
          <div>Created {result.created.length} endpoint{result.created.length === 1 ? "" : "s"}:</div>
          <ul>
            {result.created.map((id) => (
              <li key={id}>
                <button className="link" onClick={() => setView({ kind: "endpoint", id })}>{id}</button>
              </li>
            ))}
          </ul>
          {result.notes.map((n, i) => <div key={i} className="muted small">{n}</div>)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface RunAllResult {
  env: string;
  passed: number;
  failed: number;
  breaking: number;
  results: { endpointId: string; name: string; method: string; status?: number; timeMs?: number; passed: boolean; breaking: boolean; error?: string }[];
}

export function RunAllPage({ env, state, autorun, setView }: { env: string; state: AppState; autorun?: boolean; setView: (v: View) => void }) {
  const [collection, setCollection] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunAllResult | null>(null);
  const [error, setError] = useState("");
  const started = useRef(false);

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await call("tool:run_collection", { collectionId: collection || undefined, env }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autorun && !started.current) {
      started.current = true;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autorun]);

  return (
    <div className="page">
      <h1>Run all</h1>
      <div className="row gap">
        <select value={collection} onChange={(e) => setCollection(e.target.value)} aria-label="Collection">
          <option value="">All collections</option>
          {state.collections!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span className="muted">in “{env}”</span>
        <button className="primary" disabled={busy} onClick={run}>{busy ? "Running…" : "Run"}</button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {!result && !busy && <Empty>Runs endpoints in order, passing chained values along, and compares each response to its baseline.</Empty>}
      {result && (
        <>
          <div className="stats">
            <div className="stat ok"><div className="n">{result.passed}</div><div className="label">passed</div></div>
            <div className="stat bad"><div className="n">{result.failed}</div><div className="label">failed</div></div>
            <div className="stat bad"><div className="n">{result.breaking}</div><div className="label">breaking</div></div>
          </div>
          <table className="history">
            <thead>
              <tr><th>Endpoint</th><th>Status</th><th>Time</th><th>Result</th></tr>
            </thead>
            <tbody>
              {result.results.map((r) => (
                <tr key={r.endpointId} className="clickable" onClick={() => setView({ kind: "endpoint", id: r.endpointId, tab: r.breaking ? "changes" : "response" })}>
                  <td><span className={`method m-${r.method}`}>{r.method}</span> {r.name}</td>
                  <td>{r.status ? <span className={`status s${String(r.status)[0]}`}>{r.status}</span> : "—"}</td>
                  <td className="muted">{r.timeMs != null ? `${r.timeMs} ms` : ""}</td>
                  <td>
                    {r.error ? <span className="bad-t">{r.error}</span> : r.breaking ? <span className="chip breaking">breaking change</span> : r.passed ? <span className="ok-t">passed</span> : <span className="bad-t">failed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
