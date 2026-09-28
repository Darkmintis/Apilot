import React from "react";
import { ChevronDown, ChevronRight, Play, Database, Shield } from "lucide-react";
import type {
  CollectionEntry,
  EndpointEntry,
  EnvironmentEntry,
  ProjectRegistry,
} from "../types";

interface Props {
  registry: ProjectRegistry | null;
  environments: EnvironmentEntry[];
  selectedEndpoint: EndpointEntry | null;
  selectedEnv: string;
  onSelectEndpoint: (ep: EndpointEntry | null) => void;
  onSelectEnv: (env: string) => void;
  onRunAll: () => void;
}

const METHOD_COLORS: Record<string, string> = {
  GET: "method-get",
  POST: "method-post",
  PUT: "method-put",
  PATCH: "method-patch",
  DELETE: "method-delete",
  HEAD: "method-get",
  OPTIONS: "method-get",
};

export default function CollectionsSidebar({
  registry,
  environments,
  selectedEndpoint,
  selectedEnv,
  onSelectEndpoint,
  onSelectEnv,
  onRunAll,
}: Props): React.JSX.Element {
  const [expandedCollections, setExpandedCollections] = React.useState<Set<string>>(new Set());

  const toggleCollection = (id: string) => {
    setExpandedCollections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="sidebar">
      {/* Run All */}
      <div className="section" style={{paddingBottom: 0}}>
        <button className="btn btn-primary" style={{width: "100%"}} onClick={onRunAll}>
          <Play size={14} /> Run All Endpoints
        </button>
      </div>

      {/* Environments */}
      {environments.length > 0 && (
        <div className="section">
          <div className="section-title">Environments</div>
          {environments.map((env) => (
            <div
              key={env.name}
              className="collection-item"
              style={{
                backgroundColor:
                  selectedEnv === env.name ? "var(--apilot-accent)" : undefined,
                color: selectedEnv === env.name ? "white" : "var(--apilot-text)",
              }}
              onClick={() => onSelectEnv(env.name)}
            >
              <Shield size={12} style={{marginRight: 6}} />
              <span style={{fontSize: 12}}>{env.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Collections */}
      {registry && (
        <div className="section">
          <div className="section-title">Collections</div>
          {registry.collections.length === 0 ? (
            <div className="collection-item" style={{cursor: "default"}}>
              <span style={{color: "var(--apilot-text-secondary)"}}>
                No collections found. Check your .apilot/collections/ folder.
              </span>
            </div>
          ) : (
            registry.collections.map((coll) => (
              <div key={coll.id}>
                <div
                  className="collection-item expanded"
                  onClick={() => toggleCollection(coll.id)}
                >
                  <Database size={12} style={{marginRight: 6}} />
                  <span>{coll.name}</span>
                </div>

                <div className="endpoint-list">
                  {registry.endpoints
                    .filter((e) => e.collectionId === coll.id)
                    .map((ep) => (
                      <div
                        key={ep.id}
                        className="endpoint-item"
                        style={{
                          backgroundColor:
                            selectedEndpoint?.id === ep.id
                              ? "var(--apilot-bg-input)"
                              : undefined,
                        }}
                        onClick={() => onSelectEndpoint(ep)}
                      >
                        <span
                          className={`method-badge ${METHOD_COLORS[ep.method]}`}
                        >
                          {ep.method}
                        </span>
                        <span
                          style={{
                            color: selectedEndpoint?.id === ep.id
                              ? "var(--apilot-accent)"
                              : "inherit",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {ep.name}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
