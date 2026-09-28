import React from "react";
import type { EnvironmentFile } from "../types";

interface Props {
  env: EnvironmentFile | null;
  onChange: (env: EnvironmentFile) => void;
}

export default function EnvironmentsPanel({
  env,
  onChange,
}: Props): React.JSX.Element {
  if (!env) {
    return (
      <div className="section">
        <div className="section-title">Environment</div>
        <div className="no-data">Select an environment to view variables.</div>
      </div>
    );
  }

  return (
    <div className="section">
      <div className="section-title">Environment: {env.name}</div>
      {Object.entries(env.variables).map(([name, def]) => (
        <div key={name} className="key-value-editor" style={{gridTemplateColumns: "80px 1fr 80px auto"}}>
          <input type="text" value={name} readOnly />
          <input type="text" value={def.type} readOnly style={{maxWidth: 80}} />
          {def.type === "text" ? (
            <input
              type="text"
              placeholder="Value"
              value={def.value ?? ""}
              onChange={(e) => {
                const updated = { ...env };
                updated.variables[name] = { ...def, value: e.target.value };
                onChange(updated);
              }}
            />
          ) : (
            <input
              type="password"
              placeholder="••••••••"
              readOnly
              style={{fontFamily: "monospace"}}
            />
          )}
          <span style={{color: "var(--apilot-text-secondary)", fontSize: 11}}>
            {def.type}
          </span>
        </div>
      ))}
    </div>
  );
}
