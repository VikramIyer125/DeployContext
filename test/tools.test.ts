import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import type { Investigation } from "../src/domain/types.js";
import { ToolRegistry } from "../src/investigate/tools.js";
import { StateResolver } from "../src/resolve/resolver.js";
import { SeededLogSource } from "../src/connectors/logs.js";
import { FakeSlackSearch } from "../src/connectors/fakes/index.js";
import { buildTestWorld } from "./helpers.js";

const FIXTURE_PATH = join(process.cwd(), "fixtures", "logs.json");

function makeInv(): Investigation {
  return {
    id: "test-inv",
    trigger: { channel: "C1", threadTs: "1.0", permalink: "https://slack/x", text: "exports failing" },
    customer: "acme",
    evidence: [],
    status: "running",
  };
}

async function makeRegistry() {
  const world = buildTestWorld();
  await world.registry.ensureLoaded();
  const resolver = new StateResolver({
    registry: world.registry,
    github: world.github,
    unleash: world.unleash,
    unleashBaseUrl: "http://localhost:4242",
  });
  const slackSearch = new FakeSlackSearch([
    {
      matches: "acme",
      results: [
        {
          text: "Shipped acme-prod-v2.3.1 to Acme 🚀 (tag acme-prod-v2.3.1, 2026-05-02)",
          permalink: "https://sandbox.slack.com/archives/C0BEUB621F1/p1",
          author: "sam-eng",
          ts: "1746220000.000100",
        },
      ],
    },
    {
      matches: "export",
      results: [
        {
          text: "Jordan at Acme mentioned exports \"sometimes look off\" — couldn't reproduce",
          permalink: "https://sandbox.slack.com/archives/C0BF6DCE31T/p2",
          author: "priya-support",
          ts: "1750220000.000200",
        },
      ],
    },
  ]);
  const tools = new ToolRegistry({
    registry: world.registry,
    resolver,
    github: world.github,
    unleash: world.unleash,
    logs: new SeededLogSource(FIXTURE_PATH, { rebaseToNow: true }),
    slackSearch,
    unleashBaseUrl: "http://localhost:4242",
    githubTree: (repo, ref) => world.github.listTree(repo, ref),
  });
  return { tools, world, slackSearch };
}

describe("ToolRegistry", () => {
  let inv: Investigation;
  beforeEach(() => {
    inv = makeInv();
  });

  it("exposes the full curated menu of 8 tools", async () => {
    const { tools } = await makeRegistry();
    expect(tools.definitions().map((d) => d.name)).toEqual([
      "resolve_customer_state",
      "diff_customer_states",
      "find_deploy_announcements",
      "find_prior_reports",
      "search_slack_freeform",
      "query_logs",
      "read_code_at_customer_ref",
      "submit_diagnosis",
    ]);
  });

  it("resolve_customer_state returns state and appends flag-state evidence with provenance", async () => {
    const { tools } = await makeRegistry();
    const out = await tools.execute("resolve_customer_state", { customer: "acme" }, inv);
    const parsed = JSON.parse(out.resultText);
    expect(parsed.version).toBe("v2.3.1");
    expect(parsed.flags.new_billing).toBe(true);
    expect(parsed.notes).toHaveLength(1);
    expect(inv.evidence).toHaveLength(1);
    expect(inv.evidence[0]).toMatchObject({ kind: "flag-state" });
    expect(inv.evidence[0].summary).toContain("new_billing=true");
    expect(inv.evidence[0].source.source).toBe("unleash");
    expect(out.progressLine).toContain("Acme Corp");
  });

  it("diff_customer_states returns the delta and appends state-delta evidence", async () => {
    const { tools } = await makeRegistry();
    const out = await tools.execute("diff_customer_states", { a: "acme", b: "beta" }, inv);
    const parsed = JSON.parse(out.resultText);
    expect(parsed.versionDelta).toEqual({ a: "v2.3.1", b: "v2.5.0" });
    expect(parsed.flagDeltas.map((f: { flag: string }) => f.flag)).toContain("new_billing");
    const delta = inv.evidence.find((e) => e.kind === "state-delta");
    expect(delta).toBeDefined();
    expect(delta!.summary).toContain("new_billing");
  });

  it("query_logs summarizes and appends log-line evidence only when matches exist", async () => {
    const { tools } = await makeRegistry();
    const out = await tools.execute(
      "query_logs",
      { customer: "acme", level: "error", text: "ledgerRef", hours_back: 72 },
      inv,
    );
    const parsed = JSON.parse(out.resultText);
    expect(parsed.matchCount).toBeGreaterThanOrEqual(1);
    expect(parsed.sample.length).toBeLessThanOrEqual(10);
    expect(inv.evidence[0]).toMatchObject({ kind: "log-line" });
    expect(inv.evidence[0].source.confidence).toBe("confirmed");

    const none = await tools.execute("query_logs", { text: "zebra-unicorn" }, inv);
    expect(JSON.parse(none.resultText).matchCount).toBe(0);
    expect(inv.evidence).toHaveLength(1); // no evidence appended for zero matches
  });

  it("find_deploy_announcements uses a code-owned query and appends slack-message evidence", async () => {
    const { tools, slackSearch } = await makeRegistry();
    const out = await tools.execute("find_deploy_announcements", { customer: "acme" }, inv);
    expect(JSON.parse(out.resultText).matchCount).toBe(1);
    expect(slackSearch.queries[0].query).toContain("acme");
    expect(slackSearch.queries[0].query).toContain("shipped");
    expect(inv.evidence[0]).toMatchObject({ kind: "slack-message" });
    expect(inv.evidence[0].source.evidenceUrl).toContain("slack.com");
    expect(inv.evidence[0].source.confidence).toBe("inferred-high");
  });

  it("surfaces slack search failure as data, without evidence", async () => {
    const { tools, slackSearch } = await makeRegistry();
    slackSearch.failWith = { reason: "auth", detail: "no RTS action token available yet" };
    const out = await tools.execute("find_prior_reports", { symptom: "exports failing" }, inv);
    expect(out.resultText).toContain("ERROR (auth)");
    expect(out.resultText).toContain("not a dead end");
    expect(inv.evidence).toHaveLength(0);
  });

  it("read_code_at_customer_ref reads at the customer's pinned ref and appends code-snippet evidence", async () => {
    const { tools, world } = await makeRegistry();
    world.github.files["acme-prod-v2.3.1"]["src/exportService.ts"] = "export class ExportService {}\n";
    const out = await tools.execute(
      "read_code_at_customer_ref",
      { customer: "acme", path: "src/exportService.ts" },
      inv,
    );
    expect(out.resultText).toContain("@ acme-prod-v2.3.1");
    expect(out.resultText).toContain("ExportService");
    expect(inv.evidence[0]).toMatchObject({ kind: "code-snippet" });
    expect(inv.evidence[0].source.evidenceUrl).toContain("blob/acme-prod-v2.3.1");
  });

  it("read_code returns the file list on a path miss", async () => {
    const { tools } = await makeRegistry();
    const out = await tools.execute(
      "read_code_at_customer_ref",
      { customer: "acme", path: "src/nope.ts" },
      inv,
    );
    expect(out.resultText).toContain("not found");
    expect(out.resultText).toContain("customers/acme/values.yaml");
    expect(inv.evidence).toHaveLength(0);
  });

  it("truncates oversized code files", async () => {
    const { tools, world } = await makeRegistry();
    world.github.files["acme-prod-v2.3.1"]["big.ts"] = Array(500).fill("// line").join("\n");
    const out = await tools.execute("read_code_at_customer_ref", { customer: "acme", path: "big.ts" }, inv);
    expect(out.resultText).toContain("(truncated)");
    expect(out.resultText.split("\n").length).toBeLessThan(320);
  });

  describe("submit_diagnosis", () => {
    it("accepts a code-issue with code-fix and assembles the full CodeFixBrief", async () => {
      const { tools } = await makeRegistry();
      inv.evidence.push({
        kind: "log-line",
        summary: "6 errors",
        source: { source: "logs", evidenceUrl: "fixture://logs.json", observedAt: "2026-07-05", confidence: "confirmed" },
      });
      const out = await tools.execute(
        "submit_diagnosis",
        {
          verdict: "code-issue",
          culprit: "new_billing=on + legacy_export=off on v2.3.1",
          reasoning: "billing formatter requires ledgerRef stamped only by legacy exporter",
          recommendedAction: {
            type: "code-fix",
            brief: {
              bugSummary: "formatBillingRow throws when legacy_export is off",
              reproductionConditions: {
                flags: { new_billing: true, legacy_export: false },
                versionNote: "only on v2.3.1 (tag acme-prod-v2.3.1); main has a guard",
              },
            },
          },
        },
        inv,
      );
      expect(out.diagnosis).toBeDefined();
      const action = out.diagnosis!.recommendedAction;
      expect(action.type).toBe("code-fix");
      if (action.type !== "code-fix") return;
      // deterministic fields filled by code, not the model
      expect(action.brief.repo).toBe("yourco/fake-product");
      expect(action.brief.ref).toBe("acme-prod-v2.3.1");
      expect(action.brief.evidence).toHaveLength(1);
      expect(action.brief.constraints).toContain("minimal diff");
    });

    it("rejects a verdict/action mismatch", async () => {
      const { tools } = await makeRegistry();
      const out = await tools.execute(
        "submit_diagnosis",
        {
          verdict: "code-issue",
          culprit: "x",
          reasoning: "y",
          recommendedAction: { type: "escalate", toHuman: "z" },
        },
        inv,
      );
      expect(out.diagnosis).toBeUndefined();
      expect(out.resultText).toContain("rejected");
      expect(out.resultText).toContain("code-fix");
    });

    it("rejects an invalid verdict and empty fields", async () => {
      const { tools } = await makeRegistry();
      const out = await tools.execute(
        "submit_diagnosis",
        { verdict: "maybe", culprit: "", reasoning: "", recommendedAction: { type: "escalate" } },
        inv,
      );
      expect(out.diagnosis).toBeUndefined();
      expect(out.resultText).toContain("verdict");
      expect(out.resultText).toContain("culprit");
    });

    it("accepts config-issue with flag-change", async () => {
      const { tools } = await makeRegistry();
      const out = await tools.execute(
        "submit_diagnosis",
        {
          verdict: "config-issue",
          culprit: "legacy_export disabled prematurely",
          reasoning: "ops should re-enable until v2.5 upgrade",
          recommendedAction: { type: "flag-change", changes: [{ flag: "legacy_export", to: true }] },
        },
        inv,
      );
      expect(out.diagnosis?.verdict).toBe("config-issue");
    });
  });

  it("unknown tool name returns an error as data", async () => {
    const { tools } = await makeRegistry();
    const out = await tools.execute("rm_rf_slash", {}, inv);
    expect(out.resultText).toContain("unknown tool");
  });
});
