/**
 * Layer 1 boundary types, per BRIEF.md §4.
 *
 * Errors are data at the boundary: everything crossing into the orchestrator
 * is a ConnectorResult. The LLM receives failures as reasoning input, never
 * as crashes.
 */
import type { CustomerId, FlagContextRef } from "../domain/types.js";

export type ConnectorResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ConnectorFailure; detail: string };

export type ConnectorFailure = "auth" | "not-found" | "rate-limited" | "unavailable";

export const ok = <T>(data: T): ConnectorResult<T> => ({ ok: true, data });
export const err = (reason: ConnectorFailure, detail: string): ConnectorResult<never> => ({
  ok: false,
  reason,
  detail,
});

export interface FileChange {
  path: string;
  content: string;
}

export interface GitHubConnector {
  listRefs(
    repo: string,
  ): Promise<ConnectorResult<Array<{ name: string; type: "branch" | "tag"; lastCommitAt: string }>>>;
  readFile(repo: string, ref: string, path: string): Promise<ConnectorResult<string>>;
  createBranch(repo: string, fromRef: string, name: string): Promise<ConnectorResult<void>>;
  pushFiles(
    repo: string,
    branch: string,
    files: FileChange[],
    message: string,
  ): Promise<ConnectorResult<void>>;
  openPr(
    repo: string,
    p: { base: string; head: string; title: string; body: string },
  ): Promise<ConnectorResult<{ url: string }>>;
}

export interface UnleashConnector {
  evaluateAll(ctx: FlagContextRef): Promise<ConnectorResult<Record<string, boolean | string>>>;
  getFlagMetadata(
    flag: string,
  ): Promise<ConnectorResult<{ description: string; createdAt: string; stale: boolean }>>;
}

export interface LogLine {
  ts: string;
  level: "info" | "warn" | "error";
  service: string;
  customer: CustomerId;
  version: string;
  message: string;
}

/** Size-curated per §4 rule 5: summaries + samples, never raw dumps. */
export interface LogQuerySummary {
  matchCount: number;
  timeRange: { from: string; to: string } | null;
  topPatterns: Array<{ pattern: string; count: number }>;
  sample: LogLine[]; // ≤ 10, most recent first
}

export interface LogQuery {
  customer?: CustomerId;
  level?: "error" | "warn";
  text?: string;
  window: { from: string; to: string };
}

export interface LogSource {
  query(q: LogQuery): Promise<ConnectorResult<LogQuerySummary>>;
}

export interface SlackSearchResult {
  text: string;
  permalink: string;
  author: string;
  ts: string;
}

/** Wraps Slack's Real-Time Search API (assistant.search.context). */
export interface SlackSearch {
  search(
    query: string,
    opts?: { channels?: string[]; before?: string; after?: string },
  ): Promise<ConnectorResult<SlackSearchResult[]>>;
}
