import { useState } from "react";
import { ChevronDown, ChevronRight, Download, FolderPlus, KeyRound, LayoutDashboard, PanelLeftClose, Play, Plus, Search } from "lucide-react";
import { call, HEALTH_LABEL, type AppState } from "../api";
import type { View } from "../App";

interface Endpoint {
  id: string;
  collectionId: string;
  name: string;
  method: string;
  url: string;
  project: string;
  health: { status?: number; state: "none" | "passed" | "failed" | "breaking" | "changed" };
}

export function Sidebar({
  state,
  view,
  setView,
  changeEnv,
  onCollapse,
  project,
}: {
  state: AppState;
  view: View;
  setView: (v: View) => void;
  changeEnv: (e: string) => void;
  onCollapse: () => void;
  project: string;
}) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [closedProjects, setClosedProjects] = useState<Set<string>>(new Set());
  const needle = q.toLowerCase();
  const eps = (state.endpoints ?? []).filter((e) => !needle || `${e.name} ${e.url} ${e.id}`.toLowerCase().includes(needle));
  const projects = state.projects ?? [];
  const multi = projects.length > 1;
  const name = (id: string) => state.collections!.find((c) => c.id === id)?.name ?? (id || "Endpoints");
  const toggle = (id: string) => setClosed((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))));
  const toggleProject = (id: string) => setClosedProjects((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))));
  const nav = (kind: View["kind"], label: string, icon: JSX.Element) => (
    <button className="icon" title={label} aria-label={label} aria-pressed={view.kind === kind} onClick={() => setView({ kind } as View)}>
      {icon}
    </button>
  );

  /** Endpoint rows for one project, grouped by collection. */
  const collectionsOf = (list: Endpoint[]) => {
    const groups = [...new Set(list.map((e) => e.collectionId))];
    return groups.map((g) => {
      const items = list.filter((e) => e.collectionId === g);
      return (
        <div key={g} role="group" aria-label={name(g)}>
          <button className="group" onClick={() => toggle(g)} aria-expanded={!closed.has(g)}>
            {closed.has(g) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            <span className="ellipsis">{name(g)}</span>
            <span className="spacer" />
            <span className="count">{items.length}</span>
          </button>
          {!closed.has(g) &&
            items.map((e) => {
              const active = view.kind === "endpoint" && view.id === e.id && (view.project ?? project) === e.project;
              return (
                <button
                  key={`${e.project}:${e.id}`}
                  className={`ep ${active ? "active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setView({ kind: "endpoint", id: e.id, project: e.project })}
                  title={`${e.method} ${e.url}\n${HEALTH_LABEL[e.health.state]}${e.health.status ? ` · ${e.health.status}` : ""}`}
                >
                  <span className={`method m-${e.method}`}>{e.method}</span>
                  <span className="ep-name">{e.name}</span>
                  <span className={`dot ${e.health.state}`} aria-label={HEALTH_LABEL[e.health.state]} />
                </button>
              );
            })}
        </div>
      );
    });
  };

  return (
    <aside className="sidebar" aria-label="Endpoints">
      <div className="side-title">
        <span className="ellipsis" title={state.project?.name}>{multi ? "Apilot" : state.project?.name ?? "Apilot"}</span>
        <span className="spacer" />
        {nav("home", "Overview", <LayoutDashboard size={15} />)}
        {nav("new", "New endpoint", <Plus size={15} />)}
        {nav("import", "Import cURL / Postman / OpenAPI", <Download size={15} />)}
        {nav("runAll", "Run all", <Play size={15} />)}
        <button className="icon" title="Hide sidebar" aria-label="Hide sidebar" onClick={onCollapse}>
          <PanelLeftClose size={15} />
        </button>
      </div>
      <div className="sidebar-top">
        <div className="row gap-s">
          <select className="grow" value={state.env ?? ""} onChange={(e) => changeEnv(e.target.value)} aria-label="Environment" title="Environment">
            {(state.projectEnvs?.[project]?.environments ?? state.environments ?? []).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          {nav("environments", "Environments & secrets", <KeyRound size={15} />)}
        </div>
        <div className="search">
          <Search size={13} aria-hidden />
          <input type="search" placeholder="Filter endpoints" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter endpoints" />
        </div>
      </div>
      <nav className="tree">
        {multi
          ? projects.map((p) => {
              const list = eps.filter((e) => e.project === p.id);
              if (!p.hasApilot) {
                return (
                  <div key={p.id} role="group" aria-label={p.name}>
                    <button className="group" onClick={() => call("init", { project: p.id })} title={`Initialize Apilot in ${p.root}`}>
                      <FolderPlus size={14} />
                      <span className="ellipsis">{p.name}</span>
                      <span className="spacer" />
                      <span className="chip">init</span>
                    </button>
                  </div>
                );
              }
              return (
                <div key={p.id} role="group" aria-label={p.name}>
                  <button className="group" onClick={() => toggleProject(p.id)} aria-expanded={!closedProjects.has(p.id)}>
                    {closedProjects.has(p.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span className="ellipsis">{p.name}</span>
                    <span className="spacer" />
                    <span className="count">{list.length}</span>
                  </button>
                  {!closedProjects.has(p.id) && collectionsOf(list)}
                </div>
              );
            })
          : collectionsOf(eps)}
        {!eps.length && !multi && (
          <div className="side-empty">
            {q ? (
              <p className="muted small">No endpoints match “{q}”.</p>
            ) : (
              <>
                <p className="muted small">No endpoints yet.</p>
                <button className="primary" onClick={() => setView({ kind: "new" })}>
                  <Plus size={14} /> New endpoint
                </button>
                <button onClick={() => setView({ kind: "import" })}>
                  <Download size={14} /> Import
                </button>
              </>
            )}
          </div>
        )}
      </nav>
    </aside>
  );
}
