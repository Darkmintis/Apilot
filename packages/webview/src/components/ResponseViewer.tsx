import React from "react";
import { BarChart3, Code, Clock, Database, FileJson, Hash } from "lucide-react";
import type { SnapshotRedacted, SnapshotMeta, DiffChange } from "../types";

interface Props {
  snapshot: SnapshotRedacted;
  snapshots: SnapshotMeta[];
  onDiff: () => void;
  onGenerateCode: () => void;
}

export default function ResponseViewer({
  snapshot,
  snapshots,
  onDiff,
  onGenerateCode,
}: Props): React.JSX.Element {
  const [tab, setTab] = React.useState<"json" | "raw" | "headers">("json");

  const statusClass =
    snapshot.status >= 200 && snapshot.status < 300
      ? "status-2xx"
      : snapshot.status >= 400 && snapshot.status < 500
      ? "status-4xx"
      : snapshot.status >= 500
      ? "status-5xx"
      : "";

  const renderJsonTree = (obj: unknown, path = "$"): React.JSX.Element => {
    if (obj === null) return <span style={{color: "var(--apilot-text-secondary)"}}>null</span>;
    if (typeof obj === "string") return <span style={{color: "var(--apilot-green)"}}>"{obj}"</span>;
    if (typeof obj === "number") return <span style={{color: "var(--apilot-orange)"}}>{obj}</span>;
    if (typeof obj === "boolean") return <span style={{color: "var(--apilot-accent)"}}>{String(obj)}</span>;
    if (Array.isArray(obj)) {
      return (
        <div style={{marginLeft: 16}}>
          <div style={{color: "var(--apilot-text-secondary)"}}>[</div>
          {obj.map((item, i) => (
            <div key={i} style={{marginLeft: 16, display: "flex", gap: 8}}>
              <span style={{color: "var(--apilot-text-secondary)"}}>{i}:</span>
              {renderJsonTree(item, `${path}[${i}]`)}
            </div>
          ))}
          <div style={{color: "var(--apilot-text-secondary)"}}>]</div>
        </div>
      );
    }
    if (typeof obj === "object") {
      return (
        <div style={{marginLeft: 16}}>
          <div style={{color: "var(--apilot-text-secondary)"}}>{"{"}</div>
          {Object.entries(obj as Record<string, unknown>).map(([key, val]) => (
            <div key={key} style={{marginLeft: 16, display: "flex", gap: 8}}>
              <span style={{color: "var(--apilot-green)"}}>"{key}"</span>
              <span style={{color: "var(--apilot-text-secondary)"}}>:</span>
              {renderJsonTree(val, `${path}.${key}`)}
            </div>
          ))}
          <div style={{color: "var(--apilot-text-secondary)"}}>{"}"}</div>
        </div>
      );
    }
    return <span>—</span>;
  };

  return (
    <div className="response-viewer">
      {/* Response toolbar */}
      <div className="response-toolbar">
        <span className={`status-badge ${statusClass}`}>
          {snapshot.status}
        </span>
        <div className="response-meta">
          <span>
            <Clock size={12} style={{marginRight: 4}} />
            {snapshot.timeMs}ms
          </span>
          <span>
            <Database size={12} style={{marginRight: 4}} />
            {formatSize(snapshot.size)}
          </span>
          <span>
            <Hash size={12} style={{marginRight: 4}} />
            {snapshot.passed ? "Passed" : "Failed"}
          </span>
        </div>
        <div style={{marginLeft: "auto", display: "flex", gap: 8}}>
          {snapshots.length > 0 && (
            <button className="btn btn-ghost" onClick={onDiff}>
              Diff
            </button>
          )}
          <button className="btn btn-ghost" onClick={onGenerateCode}>
            Generate Code
          </button>
        </div>
      </div>

      {/* Response tabs */}
      <div className="response-tabs">
        <div
          className={`tab ${tab === "json" ? "active" : ""}`}
          onClick={() => setTab("json")}
        >
          <FileJson size={14} style={{marginRight: 4}} />
          JSON
        </div>
        <div
          className={`tab ${tab === "raw" ? "active" : ""}`}
          onClick={() => setTab("raw")}
        >
          <Code size={14} style={{marginRight: 4}} />
          Raw
        </div>
        <div
          className={`tab ${tab === "headers" ? "active" : ""}`}
          onClick={() => setTab("headers")}
        >
          <BarChart3 size={14} style={{marginRight: 4}} />
          Headers
        </div>
      </div>

      {/* Tab content */}
      <div className="response-content">
        {tab === "json" && (
          <div className="json-tree">
            {typeof snapshot.body === "object" && snapshot.body !== null
              ? renderJsonTree(snapshot.body)
              : JSON.stringify(snapshot.body, null, 2)}
          </div>
        )}
        {tab === "raw" && (
          <pre
            style={{
              fontFamily: "var(--apilot-font-mono)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {JSON.stringify(snapshot.body, null, 2)}
          </pre>
        )}
        {tab === "headers" && (
          <div>
            <div style={{marginBottom: 8, fontWeight: 600}}>Request Headers</div>
            {Object.entries(snapshot.request.headers).map(([k, v]) => (
              <div key={k} style={{display: "flex", gap: 8, marginBottom: 4}}>
                <span style={{color: "var(--apilot-green)", minWidth: 120}}>{k}:</span>
                <span style={{color: "var(--apilot-text-secondary)"}}>{v}</span>
              </div>
            ))}
            <div style={{marginTop: 16, marginBottom: 8, fontWeight: 600}}>Response Headers</div>
            {Object.entries(snapshot.headers).map(([k, v]) => (
              <div key={k} style={{display: "flex", gap: 8, marginBottom: 4}}>
                <span style={{color: "var(--apilot-green)", minWidth: 120}}>{k}:</span>
                <span style={{color: "var(--apilot-text-secondary)"}}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
