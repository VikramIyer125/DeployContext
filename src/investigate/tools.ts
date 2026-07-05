/**
 * ToolRegistry — the curated, composed tool menu the investigator sees
 * (§4: NOT 1:1 with connectors). Every handler:
 *   1. returns a size-curated result (summaries + samples, never raw dumps),
 *   2. appends an Evidence object (with provenance) to the Investigation —
 *      the evidence trail is built by CODE, never reconstructed from model
 *      narrative,
 *   3. surfaces connector failures as text the model can reason about.
 */
import { dump } from "js-yaml";
import type {
  CodeFixBrief,
  Diagnosis,
  Evidence,
  Investigation,
  Provenance,
} from "../domain/types.js";
import type {
  ConnectorResult,
  GitHubConnector,
  LogSource,
  SlackSearch,
  UnleashConnector,
} from "../connectors/types.js";
import type { Registry } from "../registry/registry.js";
import type { StateResolver } from "../resolve/resolver.js";
import { diff } from "../resolve/diff.js";

export interface ToolDeps {
  registry: Registry;
  resolver: StateResolver;
  github: GitHubConnector;
  unleash: UnleashConnector;
  logs: LogSource;
  slackSearch: SlackSearch;
  unleashBaseUrl: string;
  /** Optional file listing used to guide the model after a missed path. */
  githubTree?: (repo: string, ref: string) => Promise<ConnectorResult<string[]>>;
}

export interface ExecutedTool {
  /** Sent back to the model as the tool result. */
  resultText: string;
  /** One short line for in-thread narration. */
  progressLine?: string;
  /** Set only by a VALID submit_diagnosis call — signals loop exit. */
  diagnosis?: Diagnosis;
}

const MAX_SEARCH_RESULTS = 8;
const MAX_CODE_CHARS = 10_000;
const MAX_CODE_LINES = 300;

function failText(res: { reason: string; detail: string }): string {
  return `ERROR (${res.reason}): ${res.detail}\nTreat this as evidence about system availability, not a dead end.`;
}

function slackTsToIso(ts: string): string {
  const n = Number.parseFloat(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
}

export class ToolRegistry {
  constructor(private readonly deps: ToolDeps) {}

  definitions(): Array<Record<string, unknown>> {
    return [
      {
        name: "resolve_customer_state",
        description:
          "Resolve a customer's full runtime state from the deployment registry: version pin, code ref, live feature flags (from Unleash), config bundle (from git at THEIR ref), registry notes. Use for any customer you haven't resolved yet.",
        input_schema: {
          type: "object",
          properties: { customer: { type: "string", description: "registry customer id, e.g. 'acme'" } },
          required: ["customer"],
        },
      },
      {
        name: "diff_customer_states",
        description:
          "Resolve two customers and compute the exact delta between their states (version, flag-by-flag, config-path-by-path). This is a pure computation — the fastest way to isolate what's different about the affected customer vs a healthy one.",
        input_schema: {
          type: "object",
          properties: {
            a: { type: "string", description: "affected customer id" },
            b: { type: "string", description: "healthy comparison customer id" },
          },
          required: ["a", "b"],
        },
      },
      {
        name: "find_deploy_announcements",
        description:
          "Search Slack history for deploy announcements about a customer (query construction is handled for you). Use to corroborate what was shipped to whom, when.",
        input_schema: {
          type: "object",
          properties: { customer: { type: "string" } },
          required: ["customer"],
        },
      },
      {
        name: "find_prior_reports",
        description:
          "Search Slack history for prior reports of a symptom (query construction is handled for you). Use to check whether this bug was seen before.",
        input_schema: {
          type: "object",
          properties: { symptom: { type: "string", description: "short symptom phrase, e.g. 'exports failing'" } },
          required: ["symptom"],
        },
      },
      {
        name: "search_slack_freeform",
        description:
          "Raw Slack history search. FALLBACK only — prefer find_deploy_announcements / find_prior_reports.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "query_logs",
        description:
          "Query application logs. Returns a size-curated summary: match count, time range, top patterns, and ≤10 sample lines. Narrow with filters if you need more specificity.",
        input_schema: {
          type: "object",
          properties: {
            customer: { type: "string" },
            level: { type: "string", enum: ["error", "warn"] },
            text: { type: "string", description: "substring to match in the message" },
            hours_back: { type: "number", description: "look-back window in hours (default 72)" },
          },
        },
      },
      {
        name: "read_code_at_customer_ref",
        description:
          "Read a file from the product repo at the CUSTOMER'S pinned ref (never main unless that's their ref). Use log lines to pick paths; on a miss you'll get the repo file list.",
        input_schema: {
          type: "object",
          properties: {
            customer: { type: "string" },
            path: { type: "string", description: "repo-relative file path, e.g. 'src/exportService.ts'" },
          },
          required: ["customer", "path"],
        },
      },
      {
        name: "submit_diagnosis",
        description:
          "Finish the investigation with your verdict. REQUIRED to end. Pair verdicts with actions: code-issue→code-fix, config-issue→flag-change, inconclusive→escalate.",
        input_schema: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["config-issue", "code-issue", "inconclusive"] },
            culprit: {
              type: "string",
              description: "one-line: the specific delta/code responsible, e.g. 'new_billing=on + legacy_export=off on v2.3.1'",
            },
            reasoning: { type: "string", description: "how the evidence supports the verdict; cite tool findings" },
            recommendedAction: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["flag-change", "code-fix", "escalate"] },
                changes: {
                  type: "array",
                  description: "for flag-change",
                  items: {
                    type: "object",
                    properties: { flag: { type: "string" }, to: {} },
                    required: ["flag", "to"],
                  },
                },
                brief: {
                  type: "object",
                  description: "for code-fix",
                  properties: {
                    bugSummary: { type: "string" },
                    reproductionConditions: {
                      type: "object",
                      properties: {
                        flags: { type: "object", description: "exact flag values that reproduce" },
                        configExcerpt: { type: "string" },
                        versionNote: { type: "string", description: "e.g. 'only on v2.3.1 (tag acme-prod-v2.3.1); main has a guard'" },
                      },
                      required: ["flags", "versionNote"],
                    },
                    constraints: { type: "array", items: { type: "string" } },
                  },
                  required: ["bugSummary", "reproductionConditions"],
                },
                toHuman: { type: "string", description: "for escalate" },
              },
              required: ["type"],
            },
          },
          required: ["verdict", "culprit", "reasoning", "recommendedAction"],
        },
      },
    ];
  }

  /** Execute one tool call; appends Evidence to inv.evidence as a side-effect. */
  async execute(name: string, input: unknown, inv: Investigation): Promise<ExecutedTool> {
    const args = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case "resolve_customer_state":
        return this.resolveCustomerState(String(args.customer ?? ""), inv);
      case "diff_customer_states":
        return this.diffCustomerStates(String(args.a ?? ""), String(args.b ?? ""), inv);
      case "find_deploy_announcements":
        return this.slackSearchShaped(
          `${String(args.customer ?? "")} shipped deployed rolled out version tag`,
          `deploy announcements for "${args.customer}"`,
          inv,
        );
      case "find_prior_reports":
        return this.slackSearchShaped(
          `${String(args.symptom ?? "")} issue bug failing error complaint`,
          `prior reports of "${args.symptom}"`,
          inv,
        );
      case "search_slack_freeform":
        return this.slackSearchShaped(String(args.query ?? ""), `freeform "${args.query}"`, inv);
      case "query_logs":
        return this.queryLogs(args, inv);
      case "read_code_at_customer_ref":
        return this.readCode(String(args.customer ?? ""), String(args.path ?? ""), inv);
      case "submit_diagnosis":
        return this.submitDiagnosis(args, inv);
      default:
        return { resultText: `ERROR (not-found): unknown tool "${name}"` };
    }
  }

  // ---------------------------------------------------------------- tools --

  private async resolveCustomerState(customer: string, inv: Investigation): Promise<ExecutedTool> {
    const res = await this.deps.resolver.resolve(customer);
    if (!res.ok) return { resultText: failText(res) };
    const { state, warnings } = res.data;
    const entry = this.deps.registry.get(customer)!;

    const flagsSummary = Object.entries(state.flags.value)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const result = {
      customer,
      displayName: entry.displayName,
      version: state.version.value,
      code: { repo: entry.code.repo, ref: entry.code.ref.value, refType: entry.code.refType },
      flags: state.flags.value,
      config: state.config.value,
      notes: entry.notes,
      warnings,
    };

    const provenance: Provenance =
      state.flags.provenance[0] ??
      state.version.provenance[0] ?? {
        source: "github",
        evidenceUrl: `https://github.com/${entry.code.repo}`,
        observedAt: state.resolvedAt,
        confidence: "confirmed",
      };
    this.addEvidence(inv, {
      kind: "flag-state",
      summary: `Resolved ${customer}: ${state.version.value} @ ${entry.code.ref.value}; flags: ${flagsSummary || "(unavailable)"}${warnings.length ? `; warnings: ${warnings.join("; ")}` : ""}`,
      source: provenance,
    });

    return {
      resultText: JSON.stringify(result, null, 1),
      progressLine: `Resolved ${entry.displayName}'s state (${state.version.value}, ${Object.keys(state.flags.value).length} flags) ✓`,
    };
  }

  private async diffCustomerStates(a: string, b: string, inv: Investigation): Promise<ExecutedTool> {
    const [ra, rb] = await Promise.all([this.deps.resolver.resolve(a), this.deps.resolver.resolve(b)]);
    if (!ra.ok) return { resultText: `for "${a}": ${failText(ra)}` };
    if (!rb.ok) return { resultText: `for "${b}": ${failText(rb)}` };

    const delta = diff(ra.data.state, rb.data.state);
    const flagList = delta.flagDeltas.map((f) => f.flag).join(", ");
    const summary =
      `diff(${a}, ${b}): ` +
      (delta.versionDelta ? `version ${delta.versionDelta.a} vs ${delta.versionDelta.b}; ` : "same version; ") +
      `${delta.flagDeltas.length} flag deltas${flagList ? ` (${flagList})` : ""}; ` +
      `${delta.configDeltas.length} config deltas`;

    this.addEvidence(inv, {
      kind: "state-delta",
      summary,
      source: {
        source: "unleash",
        evidenceUrl: `${this.deps.unleashBaseUrl}/projects/default/features`,
        observedAt: new Date().toISOString(),
        confidence: "confirmed",
      },
    });

    const warnings = [...ra.data.warnings, ...rb.data.warnings];
    return {
      resultText: JSON.stringify({ ...delta, warnings }, null, 1),
      progressLine: `Diffed ${a} vs ${b}: ${delta.flagDeltas.length} flag deltas, ${delta.configDeltas.length} config deltas${delta.versionDelta ? ", versions differ" : ""}`,
    };
  }

  private async slackSearchShaped(query: string, label: string, inv: Investigation): Promise<ExecutedTool> {
    const res = await this.deps.slackSearch.search(query);
    if (!res.ok) return { resultText: failText(res) };

    const results = res.data.slice(0, MAX_SEARCH_RESULTS).map((r) => ({
      text: r.text.slice(0, 300),
      author: r.author,
      permalink: r.permalink,
      ts: r.ts,
    }));

    for (const r of results.slice(0, 3)) {
      this.addEvidence(inv, {
        kind: "slack-message",
        summary: `${r.author}: "${r.text.slice(0, 160)}"`,
        source: {
          source: "slack",
          evidenceUrl: r.permalink,
          observedAt: slackTsToIso(r.ts),
          confidence: "inferred-high",
        },
      });
    }

    return {
      resultText: JSON.stringify({ matchCount: res.data.length, results }, null, 1),
      progressLine: `Searched Slack (${label}): ${res.data.length} hits`,
    };
  }

  private async queryLogs(args: Record<string, unknown>, inv: Investigation): Promise<ExecutedTool> {
    const hoursBack = typeof args.hours_back === "number" && args.hours_back > 0 ? args.hours_back : 72;
    const now = Date.now();
    const res = await this.deps.logs.query({
      customer: args.customer ? String(args.customer) : undefined,
      level: args.level === "error" || args.level === "warn" ? args.level : undefined,
      text: args.text ? String(args.text) : undefined,
      window: { from: new Date(now - hoursBack * 3600_000).toISOString(), to: new Date(now).toISOString() },
    });
    if (!res.ok) return { resultText: failText(res) };

    const filterDesc = [
      args.customer && `customer=${args.customer}`,
      args.level && `level=${args.level}`,
      args.text && `text~"${args.text}"`,
      `last ${hoursBack}h`,
    ]
      .filter(Boolean)
      .join(", ");

    if (res.data.matchCount > 0) {
      const top = res.data.topPatterns[0];
      this.addEvidence(inv, {
        kind: "log-line",
        summary: `${res.data.matchCount} log matches (${filterDesc}); top pattern: ${top.pattern} (${top.count}×)`,
        source: {
          source: "logs",
          evidenceUrl: "fixture://logs.json",
          observedAt: res.data.timeRange?.to ?? new Date().toISOString(),
          confidence: "confirmed",
        },
      });
    }

    return {
      resultText: JSON.stringify(res.data, null, 1),
      progressLine: `Queried logs (${filterDesc}): ${res.data.matchCount} matches`,
    };
  }

  private async readCode(customer: string, path: string, inv: Investigation): Promise<ExecutedTool> {
    const entry = this.deps.registry.get(customer);
    if (!entry) {
      const known = this.deps.registry.list().map((e) => e.customer).join(", ");
      return { resultText: `ERROR (not-found): unknown customer "${customer}" — registry knows: ${known}` };
    }
    const ref = entry.code.ref.value;
    const res = await this.deps.github.readFile(entry.code.repo, ref, path);

    if (!res.ok) {
      if (res.reason === "not-found" && this.deps.githubTree) {
        const tree = await this.deps.githubTree(entry.code.repo, ref);
        if (tree.ok) {
          return {
            resultText: `"${path}" not found at ${ref}. Files at this ref:\n${tree.data.join("\n")}`,
            progressLine: `Path miss (${path}) — returned file list @ ${ref}`,
          };
        }
      }
      return { resultText: failText(res) };
    }

    const lines = res.data.split("\n");
    let content = lines.slice(0, MAX_CODE_LINES).join("\n");
    if (content.length > MAX_CODE_CHARS) content = content.slice(0, MAX_CODE_CHARS);
    const truncated = lines.length > MAX_CODE_LINES || res.data.length > MAX_CODE_CHARS;

    this.addEvidence(inv, {
      kind: "code-snippet",
      summary: `Read ${path} @ ${ref} (${lines.length} lines)`,
      source: {
        source: "github",
        evidenceUrl: `https://github.com/${entry.code.repo}/blob/${ref}/${path}`,
        observedAt: new Date().toISOString(),
        confidence: "confirmed",
      },
    });

    return {
      resultText: `// ${path} @ ${ref}${truncated ? " (truncated)" : ""}\n${content}`,
      progressLine: `Read ${path} @ ${ref}`,
    };
  }

  private submitDiagnosis(args: Record<string, unknown>, inv: Investigation): ExecutedTool {
    const verdicts = ["config-issue", "code-issue", "inconclusive"];
    const verdict = String(args.verdict ?? "");
    const culprit = String(args.culprit ?? "").trim();
    const reasoning = String(args.reasoning ?? "").trim();
    const action = (args.recommendedAction ?? {}) as Record<string, unknown>;
    const actionType = String(action.type ?? "");

    const problems: string[] = [];
    if (!verdicts.includes(verdict)) problems.push(`verdict must be one of ${verdicts.join("|")}`);
    if (!culprit) problems.push("culprit is required");
    if (!reasoning) problems.push("reasoning is required");

    const expectedAction: Record<string, string> = {
      "code-issue": "code-fix",
      "config-issue": "flag-change",
      inconclusive: "escalate",
    };
    if (verdict && expectedAction[verdict] && actionType !== expectedAction[verdict]) {
      problems.push(`verdict "${verdict}" must pair with recommendedAction.type "${expectedAction[verdict]}"`);
    }

    let recommendedAction: Diagnosis["recommendedAction"] | null = null;
    if (actionType === "flag-change") {
      const changes = Array.isArray(action.changes) ? action.changes : [];
      if (changes.length === 0) problems.push("flag-change requires non-empty changes[]");
      recommendedAction = {
        type: "flag-change",
        changes: changes.map((c) => ({ flag: String((c as Record<string, unknown>).flag), to: (c as Record<string, unknown>).to })),
      };
    } else if (actionType === "code-fix") {
      const brief = (action.brief ?? {}) as Record<string, unknown>;
      const repro = (brief.reproductionConditions ?? {}) as Record<string, unknown>;
      if (!brief.bugSummary) problems.push("code-fix requires brief.bugSummary");
      if (!repro.flags || typeof repro.flags !== "object") problems.push("code-fix requires brief.reproductionConditions.flags");
      if (!repro.versionNote) problems.push("code-fix requires brief.reproductionConditions.versionNote");
      if (problems.length === 0) {
        const entry = this.deps.registry.get(inv.customer);
        if (!entry) {
          problems.push(`cannot assemble CodeFixBrief: unknown customer "${inv.customer}"`);
        } else {
          const fullBrief: CodeFixBrief = {
            repo: entry.code.repo,
            ref: entry.code.ref.value, // the customer's pinned ref — never main
            bugSummary: String(brief.bugSummary),
            reproductionConditions: {
              flags: repro.flags as Record<string, unknown>,
              configExcerpt: repro.configExcerpt ? String(repro.configExcerpt) : undefined,
              versionNote: String(repro.versionNote),
            },
            evidence: [...inv.evidence],
            constraints:
              Array.isArray(brief.constraints) && brief.constraints.length > 0
                ? brief.constraints.map(String)
                : ["minimal diff", "no new dependencies", "match repo style"],
          };
          recommendedAction = { type: "code-fix", brief: fullBrief };
        }
      }
    } else if (actionType === "escalate") {
      recommendedAction = { type: "escalate", toHuman: String(action.toHuman ?? reasoning) };
    } else if (!problems.length) {
      problems.push(`recommendedAction.type must be flag-change|code-fix|escalate`);
    }

    if (problems.length > 0 || !recommendedAction) {
      return {
        resultText: `submit_diagnosis rejected:\n- ${problems.join("\n- ")}\nFix these and call submit_diagnosis again.`,
      };
    }

    const diagnosis: Diagnosis = {
      verdict: verdict as Diagnosis["verdict"],
      culprit,
      reasoning,
      recommendedAction,
    };
    return {
      resultText: "diagnosis accepted",
      progressLine: `Verdict: ${verdict} — ${culprit}`,
      diagnosis,
    };
  }

  private addEvidence(inv: Investigation, evidence: Evidence): void {
    inv.evidence.push(evidence);
  }
}

/** Compact YAML render used when packing config into the initial context. */
export function yamlSnippet(value: Record<string, unknown>, maxLines = 20): string {
  const text = dump(value, { lineWidth: 80 }).trimEnd();
  const lines = text.split("\n");
  return lines.length > maxLines ? lines.slice(0, maxLines).join("\n") + "\n# … truncated" : text;
}
