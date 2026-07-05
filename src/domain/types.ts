/**
 * Layer 0 — domain model, per BRIEF.md §3.
 *
 * Core principles: the registry stores descriptors (pointers to where truth
 * lives), never resolved values; provenance is first-class and per-fact via
 * Attested<T>.
 */

export type CustomerId = string; // "acme"

export interface RegistryEntry {
  customer: CustomerId;
  displayName: string;
  code: CodeRef;
  versionPin: Attested<string>; // "v2.3.1"
  flagContext: FlagContextRef; // how to ask Unleash "as Acme"
  config: ConfigRef | null;
  /** Unstructured tribal knowledge; injected into investigation context verbatim; never parsed. */
  notes: string[];
  /** Slack channel IDs associated with this customer (e.g. "#support-acme"); used by triage. */
  slackChannels?: string[];
}

export interface CodeRef {
  repo: string;
  refType: "branch" | "tag";
  ref: Attested<string>;
}

export interface FlagContextRef {
  provider: "unleash";
  context: Record<string, string>;
}

export interface ConfigRef {
  repo: string;
  path: string; // e.g. "customers/acme/values.yaml"
}

export interface Attested<T> {
  value: T;
  provenance: Provenance[];
}

export interface Provenance {
  source: "slack" | "github" | "unleash" | "logs" | "human";
  evidenceUrl: string; // Slack permalink / commit URL / etc.
  observedAt: string; // ISO date
  confidence: "confirmed" | "inferred-high" | "inferred-low";
}

export interface ResolvedState {
  customer: CustomerId;
  resolvedAt: string;
  version: Attested<string>;
  flags: Attested<Record<string, boolean | string>>; // queried live from Unleash
  config: Attested<Record<string, unknown>>; // parsed from repo at ref
}

export interface StateDelta {
  a: CustomerId;
  b: CustomerId;
  versionDelta: { a: string; b: string } | null;
  flagDeltas: Array<{ flag: string; a: unknown; b: unknown }>;
  configDeltas: Array<{ path: string; a: unknown; b: unknown }>;
}

export interface Investigation {
  id: string;
  trigger: { channel: string; threadTs: string; permalink: string; text: string };
  customer: CustomerId;
  /** Accumulated STRUCTURALLY by tool handlers, never reconstructed from model narrative. */
  evidence: Evidence[];
  diagnosis?: Diagnosis;
  status: "running" | "diagnosed" | "fixing" | "done" | "escalated";
}

export interface Evidence {
  kind: "slack-message" | "log-line" | "flag-state" | "code-snippet" | "state-delta";
  summary: string;
  source: Provenance;
}

export interface Diagnosis {
  verdict: "config-issue" | "code-issue" | "inconclusive";
  culprit: string;
  reasoning: string;
  recommendedAction:
    | { type: "flag-change"; changes: Array<{ flag: string; to: unknown }> }
    | { type: "code-fix"; brief: CodeFixBrief }
    | { type: "escalate"; toHuman: string };
}

export interface CodeFixBrief {
  repo: string;
  ref: string; // the customer's pinned ref — never main
  bugSummary: string;
  reproductionConditions: {
    flags: Record<string, unknown>;
    configExcerpt?: string;
    versionNote: string;
  };
  evidence: Evidence[];
  constraints: string[]; // e.g. "minimal diff", "no new dependencies"
}

export type FixOutcome =
  | { status: "pr-opened"; prUrl: string; summary: string; verification: VerificationReport }
  | { status: "no-repro"; detail: string }
  | { status: "fix-unverified"; branchUrl: string; detail: string }
  | { status: "failed"; reason: string; transcript: string };

/** Computed by WRAPPER CODE, never trusted from the model. */
export interface VerificationReport {
  reproTestAdded: boolean;
  reproTestFailsOnOriginal: boolean;
  reproTestPassesOnFixed: boolean;
  fullSuitePassed: boolean;
  linesChanged: number;
}
