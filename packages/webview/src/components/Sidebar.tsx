import { useState } from "react";
import { ChevronDown, ChevronRight, Download, KeyRound, LayoutDashboard, PanelLeftClose, Play, Plus, Search } from "lucide-react";
import { HEALTH_LABEL, type AppState } from "../api";
import type { View } from "../App";

export function Sidebar({ state, view, setView, changeEnv, onCollapse }: { state: AppState; view: View; setView: (v: View) => void; changeEnv: (e: string) => void; onCollapse: () => void }) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const needle = q.toLowerCase();
  const eps = state.endpoints!.filter((e) => !needle || `${e.name} ${e.url} ${e.id}`.toLowerCase().includes(needle));
  const groups = [...new Set(eps.map((e) => e.collectionId))];
  const name = (id: string) => state.collections!.find((c) => c.id === id)?.name ?? (id || "Endpoints");
  const toggle = (id: string) => setClosed((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))));
  const nav = (kind: View["kind"], label: string, icon: JSX.Element) => (
    <button className={`icon ${view.kind === kind ? "selected" : ""}`} title={label} aria-label={label} aria-pressed={view.kind === kind} onClick={() => setView({ kind } as View)}>
      {icon}
    </button>
  );

  return (
    <aside className="sidebar" aria-label="Endpoints">
      <div className="side-title">
        <span className="ellipsis" title={state.project?.name}>{state.project?.name ?? "Apilot"}</span>
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
          <select className="grow" value={state.env} onChange={(e) => changeEnv(e.target.value)} aria-label="Environment" title="Environment">
            {state.environments!.map((n) => (
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
        {groups.map((g) => (
          <div key={g} role="group" aria-label={name(g)}>
            <button className="group" onClick={() => toggle(g)} aria-expanded={!closed.has(g)}>
              {closed.has(g) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <span className="ellipsis">{name(g)}</span>
              <span className="spacer" />
              <span className="count">{eps.filter((e) => e.collectionId === g).length}</span>
            </button>
            {!closed.has(g) &&
              eps
                .filter((e) => e.collectionId === g)
                .map((e) => {
                  const active = view.kind === "endpoint" && view.id === e.id;
                  return (
                    <button
                      key={e.id}
                      className={`ep ${active ? "active" : ""}`}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setView({ kind: "endpoint", id: e.id })}
                      title={`${e.method} ${e.url}\n${HEALTH_LABEL[e.health.state]}${e.health.status ? ` · ${e.health.status}` : ""}`}
                    >
                      <span className={`method m-${e.method}`}>{e.method}</span>
                      <span className="ep-name">{e.name}</span>
                      <span className={`dot ${e.health.state}`} aria-label={HEALTH_LABEL[e.health.state]} />
                    </button>
                  );
                })}
          </div>
        ))}
        {!eps.length && (
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
