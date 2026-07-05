import { describe, it, expect } from "vitest";
import { BootstrapFlow } from "../src/bootstrap/flow.js";
import { ProposalStore } from "../src/registry/proposals.js";
import { Registry } from "../src/registry/registry.js";
import { ok } from "../src/connectors/types.js";
import { FakeSlackSearch, FakeGitHub } from "../src/connectors/fakes/index.js";
import { buildTestWorld } from "./helpers.js";
import type { AnthropicLike } from "../src/triage.js";

/** The seeded #deploys history, as RTS would surface it. */
function seededSearch(): FakeSlackSearch {
  return new FakeSlackSearch([
    {
      matches: "shipped",
      results: [
        {
          text: "Shipped acme-prod-v2.3.1 to Acme 🚀 (tag `acme-prod-v2.3.1`, 2026-05-02). Reminder: Acme stays pinned — their upgrade window is quarterly, next one in September.",
          permalink: "https://sandbox.slack.com/archives/C0BEUB621F1/p100",
          author: "sam-eng",
          ts: "1746220980.000100",
        },
      ],
    },
    {
      matches: "rolled",
      results: [
        {
          text: "Beta Industries is now tracking `main` — rolled v2.5.0 out to them on 2026-06-10 ✅",
          permalink: "https://sandbox.slack.com/archives/C0BEUB621F1/p200",
          author: "sam-eng",
          ts: "1749570000.000100",
        },
      ],
    },
    {
      matches: "pinned",
      results: [
        {
          text: "FYI from CS: Acme's September upgrade window is confirmed for Sept 14–18. Until then they're on acme-prod-v2.3.1.",
          permalink: "https://sandbox.slack.com/archives/C0BEUB621F1/p300",
          author: "priya-support",
          ts: "1750900000.000100",
        },
      ],
    },
  ]);
}

/** Synthesis reply shaped like the real model's tool call. */
const SYNTHESIS_REPLY = {
  proposals: [
    {
      customer: "acme",
      displayName: "Acme Corp",
      refType: "tag",
      ref: "acme-prod-v2.3.1",
      versionPin: "v2.3.1",
      notes: ["Pinned; upgrade window quarterly, next Sept 14–18."],
      citations: [
        { url: "https://sandbox.slack.com/archives/C0BEUB621F1/p100", source: "slack" },
        { url: "https://sandbox.slack.com/archives/C0BEUB621F1/p300", source: "slack" },
      ],
      confidence: "inferred-high",
    },
    {
      customer: "beta",
      displayName: "Beta Industries",
      refType: "branch",
      ref: "main",
      versionPin: "v2.5.0",
      citations: [{ url: "https://sandbox.slack.com/archives/C0BEUB621F1/p200", source: "slack" }],
      confidence: "inferred-high",
    },
  ],
};

function fakeSynthesis(capture?: { evidence?: string }): AnthropicLike {
  return {
    messages: {
      async create(params: { messages: Array<{ content: string }> }) {
        if (capture) capture.evidence = params.messages[0].content;
        return { content: [{ type: "tool_use", name: "propose_registry", input: SYNTHESIS_REPLY }] };
      },
    },
  };
}

const EMPTY_MANIFEST = "customers: {}\n";

describe("BootstrapFlow", () => {
  it("fresh registry: mines evidence, synthesizes, proposes BOTH seeded customers with citations", async () => {
    const { github } = buildTestWorld();
    const registry = new Registry(async () => ok(EMPTY_MANIFEST));
    const proposals = new ProposalStore(":memory:");
    const capture: { evidence?: string } = {};
    const flow = new BootstrapFlow({
      slackSearch: seededSearch(),
      github,
      anthropic: fakeSynthesis(capture),
      registry,
      proposals,
      repo: "yourco/fake-product",
    });

    const result = await flow.run();
    expect(result.minedMessages).toBe(3);
    expect(result.proposals).toHaveLength(2);
    expect(result.skipped).toEqual([]);

    // evidence pack contains both slack messages and git refs
    expect(capture.evidence).toContain("Shipped acme-prod-v2.3.1");
    expect(capture.evidence).toContain("tag acme-prod-v2.3.1");
    expect(capture.evidence).toContain("branch main");

    const acme = result.proposals.find((p) => p.customer === "acme")!;
    expect(acme.kind).toBe("new-customer");
    expect(acme.entry).toMatchObject({
      displayName: "Acme Corp",
      code: { repo: "yourco/fake-product", refType: "tag" },
      config: { path: "customers/acme/values.yaml" },
      flagContext: { context: { userId: "acme" } },
    });
    expect(acme.entry!.versionPin.value).toBe("v2.3.1");
    expect(acme.entry!.versionPin.provenance.map((x) => x.evidenceUrl)).toContain(
      "https://sandbox.slack.com/archives/C0BEUB621F1/p100",
    );
    expect(acme.entry!.notes[0]).toContain("Sept");

    const beta = result.proposals.find((p) => p.customer === "beta")!;
    expect(beta.entry!.code.refType).toBe("branch");
    expect(beta.entry!.code.ref.value).toBe("main");

    // persisted as pending
    expect(proposals.pending()).toHaveLength(2);
  });

  it("already-correct registry entries are skipped; divergent ones become version-bumps", async () => {
    const world = buildTestWorld(); // registry manifest matches the synthesis exactly for acme+beta
    const proposals = new ProposalStore(":memory:");
    const flow = new BootstrapFlow({
      slackSearch: seededSearch(),
      github: world.github,
      anthropic: fakeSynthesis(),
      registry: world.registry,
      proposals,
      repo: "yourco/fake-product",
    });
    const result = await flow.run();
    expect(result.proposals).toHaveLength(0);
    expect(result.skipped.sort()).toEqual(["acme", "beta"]);

    // now make acme divergent (registry says v2.2.0)
    const divergent = new Registry(async () =>
      ok(`customers:
  acme:
    displayName: Acme Corp
    code: { repo: yourco/fake-product, refType: tag, ref: acme-prod-v2.2.0 }
    versionPin: v2.2.0
    flagContext: { provider: unleash, context: { userId: acme } }
`),
    );
    const flow2 = new BootstrapFlow({
      slackSearch: seededSearch(),
      github: world.github,
      anthropic: fakeSynthesis(),
      registry: divergent,
      proposals: new ProposalStore(":memory:"),
      repo: "yourco/fake-product",
    });
    const result2 = await flow2.run();
    const acmeBump = result2.proposals.find((p) => p.customer === "acme");
    expect(acmeBump?.kind).toBe("version-bump");
    expect(acmeBump?.change).toEqual({ versionPin: "v2.3.1", ref: "acme-prod-v2.3.1" });
  });

  it("degrades gracefully when RTS is unavailable (still proposes from git refs)", async () => {
    const search = new FakeSlackSearch();
    search.failWith = { reason: "auth", detail: "no action token" };
    const registry = new Registry(async () => ok(EMPTY_MANIFEST));
    const flow = new BootstrapFlow({
      slackSearch: search,
      github: buildTestWorld().github,
      anthropic: fakeSynthesis(),
      registry,
      proposals: new ProposalStore(":memory:"),
      repo: "yourco/fake-product",
    });
    const result = await flow.run();
    expect(result.minedMessages).toBe(0);
    expect(result.proposals).toHaveLength(2); // synthesis still ran on refs
  });

  it("drops synthesis items missing required fields", async () => {
    const registry = new Registry(async () => ok(EMPTY_MANIFEST));
    const bad: AnthropicLike = {
      messages: {
        async create() {
          return {
            content: [
              {
                type: "tool_use",
                name: "propose_registry",
                input: { proposals: [{ customer: "ghost", displayName: "Ghost" }] },
              },
            ],
          };
        },
      },
    };
    const flow = new BootstrapFlow({
      slackSearch: seededSearch(),
      github: new FakeGitHub(),
      anthropic: bad,
      registry,
      proposals: new ProposalStore(":memory:"),
      repo: "yourco/fake-product",
    });
    const result = await flow.run();
    expect(result.proposals).toHaveLength(0);
  });
});
