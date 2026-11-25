/**
 * Turns the result of an unattended check (`Workspace.runWatched`) into
 * something worth telling the user. Pure, so the editor only has to show it.
 */

import type { RunAllResult } from "./workspace.js";

export interface WatchSummary {
  checked: number;
  /** endpoints whose response now breaks the baseline */
  breaking: string[];
  /** endpoints with warning-level changes only */
  warning: string[];
  /** endpoints that errored or returned an unexpected status */
  failed: string[];
  skipped: number;
}

export function summarizeWatch(r: RunAllResult): WatchSummary {
  const ran = r.results.filter((x) => !x.skipped);
  const breaking = ran.filter((x) => x.breaking).map((x) => x.endpointId);
  return {
    checked: ran.length,
    breaking,
    warning: ran.filter((x) => !x.breaking && (x.summary?.warning ?? 0) > 0).map((x) => x.endpointId),
    failed: ran.filter((x) => !x.passed).map((x) => x.endpointId),
    skipped: r.results.length - ran.length,
  };
}

/** One line for a notification, or undefined when there is nothing to report. */
export function watchMessage(s: WatchSummary, project: string): string | undefined {
  const parts: string[] = [];
  if (s.breaking.length) parts.push(`${s.breaking.length} with breaking changes`);
  if (s.warning.length) parts.push(`${s.warning.length} with warnings`);
  const failedOnly = s.failed.filter((id) => !s.breaking.includes(id));
  if (failedOnly.length) parts.push(`${failedOnly.length} failed`);
  return parts.length ? `Apilot (${project}): ${parts.join(", ")} of ${s.checked} checked endpoints.` : undefined;
}

/** True when the daily check has not run yet today (local time). */
export function isDue(last: string | undefined, now = new Date()): boolean {
  return !last || new Date(last).toDateString() !== now.toDateString();
}
