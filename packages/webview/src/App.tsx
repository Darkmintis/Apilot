import { useCallback, useEffect, useState } from "react";
import { Download, PanelLeft, Play, Plus } from "lucide-react";
import { call, confirm, HEALTH_LABEL, onHostMessage, persisted, unsaved, type AppState } from "./api";
import { Sidebar } from "./components/Sidebar";
import { EndpointView } from "./components/EndpointView";
import { EnvironmentsPage, ImportPage, RunAllPage, WelcomePage } from "./components/Pages";
import { Spinner } from "./components/ResultTabs";

export type View =
  | { kind: "home" }
  | { kind: "endpoint"; id: string; tab?: string }
  | { kind: "new" }
  | { kind: "import" }
  | { kind: "environments" }
  | { kind: "runAll"; autorun?: boolean };

const sameView = (a: View, b: View) => a.kind === b.kind && (a.kind !== "endpoint" || a.id === (b as { id: string }).id);

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setViewRaw] = useState<View>(() => persisted.get().view ?? { kind: "home" });
  const [navOpen, setNavOpen] = useState<boolean>(() => persisted.get().navOpen ?? window.innerWidth > 560);
  const [version, setVersion] = useState(0);

  const setView = useCallback(
    async (v: View) => {
      if (unsaved.current && !sameView(v, view) && !(await confirm("Discard unsaved changes?", "Discard", "Your edits to this endpoint haven't been saved."))) return;
      unsaved.current = false;
      setViewRaw(v);
      persisted.set({ ...persisted.get(), view: v });
      if (window.innerWidth <= 560) setNavOpen(false);
    },
    [view]
  );

  const toggleNav = () => {
    setNavOpen(!navOpen);
    persisted.set({ ...persisted.get(), navOpen: !navOpen });
  };

  const reload = useCallback(() => {
    call<AppState>("state").then(setState).catch(() => setState({ hasProject: false, hasFolder: false }));
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => reload(), [reload]);
  useEffect(
    () =>
      onHostMessage((msg) => {
        if (msg.type === "changed") reload();
        if (msg.type === "focus") {
          if (msg.endpointId) setView({ kind: "endpoint", id: msg.endpointId, tab: msg.tab });
          else if (msg.view) setView({ kind: msg.view, autorun: msg.autorun } as View);
        }
      }),
    [reload, setView]
  );

  if (!state) return <Spinner label="Loading Apilot…" />;
  if (!state.hasProject) return <WelcomePage hasFolder={state.hasFolder} />;

  const env = state.env!;
  const changeEnv = (e: string) => call("setEnv", { env: e }).then(reload);
  const known = view.kind !== "endpoint" || state.endpoints!.some((e) => e.id === view.id);

  return (
    <div className={`app ${navOpen ? "" : "nav-closed"}`}>
      {navOpen && <Sidebar state={state} view={view} setView={setView} changeEnv={changeEnv} onCollapse={toggleNav} />}
      {navOpen && <div className="scrim" onClick={toggleNav} aria-hidden />}
      <main className="main">
        {!navOpen && (
          <button className="icon nav-toggle" title="Show endpoints" aria-label="Show endpoints" onClick={toggleNav}>
            <PanelLeft size={16} />
          </button>
        )}
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
      <header className="page-head">
        <div>
          <h1>{state.project!.name}</h1>
          <p className="muted">
            {eps.length} endpoint{eps.length === 1 ? "" : "s"} · <span className="chip">{state.env}</span>
          </p>
        </div>
        <div className="row gap-s wrap">
          <button className="primary" onClick={() => setView({ kind: "runAll", autorun: true })} disabled={!eps.length}>
            <Play size={14} /> Run all
          </button>
          <button onClick={() => setView({ kind: "new" })}>
            <Plus size={14} /> New endpoint
          </button>
          <button onClick={() => setView({ kind: "import" })}>
            <Download size={14} /> Import
          </button>
        </div>
      </header>
      <div className="stats">
        <Stat n={count("passed")} label={HEALTH_LABEL.passed} cls="passed" />
        <Stat n={count("breaking")} label="Breaking changes" cls="breaking" />
        <Stat n={count("changed")} label={HEALTH_LABEL.changed} cls="changed" />
        <Stat n={count("failed")} label="Failing" cls="failed" />
        <Stat n={count("none")} label={HEALTH_LABEL.none} cls="none" />
      </div>
      <section className="card">
        <h2>Needs attention</h2>
        {attention.length === 0 ? (
          <p className="muted small">
            {!eps.length
              ? "No endpoints yet. Create one or import from cURL, Postman, or OpenAPI."
              : count("none") === eps.length
                ? "Nothing has run yet. Run all to record baselines; later runs are compared against them."
                : `Nothing needs attention.${count("none") ? ` ${count("none")} endpoint${count("none") === 1 ? " has" : "s have"} never run.` : ""}`}
          </p>
        ) : (
          <ul className="list">
            {attention.map((e) => (
              <li key={e.id}>
                <button className="row-button" onClick={() => setView({ kind: "endpoint", id: e.id, tab: e.health.state === "failed" ? "response" : "changes" })}>
                  <span className={`dot ${e.health.state}`} />
                  <span className={`method m-${e.method}`}>{e.method}</span>
                  <span className="grow ellipsis">{e.name}</span>
                  <span className={`chip ${e.health.state}`}>{e.health.state === "failed" ? `failed${e.health.status ? ` · ${e.health.status}` : ""}` : HEALTH_LABEL[e.health.state]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="muted small hint">
        Your AI assistant already knows Apilot. Ask it to “run orders.list and update the models”, or “what breaks if this API changed?”.
      </p>
    </div>
  );
}

function Stat({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <div className={`stat ${cls} ${n ? "" : "zero"}`}>
      <div className="n">{n}</div>
      <div className="label">{label}</div>
    </div>
  );
}
