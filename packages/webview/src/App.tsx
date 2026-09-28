import React, { useEffect, useState, useCallback } from "react";
import CollectionsSidebar from "./components/CollectionsSidebar";
import RequestBuilder from "./components/RequestBuilder";
import ResponseViewer from "./components/ResponseViewer";
import EnvironmentsPanel from "./components/EnvironmentsPanel";
import DiffViewer from "./components/DiffViewer";
import type {
  EndpointEntry,
  EnvironmentEntry,
  EnvironmentFile,
  ProjectRegistry,
  SnapshotMeta,
  SnapshotRedacted,
  DiffResult,
  WebviewMessage,
} from "./types";

// PostMessage bridge — works in VS Code webview and standalone dev
const vscode = (window as any).vscode ?? {
  postMessage: (msg: unknown) => console.log("[dev] postMessage:", msg),
};

function postMessage(type: string, data: unknown): void {
  vscode.postMessage({ type, data });
}

export default function App(): React.JSX.Element {
  // --- State ---
  const [registry, setRegistry] = useState<ProjectRegistry | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentEntry[]>([]);
  const [selectedEndpoint, setSelectedEndpoint] = useState<EndpointEntry | null>(null);
  const [selectedEnv, setSelectedEnv] = useState<string>("");
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [response, setResponse] = useState<SnapshotRedacted | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [activeTab, setActiveTab] = useState<"params" | "auth" | "body">("params");
  const [isRunning, setIsRunning] = useState(false);

  // --- Initialize from injected data ---
  useEffect(() => {
    const init = (window as any).apilotInit;
    if (init) {
      setRegistry(init.registry);
      setEnvironments(init.environments);
      if (init.registry.project.defaultEnvironment) {
        setSelectedEnv(init.registry.project.defaultEnvironment);
      }
    }
  }, []);

  // --- Message listener (extension ↔ webview) ---
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg: WebviewMessage = event.data;
      switch (msg.type) {
        case "init":
          setRegistry(msg.data.registry);
          setEnvironments(msg.data.environments);
          if (!selectedEnv && msg.data.registry.project.defaultEnvironment) {
            setSelectedEnv(msg.data.registry.project.defaultEnvironment);
          }
          break;
        case "registry":
          setRegistry(msg.data);
          break;
        case "runResult":
          setResponse(msg.data.snapshot);
          setIsRunning(false);
          // Load snapshot list
          postMessage("loadSnapshots", { endpointId: msg.data.endpointId });
          break;
        case "snapshots":
          if (msg.data.endpointId === selectedEndpoint?.id) {
            setSnapshots(msg.data.snapshots);
          }
          break;
        case "diff":
          setDiff(msg.data);
          break;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [selectedEndpoint, selectedEnv]);

  // --- Actions ---
  const runEndpoint = useCallback(() => {
    if (!selectedEndpoint || !selectedEnv) return;
    setIsRunning(true);
    postMessage("runEndpoint", {
      endpointId: selectedEndpoint.id,
      envName: selectedEnv,
    });
  }, [selectedEndpoint, selectedEnv]);

  const runAll = useCallback(() => {
    if (!selectedEnv) return;
    setIsRunning(true);
    postMessage("runAll", { envName: selectedEnv });
  }, [selectedEnv]);

  const diffEndpoint = useCallback(() => {
    if (!selectedEndpoint) return;
    postMessage("diffEndpoint", { endpointId: selectedEndpoint.id });
  }, [selectedEndpoint]);

  const generateCode = useCallback(async () => {
    if (!selectedEndpoint) return;
    const lang = await (window as any).showQuickPick?.([
      "dart", "typescript", "kotlin", "swift",
    ]);
    if (lang) {
      postMessage("generateCode", { endpointId: selectedEndpoint.id, language: lang });
    }
  }, [selectedEndpoint]);

  const loadSnapshots = useCallback(() => {
    if (selectedEndpoint) {
      postMessage("loadSnapshots", { endpointId: selectedEndpoint.id });
    }
  }, [selectedEndpoint]);

  // --- Render ---
  return (
    <div className="app-container">
      {/* Sidebar */}
      <CollectionsSidebar
        registry={registry}
        environments={environments}
        selectedEndpoint={selectedEndpoint}
        selectedEnv={selectedEnv}
        onSelectEndpoint={setSelectedEndpoint}
        onSelectEnv={setSelectedEnv}
        onRunAll={runAll}
      />

      {/* Main Content */}
      <div className="main-content">
        {/* Request Builder */}
        <RequestBuilder
          endpoint={selectedEndpoint}
          envName={selectedEnv}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          isRunning={isRunning}
          onRun={runEndpoint}
          onLoadSnapshots={loadSnapshots}
        />

        {/* Response / Diff */}
        {diff ? (
          <DiffViewer diff={diff} onClose={() => setDiff(null)} />
        ) : response ? (
          <ResponseViewer
            snapshot={response}
            snapshots={snapshots}
            onDiff={diffEndpoint}
            onGenerateCode={generateCode}
          />
        ) : (
          <div className="no-data">
            {selectedEndpoint
              ? "Select or run an endpoint to see the response here."
              : "Select an endpoint from the sidebar to get started."}
          </div>
        )}
      </div>
    </div>
  );
}
