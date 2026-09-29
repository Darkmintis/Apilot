import { useCallback, useEffect, useState } from "react";
import { call, onHostMessage, persisted, type AppState } from "./api";
import { Sidebar } from "./components/Sidebar";
import { EndpointView } from "./components/EndpointView";
import { EnvironmentsPage, ImportPage, RunAllPage, WelcomePage } from "./components/Pages";

export type View =
  | { kind: "home" }
  | { kind: "endpoint"; id: string; tab?: string }
  | { kind: "new" }
  | { kind: "import" }
  | { kind: "environments" }
  | { kind: "runAll"; autorun?: boolean };

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setViewRaw] = useState<View>(() => persisted.get().view ?? { kind: "home" });
  const [version, setVersion] = useState(0);

  const setView = useCallback((v: View) => {
    setViewRaw(v);
    persisted.set({ ...persisted.get(), view: v });
  }, []);

  const reload = useCallback(() => {
    call<AppState>("state").then(setState).catch(() => setState({ hasProject: false, hasFolder: false }));
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    reload();
    return onHostMessage((msg) => {
      if (msg.type === "changed") reload();
      if (msg.type === "focus") {
        if (msg.endpointId) setView({ kind: "endpoint", id: msg.endpointId, tab: msg.tab });
        else if (msg.view) setView({ kind: msg.view, autorun: msg.autorun } as View);
      }
    });
  }, [reload, setView]);

  if (!state) return <div className="center muted">Loading…</div>;
  if (!state.hasProject) return <WelcomePage hasFolder={state.hasFolder} />;

  const env = state.env!;
  const changeEnv = (e: string) => call("setEnv", { env: e }).then(reload);
  const known = view.kind !== "endpoint" || state.endpoints!.some((e) => e.id === view.id);

  return (
    <div className="app">
      <Sidebar state={state} view={view} setView={setView} changeEnv={changeEnv} />
      <main className="main">
        {view.kind === "endpoint" && known && <EndpointView key={view.id} id={view.id} env={env} tab={view.tab} version={version} setView={setView} />}
        {view.kind === "new" && <EndpointView key="new" env={env} version={version} setView={setView} collections={state.collections!.map((c) => c.id)} />}
        {view.kind === "import" && <ImportPage env={env} setView={setView} />}
        {view.kind === "environments" && <EnvironmentsPage env={env} environments={state.environments!} version={version} changeEnv={changeEnv} />}
        {view.kind === "runAll" && <RunAllPage env={env} state={state} autorun={view.autorun} setView={setView} />}
        {(view.kind === "home" || !known) && <Overview state={state} setView={setView} />}
      </main>
    </div>
  );
}

function Overview({ state, setView }: { state: AppState; setView: (v: View) => void }) {
  const eps = state.endpoints!;
  const count = (s: string) => eps.filter((e) => e.health.state === s).length;
  const attention = eps.filter((e) => e.health.state === "breaking" || e.health.state === "failed" || e.health.state === "changed");
  return (
    <div className="page">
      <h1>{state.project!.name}</h1>
      <p className="muted">
        {eps.length} endpoints · environment <b>{state.env}</b>
      </p>
      <div className="stats">
        <Stat n={count("passed")} label="matching baseline" cls="ok" />
        <Stat n={count("breaking")} label="breaking changes" cls="bad" />
        <Stat n={count("changed")} label="changed (safe)" cls="info" />
        <Stat n={count("failed")} label="failing" cls="bad" />
        <Stat n={count("none")} label="never run" cls="muted" />
      </div>
      {attention.length > 0 && (
        <>
          <h2>Needs attention</h2>
          <ul className="list">
            {attention.map((e) => (
              <li key={e.id}>
                <button className="link" onClick={() => setView({ kind: "endpoint", id: e.id, tab: e.health.state === "failed" ? "response" : "changes" })}>
                  <span className={`dot ${e.health.state}`} /> <span className={`method m-${e.method}`}>{e.method}</span> {e.name}
                  <span className="muted"> — {e.health.state === "failed" ? `last run failed (${e.health.status ?? "error"})` : e.health.state === "breaking" ? "breaking response change" : "response changed"}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row gap">
        <button className="primary" onClick={() => setView({ kind: "runAll", autorun: true })}>Run all endpoints</button>
        <button onClick={() => setView({ kind: "new" })}>New endpoint</button>
        <button onClick={() => setView({ kind: "import" })}>Import</button>
      </div>
      <p className="muted small hint">
        Your AI assistant already knows Apilot: ask it to “run orders.list and update the models”, or “what breaks if this API changed?”.
      </p>
    </div>
  );
}

function Stat({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <div className={`stat ${cls}`}>
      <div className="n">{n}</div>
      <div className="label">{label}</div>
    </div>
  );
}
