import { describe, it, expect } from "vitest";
import { classifyDeployMessage, draftBumpProposal } from "../src/deploywatch/listener.js";
import { ProposalStore } from "../src/registry/proposals.js";
import { buildTestWorld } from "./helpers.js";
import type { AnthropicLike } from "../src/triage.js";

function fakeAnthropic(reply: unknown): AnthropicLike {
  return {
    messages: {
      async create() {
        return { content: [{ type: "tool_use", name: "classify_deploy", input: reply }] };
      },
    },
  };
}

describe("classifyDeployMessage", () => {
  it("parses announcement hits with customer/version/ref", async () => {
    const out = await classifyDeployMessage(
      fakeAnthropic({ is_deploy_announcement: true, customer: "Acme", version: "v2.5.0", ref: "v2.5.0" }),
      "shipped v2.5 to Acme 🚀",
    );
    expect(out).toEqual({ isAnnouncement: true, customer: "acme", version: "v2.5.0", ref: "v2.5.0" });
  });

  it("parses misses and malformed replies safely", async () => {
    expect(
      await classifyDeployMessage(fakeAnthropic({ is_deploy_announcement: false }), "lunch train 12:30"),
    ).toEqual({ isAnnouncement: false, customer: undefined, version: undefined, ref: undefined });
    expect((await classifyDeployMessage(fakeAnthropic({}), "?")).isAnnouncement).toBe(false);
  });
});

describe("draftBumpProposal", () => {
  async function setup() {
    const { registry } = buildTestWorld();
    await registry.ensureLoaded();
    return { registry, proposals: new ProposalStore(":memory:") };
  }

  it("drafts a version-bump with slack permalink provenance (inferred-high)", async () => {
    const { registry, proposals } = await setup();
    const p = draftBumpProposal({
      announcement: { isAnnouncement: true, customer: "acme", version: "v2.5.0", ref: "v2.5.0" },
      registry,
      proposals,
      permalink: "https://sandbox.slack.com/archives/C0BEUB621F1/p999",
    });
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("version-bump");
    expect(p!.change).toEqual({ versionPin: "v2.5.0", ref: "v2.5.0" });
    expect(p!.provenance[0]).toMatchObject({
      source: "slack",
      evidenceUrl: "https://sandbox.slack.com/archives/C0BEUB621F1/p999",
      confidence: "inferred-high",
    });
    expect(proposals.get(p!.id)).toBeDefined();
  });

  it("matches customers by display-name first word", async () => {
    const { registry, proposals } = await setup();
    const p = draftBumpProposal({
      announcement: { isAnnouncement: true, customer: "beta", version: "v2.6.0" },
      registry,
      proposals,
      permalink: "",
    });
    expect(p?.customer).toBe("beta");
  });

  it("skips no-ops, unknown customers, and non-announcements", async () => {
    const { registry, proposals } = await setup();
    // acme already pins v2.3.1
    expect(
      draftBumpProposal({
        announcement: { isAnnouncement: true, customer: "acme", version: "v2.3.1" },
        registry,
        proposals,
        permalink: "",
      }),
    ).toBeNull();
    expect(
      draftBumpProposal({
        announcement: { isAnnouncement: true, customer: "globex", version: "v9" },
        registry,
        proposals,
        permalink: "",
      }),
    ).toBeNull();
    expect(
      draftBumpProposal({
        announcement: { isAnnouncement: false },
        registry,
        proposals,
        permalink: "",
      }),
    ).toBeNull();
    expect(
      draftBumpProposal({
        announcement: { isAnnouncement: true, customer: "acme" }, // nothing to change
        registry,
        proposals,
        permalink: "",
      }),
    ).toBeNull();
  });
});
