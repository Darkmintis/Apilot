import { useCallback, useEffect, useState } from "react";
import { Download, PanelLeft, Play, Plus } from "lucide-react";
import { call, confirm, HEALTH_LABEL, onHostMessage, persisted, unsaved, type AppState } from "./api";
import { Sidebar } from "./components/Sidebar";
import { EndpointView } from "./components/EndpointView";
import { EnvironmentsPage, ImportPage, RunAllPage, WelcomePage } from "./components/Pages";
import { Spinner } from "./components/ResultTabs";

export type View =
  | { kind: "home" }
  | { kind: "endpoint"; id: string; project?: string; tab?: string }
  | { kind: "new"; project?: string }
  | { kind: "import"; project?: string }
  | { kind: "environments"; project?: string }
  | { kind: "runAll"; project?: string; autorun?: boolean };

const sameView = (a: View, b: View) =>
  a.kind === b.kind &&
  (a.kind !== "endpoint" ||
    (a.id === (b as { id: string }).id && (a.project ?? "") === ((b as { project?: string }).project ?? "")));

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
          if (msg.endpointId) setView({ kind: "endpoint", id: msg.endpointId, project: msg.project, tab: msg.tab });
          else if (msg.view) setView({ kind: msg.view, project: msg.project, autorun: msg.autorun } as View);
        }
      }),
    [reload, setView]
  );

  if (!state) return <Spinner label="Loading Apilot…" />;
  if (!state.hasProject) return <WelcomePage hasFolder={state.hasFolder} projects={state.projects} />;

  const projects = state.projects ?? [];
  const activeProject = state.activeProject ?? projects[0]?.id ?? "";
  /** The project the user is looking at right now. */
  const viewProject = view.kind !== "home" ? view.project : undefined;
  const focusProject = viewProject ?? activeProject;
  const env = state.projectEnvs?.[focusProject]?.env ?? state.env ?? "";

  const changeEnv = (e: string) => call("setEnv", { env: e, project: focusProject }).then(reload);
  const known = view.kind !== "endpoint" || state.endpoints!.some((e) => e.id === view.id && e.project === (view.project ?? focusProject));

  return (
    <div className={`app ${navOpen ? "" : "nav-closed"}`}>
      {navOpen && <Sidebar state={state} view={view} setView={setView} changeEnv={changeEnv} onCollapse={toggleNav} project={focusProject} />}
      {navOpen && <div className="scrim" onClick={toggleNav} aria-hidden />}
      <main className="main">
        {!navOpen && (
          <button className="icon nav-toggle" title="Show endpoints" aria-label="Show endpoints" onClick={toggleNav}>
            <PanelLeft size={16} />
          </button>
        )}
        {view.kind === "endpoint" && known && (
          <EndpointView key={`${focusProject}:${view.id}`} id={view.id} project={focusProject} env={env} tab={view.tab} version={version} setView={setView} />
        )}
        {view.kind === "new" && (
          <EndpointView key="new" project={focusProject} env={env} version={version} setView={setView} collections={state.collections!.map((c) => c.id)} />
        )}
        {view.kind === "import" && <ImportPage project={focusProject} env={env} setView={setView} />}
        {view.kind === "environments" && (
          <EnvironmentsPage project={focusProject} env={env} environments={state.projectEnvs?.[focusProject]?.environments ?? state.environments ?? []} version={version} changeEnv={changeEnv} />
        )}
        {view.kind === "runAll" && <RunAllPage project={focusProject} env={env} state={state} autorun={view.autorun} setView={setView} />}
        {(view.kind === "home" || !known) && <Overview state={state} setView={setView} project={focusProject} />}
      </main>
    </div>
  );
}

function Overview({ state, setView, project }: { state: AppState; setView: (v: View) => void; project: string }) {
  const eps = state.endpoints!;
  const count = (s: string) => eps.filter((e) => e.health.state === s).length;
  const attention = eps.filter((e) => e.health.state === "breaking" || e.health.state === "failed" || e.health.state === "changed");
  const projects = state.projects ?? [];
  const multi = projects.length > 1;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{multi ? projects.find((p) => p.id === project)?.name ?? state.project!.name : state.project!.name}</h1>
          <p className="muted">
            {eps.length} endpoint{eps.length === 1 ? "" : "s"} · <span className="chip">{state.env}</span>
            {multi && <> · <span className="chip">{projects.filter((p) => p.hasApilot).length} projects</span></>}
          </p>
        </div>
        <div className="row gap-s wrap">
          <button className="primary" onClick={() => setView({ kind: "runAll", project, autorun: true })} disabled={!eps.length}>
            <Play size={14} /> Run all
          </button>
          <button onClick={() => setView({ kind: "new", project })}>
            <Plus size={14} /> New endpoint
          </button>
          <button onClick={() => setView({ kind: "import", project })}>
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
              <li key={`${e.project}:${e.id}`}>
                <button className="row-button" onClick={() => setView({ kind: "endpoint", id: e.id, project: e.project, tab: e.health.state === "failed" ? "response" : "changes" })}>
                  <span className={`dot ${e.health.state}`} />
                  <span className={`method m-${e.method}`}>{e.method}</span>
                  <span className="grow ellipsis">{e.name}</span>
                  {multi && <span className="chip">{e.project}</span>}
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
