import { useState } from "react";
import { ChevronDown, ChevronRight, Download, KeyRound, LayoutDashboard, Play, Plus } from "lucide-react";
import type { AppState } from "../api";
import type { View } from "../App";

export function Sidebar({ state, view, setView, changeEnv }: { state: AppState; view: View; setView: (v: View) => void; changeEnv: (e: string) => void }) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const needle = q.toLowerCase();
  const eps = state.endpoints!.filter((e) => !needle || `${e.name} ${e.url} ${e.id}`.toLowerCase().includes(needle));
  const groups = [...new Set(eps.map((e) => e.collectionId))];
  const name = (id: string) => state.collections!.find((c) => c.id === id)?.name ?? (id || "Endpoints");
  const toggle = (id: string) => setClosed((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))));

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <label className="env">
          <span className="muted small">Environment</span>
          <div className="row">
            <select value={state.env} onChange={(e) => changeEnv(e.target.value)} aria-label="Environment">
              {state.environments!.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <button className="icon" title="Environments & secrets" aria-label="Environments & secrets" onClick={() => setView({ kind: "environments" })}>
              <KeyRound size={14} />
            </button>
          </div>
        </label>
        <input type="search" placeholder="Filter endpoints" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter endpoints" />
        <div className="row gap-s">
          <button className="icon" title="Overview" aria-label="Overview" onClick={() => setView({ kind: "home" })}>
            <LayoutDashboard size={14} />
          </button>
          <button className="icon" title="New endpoint" aria-label="New endpoint" onClick={() => setView({ kind: "new" })}>
            <Plus size={14} />
          </button>
          <button className="icon" title="Import cURL / Postman / OpenAPI" aria-label="Import" onClick={() => setView({ kind: "import" })}>
            <Download size={14} />
          </button>
          <button className="icon" title="Run all" aria-label="Run all" onClick={() => setView({ kind: "runAll" })}>
            <Play size={14} />
          </button>
        </div>
      </div>
      <nav className="tree">
        {groups.map((g) => (
          <div key={g}>
            <button className="group" onClick={() => toggle(g)} aria-expanded={!closed.has(g)}>
              {closed.has(g) ? <ChevronRight size={13} /> : <ChevronDown size={13} />} {name(g)}
            </button>
            {!closed.has(g) &&
              eps
                .filter((e) => e.collectionId === g)
                .map((e) => (
                  <button
                    key={e.id}
                    className={`ep ${view.kind === "endpoint" && view.id === e.id ? "active" : ""}`}
                    onClick={() => setView({ kind: "endpoint", id: e.id })}
                    title={`${e.method} ${e.url}`}
                  >
                    <span className={`dot ${e.health.state}`} title={e.health.state} />
                    <span className={`method m-${e.method}`}>{e.method}</span>
                    <span className="ep-name">{e.name}</span>
                  </button>
                ))}
          </div>
        ))}
        {!eps.length && <p className="muted small pad">{q ? "No matches." : "No endpoints yet."}</p>}
      </nav>
    </aside>
  );
}
