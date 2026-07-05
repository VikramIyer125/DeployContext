import { describe, it, expect } from "vitest";
import { triage, resolveCustomer, TRIAGE_MODEL, type AnthropicLike } from "../src/triage.js";
import { buildTestWorld } from "./helpers.js";

function fakeAnthropic(reply: unknown, capture?: { params?: Record<string, unknown> }): AnthropicLike {
  return {
    messages: {
      async create(params) {
        if (capture) capture.params = params;
        return {
          content: [{ type: "tool_use", name: "classify", input: reply }],
        };
      },
    },
  };
}

describe("triage", () => {
  it("parses mode and lowercases the extracted customer", async () => {
    const result = await triage(fakeAnthropic({ mode: "investigate", customer: "Acme" }), {
      text: "Acme says exports are failing",
      threadContext: [],
    });
    expect(result).toEqual({ mode: "investigate", customer: "acme" });
  });

  it("omits customer when the model doesn't extract one", async () => {
    const result = await triage(fakeAnthropic({ mode: "bootstrap" }), {
      text: "bootstrap the registry",
      threadContext: [],
    });
    expect(result).toEqual({ mode: "bootstrap", customer: undefined });
  });

  it("falls back to chitchat on an invalid mode", async () => {
    const result = await triage(fakeAnthropic({ mode: "self-destruct" }), {
      text: "hello",
      threadContext: [],
    });
    expect(result).toEqual({ mode: "chitchat" });
  });

  it("falls back to chitchat when no tool_use block comes back", async () => {
    const anthropic: AnthropicLike = {
      messages: { async create() { return { content: [{ type: "text" }] }; } },
    };
    const result = await triage(anthropic, { text: "hi", threadContext: [] });
    expect(result).toEqual({ mode: "chitchat" });
  });

  it("sends thread context, forces the classify tool, and uses Haiku", async () => {
    const capture: { params?: Record<string, unknown> } = {};
    await triage(fakeAnthropic({ mode: "investigate" }, capture), {
      text: "take care of this",
      threadContext: [
        { author: "jordan", text: "our exports are failing since yesterday" },
        { author: "sam", text: "seeing it too" },
      ],
    });
    expect(capture.params?.model).toBe(TRIAGE_MODEL);
    expect(capture.params?.tool_choice).toEqual({ type: "tool", name: "classify" });
    const messages = capture.params?.messages as Array<{ content: string }>;
    expect(messages[0].content).toContain("our exports are failing since yesterday");
    expect(messages[0].content).toContain("take care of this");
  });
});

describe("resolveCustomer (§5 MUST order)", () => {
  it("channel mapping wins even over contradicting extracted text", async () => {
    const { registry } = buildTestWorld();
    await registry.ensureLoaded();
    const res = resolveCustomer({ channelId: "C0123ACME", extracted: "beta", registry });
    expect(res).toMatchObject({ kind: "resolved", via: "channel" });
    if (res.kind !== "resolved") return;
    expect(res.entry.customer).toBe("acme");
  });

  it("falls back to registry-validated text extraction by id", async () => {
    const { registry } = buildTestWorld();
    await registry.ensureLoaded();
    const res = resolveCustomer({ channelId: "C_RANDOM", extracted: "beta", registry });
    expect(res).toMatchObject({ kind: "resolved", via: "text" });
    if (res.kind !== "resolved") return;
    expect(res.entry.customer).toBe("beta");
  });

  it("matches display name and its first word, case-insensitively", async () => {
    const { registry } = buildTestWorld();
    await registry.ensureLoaded();
    expect(resolveCustomer({ channelId: "C_X", extracted: "acme corp", registry })).toMatchObject({
      kind: "resolved",
    });
    expect(resolveCustomer({ channelId: "C_X", extracted: "ACME", registry })).toMatchObject({
      kind: "resolved",
    });
  });

  it("asks rather than guessing when nothing resolves", async () => {
    const { registry } = buildTestWorld();
    await registry.ensureLoaded();
    expect(resolveCustomer({ channelId: "C_X", extracted: "globex", registry })).toEqual({ kind: "ask" });
    expect(resolveCustomer({ channelId: "C_X", registry })).toEqual({ kind: "ask" });
  });
});
