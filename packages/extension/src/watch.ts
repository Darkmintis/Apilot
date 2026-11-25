/**
 * Daily check: when a project opens, call the safe endpoints and tell the user
 * if a response changed in a way that could break their app.
 *
 * Safety: only GET/HEAD (or `watch: true`) endpoints run, secrets are never
 * prompted for, and a production-looking environment is skipped unless the
 * user chose it in `apilot.watch.environment`.
 */

import * as vscode from "vscode";
import { isDue, summarizeWatch, watchMessage, type ProjectEntry, type ProjectHub } from "@apilot/core";

export interface WatchHost {
  hub: ProjectHub;
  state: vscode.Memento;
  envFor(projectId: string): string | undefined;
  show(project: string, endpointId: string): void;
  refresh(): void;
}

const PROD = /prod|live/i;
const cfg = () => vscode.workspace.getConfiguration("apilot.watch");

/** On project open: run the daily check, or offer to turn it on (once). */
export async function onOpen(host: WatchHost): Promise<void> {
  if (cfg().get<boolean>("onOpen")) return checkAll(host, false);
  if (host.state.get("apilot.watch.offered") || !host.hub.projects.some((p) => p.hasApilot)) return;
  await host.state.update("apilot.watch.offered", true);
  const pick = await vscode.window.showInformationMessage(
    "Apilot can check your APIs for response changes once a day when you open this project. It only calls GET requests, never asks for secrets, and skips production.",
    "Turn On",
    "Not Now"
  );
  if (pick === "Turn On") {
    await cfg().update("onOpen", true, vscode.ConfigurationTarget.Global);
    await checkAll(host, false);
  }
}

/** Check every project. `manual` ignores the once-a-day limit and always reports. */
export async function checkAll(host: WatchHost, manual: boolean): Promise<void> {
  for (const project of host.hub.projects.filter((p) => p.hasApilot)) {
    try {
      await checkProject(host, project, manual);
    } catch (err) {
      if (manual) vscode.window.showErrorMessage(`Apilot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function checkProject(host: WatchHost, project: ProjectEntry, manual: boolean): Promise<void> {
  const key = `apilot.watch.last.${project.id}`;
  if (!manual && !isDue(host.state.get<string>(key))) return;
  const explicit = cfg().get<string>("environment")?.trim();
  const env = explicit || host.envFor(project.id);
  if (!env) return;
  if (!explicit && PROD.test(env)) {
    if (manual) vscode.window.showInformationMessage(`Apilot: skipped "${env}" (looks like production). Set apilot.watch.environment to check it anyway.`);
    return;
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Apilot: checking ${project.name}` },
    () => host.hub.workspace(project.id).runWatched(env)
  );
  await host.state.update(key, new Date().toISOString());
  host.refresh();

  const summary = summarizeWatch(result);
  const message = watchMessage(summary, project.name);
  if (!message) {
    if (manual) vscode.window.showInformationMessage(`Apilot (${project.name}): ${summary.checked} endpoints checked, no breaking changes.${summary.skipped ? ` ${summary.skipped} skipped (missing secrets).` : ""}`);
    return;
  }
  const first = summary.breaking[0] ?? summary.warning[0] ?? summary.failed[0]!;
  const show = summary.breaking.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  if ((await show(message, "Show Changes")) === "Show Changes") host.show(project.id, first);
}
