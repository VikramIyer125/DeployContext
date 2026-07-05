/**
 * InvestigationRunner — the hand-built Opus tool-use loop (§5).
 *
 * Decisions (all MUST):
 * - Front-loaded context: state pre-resolved deterministically before turn 1.
 * - Structured exit via submit_diagnosis; prose endings re-prompted once.
 * - Hard ceilings: MAX_TURNS, per-tool timeout, total token budget.
 *   On breach → fail CLOSED into inconclusive + escalation. Never fail open.
 * - Evidence persisted structurally after every tool round.
 * - Thread continuity: queued human replies injected each turn.
 */
import type { Diagnosis, Investigation } from "../domain/types.js";
import type { Registry } from "../registry/registry.js";
import type { StateResolver } from "../resolve/resolver.js";
import type { InvestigationStore } from "./store.js";
import type { ThreadReporter } from "./reporter.js";
import type { ToolRegistry } from "./tools.js";
import { yamlSnippet } from "./tools.js";
import { INVESTIGATOR_PROMPT } from "./prompts.js";
import { log } from "../log.js";

export const INVESTIGATOR_MODEL = "claude-opus-4-8";

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

export interface LlmResponse {
  content: ContentBlock[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface LlmClient {
  messages: {
    // loosely typed so both the real SDK and scripted fakes fit
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(params: any): Promise<LlmResponse>;
  };
}

export interface RunnerOptions {
  model?: string;
  maxTurns?: number;
  toolTimeoutMs?: number;
  /** Cumulative input+output token ceiling across the whole run. */
  tokenBudget?: number;
  maxTokensPerTurn?: number;
}

export interface RunnerDeps {
  llm: LlmClient;
  tools: ToolRegistry;
  registry: Registry;
  resolver: StateResolver;
  store: InvestigationStore;
  reporter: ThreadReporter;
  options?: RunnerOptions;
}

type Message = { role: "user" | "assistant"; content: string | ContentBlock[] };

export class InvestigationRunner {
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly toolTimeoutMs: number;
  private readonly tokenBudget: number;
  private readonly maxTokensPerTurn: number;

  constructor(private readonly deps: RunnerDeps) {
    this.model = deps.options?.model ?? INVESTIGATOR_MODEL;
    this.maxTurns = deps.options?.maxTurns ?? 15;
    this.toolTimeoutMs = deps.options?.toolTimeoutMs ?? 30_000;
    this.tokenBudget = deps.options?.tokenBudget ?? 400_000;
    this.maxTokensPerTurn = deps.options?.maxTokensPerTurn ?? 8192;
  }

  async run(inv: Investigation): Promise<Diagnosis> {
    const messages: Message[] = [
      { role: "user", content: await this.buildInitialContext(inv) },
    ];
    let tokensUsed = 0;
    let reprompted = false;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      let resp: LlmResponse;
      try {
        resp = await this.deps.llm.messages.create({
          model: this.model,
          system: INVESTIGATOR_PROMPT,
          messages,
          tools: this.deps.tools.definitions(),
          max_tokens: this.maxTokensPerTurn,
        });
      } catch (e) {
        log.error("investigator LLM call failed", { inv: inv.id, error: (e as Error).message });
        return this.failClosed(inv, `LLM call failed: ${(e as Error).message}`);
      }

      tokensUsed += (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);
      if (tokensUsed > this.tokenBudget) {
        return this.failClosed(inv, `token budget exceeded (${tokensUsed} > ${this.tokenBudget})`);
      }

      const toolUses = resp.content.filter((c) => c.type === "tool_use");

      if (toolUses.length === 0) {
        // Prose ending: re-prompt once, then fail closed.
        if (reprompted) {
          return this.failClosed(inv, "model ended in prose twice without submit_diagnosis");
        }
        reprompted = true;
        messages.push(
          { role: "assistant", content: resp.content },
          {
            role: "user",
            content:
              "Finish by calling the submit_diagnosis tool with your verdict (or verdict=inconclusive if you cannot conclude).",
          },
        );
        continue;
      }

      // Execute tools (submit_diagnosis last so other results still land).
      const ordered = [
        ...toolUses.filter((t) => t.name !== "submit_diagnosis"),
        ...toolUses.filter((t) => t.name === "submit_diagnosis"),
      ];
      const results: ContentBlock[] = [];
      let diagnosis: Diagnosis | null = null;

      for (const call of ordered) {
        const executed = await this.executeWithTimeout(call.name ?? "", call.input, inv);
        results.push({
          type: "tool_result",
          // @ts-expect-error tool_use_id is the wire field name
          tool_use_id: call.id,
          content: executed.resultText,
        });
        if (executed.progressLine) {
          await this.deps.reporter.progress(inv, executed.progressLine);
        }
        if (executed.diagnosis) diagnosis = executed.diagnosis;
      }

      this.deps.store.saveEvidence(inv.id, inv.evidence);

      if (diagnosis) {
        inv.diagnosis = diagnosis;
        inv.status = "diagnosed";
        this.deps.store.saveDiagnosis(inv.id, diagnosis, "diagnosed");
        return diagnosis;
      }

      // Thread continuity: inject human replies queued while we worked.
      const humanContext = this.deps.store.drainContext(inv.id);
      const userContent: ContentBlock[] = [...results];
      if (humanContext.length > 0) {
        userContent.push({
          type: "text",
          text: `Additional context from humans in the thread:\n${humanContext.map((c) => `- ${c}`).join("\n")}`,
        });
      }
      messages.push({ role: "assistant", content: resp.content }, { role: "user", content: userContent });
    }

    return this.failClosed(inv, `turn limit reached (${this.maxTurns})`);
  }

  private async executeWithTimeout(name: string, input: unknown, inv: Investigation) {
    const timeout = new Promise<import("./tools.js").ExecutedTool>((resolve) =>
      setTimeout(
        () => resolve({ resultText: `ERROR (timeout): tool "${name}" exceeded ${this.toolTimeoutMs}ms` }),
        this.toolTimeoutMs,
      ),
    );
    try {
      return await Promise.race([this.deps.tools.execute(name, input, inv), timeout]);
    } catch (e) {
      return { resultText: `ERROR (unavailable): tool "${name}" threw: ${(e as Error).message}` };
    }
  }

  /** Hard-ceiling breaches and unrecoverable errors land here. Never fail open. */
  private failClosed(inv: Investigation, reason: string): Diagnosis {
    const evidenceSummary =
      inv.evidence.length > 0
        ? `Evidence gathered (${inv.evidence.length}): ${inv.evidence
            .slice(0, 6)
            .map((e) => e.summary)
            .join(" | ")}`
        : "No evidence was gathered.";
    const diagnosis: Diagnosis = {
      verdict: "inconclusive",
      culprit: "investigation did not converge",
      reasoning: `${reason}. ${evidenceSummary}`,
      recommendedAction: {
        type: "escalate",
        toHuman: `Investigation ${inv.id} stopped (${reason}). A human should review the evidence trail and the original report: ${inv.trigger.permalink}`,
      },
    };
    inv.diagnosis = diagnosis;
    inv.status = "escalated";
    this.deps.store.saveDiagnosis(inv.id, diagnosis, "escalated");
    return diagnosis;
  }

  /**
   * Front-loaded context: deterministic code pre-resolves the reporting
   * customer's state and registry entry so turns are judgment, not lookups.
   */
  private async buildInitialContext(inv: Investigation): Promise<string> {
    await this.deps.registry.ensureLoaded();
    const entry = this.deps.registry.get(inv.customer);
    const others = this.deps.registry
      .list()
      .filter((e) => e.customer !== inv.customer)
      .map((e) => `- ${e.customer} (${e.displayName}): ${e.versionPin.value} @ ${e.code.ref.value} (${e.code.refType})`)
      .join("\n");

    let stateSection = "(state could not be pre-resolved — resolve_customer_state yourself)";
    if (entry) {
      const res = await this.deps.resolver.resolve(inv.customer);
      if (res.ok) {
        const { state, warnings } = res.data;
        const flags = Object.entries(state.flags.value)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([k, v]) => `  ${k} = ${v}`)
          .join("\n");
        stateSection = [
          `version: ${state.version.value}`,
          `code: ${entry.code.repo} @ ${entry.code.ref.value} (${entry.code.refType})`,
          `flags (live from Unleash):\n${flags || "  (unavailable)"}`,
          `config (${entry.config?.path ?? "none"}):\n${yamlSnippet(state.config.value)
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n")}`,
          warnings.length ? `warnings: ${warnings.join("; ")}` : null,
        ]
          .filter(Boolean)
          .join("\n");
      } else {
        stateSection = `pre-resolution failed: [${res.reason}] ${res.detail}`;
      }
    }

    return [
      `Investigation ${inv.id}: a customer bug report needs a verdict.`,
      ``,
      `## Bug report (Slack: ${inv.trigger.permalink})`,
      inv.trigger.text,
      ``,
      `## Reporting customer: ${inv.customer}${entry ? ` (${entry.displayName})` : ""}`,
      entry?.notes.length ? `Registry notes (verbatim):\n${entry.notes.map((n) => `- ${n}`).join("\n")}` : "Registry notes: none",
      ``,
      `## Pre-resolved state (live, ${new Date().toISOString()})`,
      stateSection,
      ``,
      `## Other registry customers (healthy-comparison candidates)`,
      others || "(none)",
      ``,
      `Current time: ${new Date().toISOString()}. Logs are queryable via query_logs (default window: last 72h).`,
      `Begin. Remember: submit_diagnosis is the only way to finish.`,
    ].join("\n");
  }
}
