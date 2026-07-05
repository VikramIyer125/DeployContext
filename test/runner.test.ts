import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { Investigation } from "../src/domain/types.js";
import { InvestigationRunner, type LlmClient, type LlmResponse } from "../src/investigate/runner.js";
import { InvestigationStore } from "../src/investigate/store.js";
import { NullReporter } from "../src/investigate/reporter.js";
import { ToolRegistry } from "../src/investigate/tools.js";
import { StateResolver } from "../src/resolve/resolver.js";
import { SeededLogSource } from "../src/connectors/logs.js";
import { FakeSlackSearch } from "../src/connectors/fakes/index.js";
import { buildTestWorld } from "./helpers.js";

const FIXTURE_PATH = join(process.cwd(), "fixtures", "logs.json");

const GOOD_DIAGNOSIS_INPUT = {
  verdict: "code-issue",
  culprit: "new_billing=on + legacy_export=off on v2.3.1",
  reasoning: "billing formatter requires ledgerRef; only the legacy exporter stamps it",
  recommendedAction: {
    type: "code-fix",
    brief: {
      bugSummary: "formatBillingRow requires ledgerRef",
      reproductionConditions: {
        flags: { new_billing: true, legacy_export: false },
        versionNote: "v2.3.1 only",
      },
    },
  },
};

function toolUse(name: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2, 8)}`): LlmResponse {
  return { content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 50 } };
}

function prose(text: string): LlmResponse {
  return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } };
}

/** Scripted LLM: returns queued responses in order; repeats the last one. */
function scriptedLlm(responses: LlmResponse[]): LlmClient & { calls: Array<Record<string, unknown>> } {
  let i = 0;
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    messages: {
      async create(params: Record<string, unknown>) {
        calls.push(params);
        const resp = responses[Math.min(i, responses.length - 1)];
        i++;
        return resp;
      },
    },
  };
}

function harness(
  llm: LlmClient,
  options?: ConstructorParameters<typeof InvestigationRunner>[0]["options"],
  overrides?: { logs?: import("../src/connectors/types.js").LogSource },
) {
  const world = buildTestWorld();
  const resolver = new StateResolver({
    registry: world.registry,
    github: world.github,
    unleash: world.unleash,
    unleashBaseUrl: "http://localhost:4242",
  });
  const tools = new ToolRegistry({
    registry: world.registry,
    resolver,
    github: world.github,
    unleash: world.unleash,
    logs: overrides?.logs ?? new SeededLogSource(FIXTURE_PATH, { rebaseToNow: true }),
    slackSearch: new FakeSlackSearch(),
    unleashBaseUrl: "http://localhost:4242",
  });
  const store = new InvestigationStore(":memory:");
  const reporter = new NullReporter();
  const runner = new InvestigationRunner({
    llm,
    tools,
    registry: world.registry,
    resolver,
    store,
    reporter,
    options,
  });
  const inv = store.create({
    trigger: { channel: "C1", threadTs: "1.0", permalink: "https://slack/x", text: "Acme says exports are failing" },
    customer: "acme",
  });
  return { runner, store, reporter, inv, world };
}

describe("InvestigationRunner", () => {
  it("front-loads the resolved state and registry notes into the first message", async () => {
    const llm = scriptedLlm([toolUse("submit_diagnosis", GOOD_DIAGNOSIS_INPUT)]);
    const { runner, inv } = harness(llm);
    await runner.run(inv);
    const first = llm.calls[0].messages as Array<{ content: string }>;
    expect(first[0].content).toContain("Acme says exports are failing");
    expect(first[0].content).toContain("new_billing = true");
    expect(first[0].content).toContain("legacy_export = false");
    expect(first[0].content).toContain("upgrade window is quarterly");
    expect(first[0].content).toContain("beta (Beta Industries)");
    expect(llm.calls[0].system).toContain("deployment-aware");
  });

  it("runs tools, persists evidence, narrates progress, and exits via submit_diagnosis", async () => {
    const llm = scriptedLlm([
      toolUse("query_logs", { customer: "acme", level: "error", hours_back: 72 }),
      toolUse("diff_customer_states", { a: "acme", b: "beta" }),
      toolUse("submit_diagnosis", GOOD_DIAGNOSIS_INPUT),
    ]);
    const { runner, store, reporter, inv } = harness(llm);
    const diagnosis = await runner.run(inv);

    expect(diagnosis.verdict).toBe("code-issue");
    expect(reporter.lines.some((l) => l.includes("Queried logs"))).toBe(true);
    expect(reporter.lines.some((l) => l.includes("Diffed acme vs beta"))).toBe(true);

    const stored = store.get(inv.id)!;
    expect(stored.status).toBe("diagnosed");
    expect(stored.diagnosis?.verdict).toBe("code-issue");
    expect(stored.evidence.length).toBeGreaterThanOrEqual(2);
    expect(stored.evidence.some((e) => e.kind === "state-delta")).toBe(true);
    // CodeFixBrief evidence trail is code-built
    const action = stored.diagnosis!.recommendedAction;
    if (action.type !== "code-fix") throw new Error("expected code-fix");
    expect(action.brief.ref).toBe("acme-prod-v2.3.1");
    expect(action.brief.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("re-prompts once on a prose ending, then accepts the diagnosis", async () => {
    const llm = scriptedLlm([prose("I think it's the flags."), toolUse("submit_diagnosis", GOOD_DIAGNOSIS_INPUT)]);
    const { runner, inv } = harness(llm);
    const diagnosis = await runner.run(inv);
    expect(diagnosis.verdict).toBe("code-issue");
    const secondCallMessages = llm.calls[1].messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(secondCallMessages.at(-1))).toContain("submit_diagnosis");
  });

  it("fails CLOSED to inconclusive after two prose endings", async () => {
    const llm = scriptedLlm([prose("hmm"), prose("still thinking")]);
    const { runner, store, inv } = harness(llm);
    const diagnosis = await runner.run(inv);
    expect(diagnosis.verdict).toBe("inconclusive");
    expect(diagnosis.recommendedAction.type).toBe("escalate");
    expect(store.get(inv.id)!.status).toBe("escalated");
  });

  it("fails CLOSED at the turn cap, summarizing gathered evidence", async () => {
    const llm = scriptedLlm([toolUse("resolve_customer_state", { customer: "acme" })]);
    const { runner, store, inv } = harness(llm, { maxTurns: 4 });
    const diagnosis = await runner.run(inv);
    expect(diagnosis.verdict).toBe("inconclusive");
    expect(diagnosis.reasoning).toContain("turn limit reached (4)");
    expect(diagnosis.reasoning).toContain("Resolved acme");
    expect(store.get(inv.id)!.status).toBe("escalated");
    expect(llm.calls).toHaveLength(4);
  });

  it("fails CLOSED when the token budget is exceeded", async () => {
    const llm = scriptedLlm([toolUse("resolve_customer_state", { customer: "acme" })]);
    const { runner, inv } = harness(llm, { tokenBudget: 250 }); // 150/turn in the script
    const diagnosis = await runner.run(inv);
    expect(diagnosis.verdict).toBe("inconclusive");
    expect(diagnosis.reasoning).toContain("token budget exceeded");
  });

  it("fails CLOSED when the LLM call throws", async () => {
    const llm: LlmClient = {
      messages: {
        async create() {
          throw new Error("api down");
        },
      },
    };
    const { runner, inv } = harness(llm);
    const diagnosis = await runner.run(inv);
    expect(diagnosis.verdict).toBe("inconclusive");
    expect(diagnosis.reasoning).toContain("api down");
  });

  it("times out a hung tool, reports the timeout to the model, and keeps looping", async () => {
    const hungLogs = { query: () => new Promise<never>(() => {}) };
    const llm = scriptedLlm([
      toolUse("query_logs", { customer: "acme" }),
      toolUse("submit_diagnosis", GOOD_DIAGNOSIS_INPUT),
    ]);
    const { runner, inv } = harness(llm, { toolTimeoutMs: 25 }, { logs: hungLogs });
    const diagnosis = await runner.run(inv);
    expect(diagnosis.verdict).toBe("code-issue"); // loop survived the hang
    const secondCall = JSON.stringify(llm.calls[1].messages);
    expect(secondCall).toContain("ERROR (timeout)");
    expect(secondCall).toContain("exceeded 25ms");
  });

  it("returns a rejection to the model on invalid submit_diagnosis, then accepts a corrected one", async () => {
    const llm = scriptedLlm([
      toolUse("submit_diagnosis", { verdict: "code-issue", culprit: "x", reasoning: "y", recommendedAction: { type: "escalate" } }),
      toolUse("submit_diagnosis", GOOD_DIAGNOSIS_INPUT),
    ]);
    const { runner, inv } = harness(llm);
    const diagnosis = await runner.run(inv);
    expect(diagnosis.verdict).toBe("code-issue");
    const secondCall = JSON.stringify(llm.calls[1].messages);
    expect(secondCall).toContain("rejected");
  });

  it("injects queued human thread replies into the next turn", async () => {
    const llm = scriptedLlm([
      toolUse("resolve_customer_state", { customer: "acme" }),
      toolUse("submit_diagnosis", GOOD_DIAGNOSIS_INPUT),
    ]);
    const { runner, store, inv } = harness(llm);
    store.pushContext(inv.id, "jordan: it started right after Tuesday's flag change");
    const diagnosis = await runner.run(inv);
    expect(diagnosis.verdict).toBe("code-issue");
    const secondCall = JSON.stringify(llm.calls[1].messages);
    expect(secondCall).toContain("Tuesday's flag change");
  });
});

describe("InvestigationStore", () => {
  it("round-trips investigations by id and thread", () => {
    const store = new InvestigationStore(":memory:");
    const inv = store.create({
      trigger: { channel: "C9", threadTs: "42.1", permalink: "p", text: "t" },
      customer: "acme",
    });
    expect(store.get(inv.id)?.customer).toBe("acme");
    expect(store.byThread("C9", "42.1")?.id).toBe(inv.id);
    expect(store.byThread("C9", "nope")).toBeUndefined();

    store.saveEvidence(inv.id, [
      { kind: "log-line", summary: "s", source: { source: "logs", evidenceUrl: "", observedAt: "", confidence: "confirmed" } },
    ]);
    expect(store.get(inv.id)!.evidence).toHaveLength(1);

    store.pushContext(inv.id, "hello");
    expect(store.drainContext(inv.id)).toEqual(["hello"]);
    expect(store.drainContext(inv.id)).toEqual([]);
  });
});
