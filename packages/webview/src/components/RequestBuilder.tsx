import React from "react";
import { Send, Play } from "lucide-react";
import type { EndpointEntry } from "../types";

interface Props {
  endpoint: EndpointEntry | null;
  envName: string;
  activeTab: "params" | "auth" | "body";
  setActiveTab: (tab: "params" | "auth" | "body") => void;
  isRunning: boolean;
  onRun: () => void;
  onLoadSnapshots: () => void;
}

export default function RequestBuilder({
  endpoint,
  envName,
  activeTab,
  setActiveTab,
  isRunning,
  onRun,
  onLoadSnapshots,
}: Props): React.JSX.Element {
  const [method, setMethod] = React.useState("GET");
  const [url, setUrl] = React.useState("");
  const [query, setQuery] = React.useState<Array<{ key: string; value: string }>>([]);
  const [headers, setHeaders] = React.useState<Array<{ key: string; value: string }>>([]);
  const [body, setBody] = React.useState("");

  // When endpoint changes, prefill the form
  React.useEffect(() => {
    if (endpoint) {
      setMethod(endpoint.method);
      setUrl(endpoint.url);
      setQuery([]);
      setHeaders([]);
      setBody("");
    }
  }, [endpoint]);

  const addRow = (setter: React.Dispatch<React.SetStateAction<Array<{key: string; value: string}>>>) => {
    setter((prev) => [...prev, { key: "", value: "" }]);
  };

  const removeRow = (
    setter: React.Dispatch<React.SetStateAction<Array<{key: string; value: string}>>>,
    index: number
  ) => {
    setter((prev) => prev.filter((_, i) => i !== index));
  };

  const updateRow = (
    setter: React.Dispatch<React.SetStateAction<Array<{key: string; value: string}>>>,
    index: number,
    field: "key" | "value",
    value: string
  ) => {
    setter((prev) =>
      prev.map((row, i) =>
        i === index ? { ...row, [field]: value } : row
      )
    );
  };

  if (!endpoint) {
    return (
      <div className="request-builder">
        <div className="header">
          <div className="header-title">
            <span>No endpoint selected</span>
          </div>
          <div className="header-actions">
            <span className="env-badge">{envName || "No env"}</span>
          </div>
        </div>
        <div className="no-data">
          Select an endpoint from the sidebar to start editing requests.
        </div>
      </div>
    );
  }

  return (
    <div className="request-builder">
      {/* Top bar */}
      <div className="header">
        <div className="header-title">
          <span>{endpoint.name}</span>
        </div>
        <div className="header-actions">
          <span className="env-badge">{envName || "No env"}</span>
          <button
            className="btn btn-ghost"
            onClick={onLoadSnapshots}
            title="Load snapshots"
          >
            History
          </button>
          <button
            className="btn btn-primary"
            onClick={onRun}
            disabled={isRunning}
            style={{ minWidth: 100 }}
          >
            {isRunning ? (
              <>⋯ Running</>
            ) : (
              <>
                <Play size={14} /> Run
              </>
            )}
          </button>
        </div>
      </div>

      {/* Method + URL */}
      <div className="request-row">
        <select
          className="method-select"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        >
          {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(
            (m) => (
              <option key={m} value={m}>
                {m}
              </option>
            )
          )}
        </select>

        <input
          className="url-input"
          type="url"
          placeholder="https://api.example.com/endpoint"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      {/* Tabs */}
      <div className="tabs">
        <div
          className={`tab ${activeTab === "params" ? "active" : ""}`}
          onClick={() => setActiveTab("params")}
        >
          Query Params
        </div>
        <div
          className={`tab ${activeTab === "auth" ? "active" : ""}`}
          onClick={() => setActiveTab("auth")}
        >
          Auth & Headers
        </div>
        <div
          className={`tab ${activeTab === "body" ? "active" : ""}`}
          onClick={() => setActiveTab("body")}
        >
          Body
        </div>
      </div>

      {/* Tab content */}
      <div className="tab-content">
        {activeTab === "params" && (
          <>
            {query.map((row, i) => (
              <div key={i} className="key-value-editor">
                <input
                  type="text"
                  placeholder="Key"
                  value={row.key}
                  onChange={(e) => updateRow(setQuery, i, "key", e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Value"
                  value={row.value}
                  onChange={(e) =>
                    updateRow(setQuery, i, "value", e.target.value)
                  }
                />
                <button
                  className="remove-btn"
                  onClick={() => removeRow(setQuery, i)}
                >
                  ×
                </button>
              </div>
            ))}
            <button className="add-row-btn" onClick={() => addRow(setQuery)}>
              + Add param
            </button>
          </>
        )}

        {activeTab === "auth" && (
          <>
            <div className="key-value-editor">
              <input type="text" placeholder="Header name" value="Authorization" readOnly />
              <input type="text" placeholder="Value" value="Bearer {{authToken}}" readOnly />
              <button className="remove-btn">🔒</button>
            </div>
            {headers.map((row, i) => (
              <div key={i} className="key-value-editor">
                <input
                  type="text"
                  placeholder="Key"
                  value={row.key}
                  onChange={(e) => updateRow(setHeaders, i, "key", e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Value"
                  value={row.value}
                  onChange={(e) =>
                    updateRow(setHeaders, i, "value", e.target.value)
                  }
                />
                <button
                  className="add-row-btn"
                  onClick={() => removeRow(setHeaders, i)}
                >
                  ×
                </button>
              </div>
            ))}
            <button className="add-row-btn" onClick={() => addRow(setHeaders)}>
              + Add header
            </button>
          </>
        )}

        {activeTab === "body" && (
          <textarea
            className="body-input"
            placeholder='{"key": "value"}'
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
          />
        )}
      </div>
    </div>
  );
}
