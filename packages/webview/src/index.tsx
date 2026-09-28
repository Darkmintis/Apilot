import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

/**
 * Entry point for the Apilot webview UI.
 *
 * The extension host injects initial state via `window.apilotInit`.
 * Messages from the extension are received via `window.addEventListener('message', ...)`.
 * Messages to the extension use `vscode.postMessage(...)` when running in
 * the editor webview, or a no-op stub in standalone dev mode.
 */

const container = document.getElementById("root")!;
const root = createRoot(container);
root.render(<App />);
