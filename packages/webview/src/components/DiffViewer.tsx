import React from "react";
import { X } from "lucide-react";
import type { DiffResult } from "../types";

interface Props {
  diff: DiffResult;
  onClose: () => void;
}

const LEVEL_COLORS: Record<string, string> = {
  breaking: "status-5xx",
  warning: "status-4xx",
  nonBreaking: "status-2xx",
  info: "",
};

const LEVEL_ICON: Record<string, string> = {
  breaking: "✗",
  warning: "⚠",
  nonBreaking: "✓",
  info: "ℹ",
};

export default function DiffViewer({ diff, onClose }: Props): React.JSX.Element {
  return (
    <div className="response-viewer">
      {/* Header */}
      <div className="response-toolbar">
        <div className="header-title">
          <span>API Diff — {diff.endpointId}</span>
        </div>
        <div className="response-meta">
          <span className="status-badge status-5xx">
            {diff.summary.breaking} Breaking
          </span>
          <span className="status-badge status-4xx">
            {diff.summary.warning} Warning
          </span>
          <span className="status-badge status-2xx">
            {diff.summary.nonBreaking} Non-breaking
          </span>
        </div>
        <button className="btn btn-ghost" onClick={onClose} style={{marginLeft: "auto"}}>
          <X size={14} />
        </button>
      </div>

      {/* Changes list */}
      <div className="response-content">
        <div style={{padding: 12}}>
          {diff.changes.length === 0 ? (
            <div className="no-data">No changes detected between snapshots.</div>
          ) : (
            <div>
              {diff.changes.map((change, i) => (
                <div key={i} className="diff-change">
                  <div style={{display: "flex", gap: 8, alignItems: "center"}}>
                    <span
                      className={`status-badge ${LEVEL_COLORS[change.level]}`}
                      style={{fontSize: 10, padding: "1px 6px"}}
                    >
                      {LEVEL_ICON[change.level]} {change.level}
                    </span>
                    <span className="diff-path">{change.path}</span>
                    <span style={{color: "var(--apilot-text-secondary)"}}>
                      [{change.kind}]
                    </span>
                  </div>
                  <div style={{marginLeft: 16, marginTop: 4, color: "var(--apilot-text-secondary)"}}>
                    {change.description}
                  </div>
                  {change.fromValue !== undefined && (
                    <div style={{display: "flex", gap: 8, marginLeft: 16, marginTop: 4}}>
                      <span className="diff-removed">
                        - {JSON.stringify(change.fromValue)}
                      </span>
                    </div>
                  )}
                  {change.toValue !== undefined && (
                    <div style={{display: "flex", gap: 8, marginLeft: 16}}>
                      <span className="diff-added">
                        + {JSON.stringify(change.toValue)}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
