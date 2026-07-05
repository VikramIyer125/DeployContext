/**
 * Haiku triage — the cheap router in front of everything. Classifies INTENT
 * only; whether an issue is config vs code is the investigation's OUTPUT,
 * never a routing decision.
 *
 * Customer resolution order (MUST, §5): channel mapping → text extraction
 * (validated against the registry) → ask one clarifying question. NEVER
 * launch an investigation against a guessed customer.
 */
import type { RegistryEntry } from "./domain/types.js";
import type { Registry } from "./registry/registry.js";

export type TriageMode = "query" | "investigate" | "registry-update" | "bootstrap" | "chitchat";

export interface TriageResult {
  mode: TriageMode;
  /** Raw customer mention extracted from text; must be validated against the registry. */
  customer?: string;
}

export interface ThreadMessage {
  author: string;
  text: string;
}

/** Minimal surface of the Anthropic SDK used here — lets tests inject a fake. */
export interface AnthropicLike {
  messages: {
    // params typed loosely so both the real SDK client and test fakes fit
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(params: any): Promise<{
      content: Array<{ type: string; name?: string; input?: unknown }>;
    }>;
  };
}

export const TRIAGE_MODEL = "claude-haiku-4-5";

const MODES: TriageMode[] = ["query", "investigate", "registry-update", "bootstrap", "chitchat"];

const TRIAGE_SYSTEM = `You route messages for DeployContext, a Slack agent that tracks what \
software each enterprise customer runs (version pin × feature flags × config) and investigates \
customer bug reports.

Classify the user's INTENT into exactly one mode:
- "query": asking what a customer is running / registry lookup ("what is Acme on?", "which flags does Beta have?")
- "investigate": reporting or escalating a problem to dig into ("exports are failing for Acme", "take care of this", "look into this")
- "registry-update": stating a deployment fact to record ("Acme moved to v2.5", "update the registry: …")
- "bootstrap": asking to build/rebuild the registry from history ("bootstrap the registry", "scan history and propose entries")
- "chitchat": greetings, thanks, questions about the agent itself, anything else

Rules:
- Classify intent ONLY. Never decide whether an issue is a config or code problem — that is the investigation's job.
- The mention may reply to earlier thread messages; "this" usually refers to the thread context provided.
- Also extract the customer name/identifier if one is stated or clearly implied by the text (e.g. "Acme says exports fail" → "acme"). Leave it out if no specific customer is identifiable. Do not guess.`;

const TRIAGE_TOOL = {
  name: "classify",
  description: "Report the classified intent of the message.",
  input_schema: {
    type: "object" as const,
    properties: {
      mode: { type: "string", enum: MODES },
      customer: {
        type: "string",
        description: "Customer name/identifier mentioned in the text, lowercased. Omit if none.",
      },
    },
    required: ["mode"],
  },
};

export async function triage(
  anthropic: AnthropicLike,
  input: { text: string; threadContext: ThreadMessage[] },
): Promise<TriageResult> {
  const contextBlock =
    input.threadContext.length > 0
      ? `Thread context (earlier messages, oldest first):\n${input.threadContext
          .map((m) => `- ${m.author}: ${m.text}`)
          .join("\n")}\n\n`
      : "";

  const resp = await anthropic.messages.create({
    model: TRIAGE_MODEL,
    max_tokens: 200,
    system: TRIAGE_SYSTEM,
    tools: [TRIAGE_TOOL],
    tool_choice: { type: "tool", name: "classify" },
    messages: [
      {
        role: "user",
        content: `${contextBlock}Message mentioning the agent:\n${input.text}`,
      },
    ],
  });

  const toolUse = resp.content.find((c) => c.type === "tool_use" && c.name === "classify");
  const parsed = (toolUse?.input ?? {}) as { mode?: string; customer?: string };
  if (!parsed.mode || !MODES.includes(parsed.mode as TriageMode)) {
    return { mode: "chitchat" };
  }
  return {
    mode: parsed.mode as TriageMode,
    customer: parsed.customer?.trim().toLowerCase() || undefined,
  };
}

export type CustomerResolution =
  | { kind: "resolved"; entry: RegistryEntry; via: "channel" | "text" }
  | { kind: "ask" };

/**
 * §5 customer resolution order: channel mapping wins, then registry-validated
 * text extraction, else ask. Pure given a loaded registry.
 */
export function resolveCustomer(opts: {
  channelId: string;
  extracted?: string;
  registry: Registry;
}): CustomerResolution {
  const byChannel = opts.registry.byChannel(opts.channelId);
  if (byChannel) return { kind: "resolved", entry: byChannel, via: "channel" };

  if (opts.extracted) {
    const needle = opts.extracted.trim().toLowerCase();
    for (const entry of opts.registry.list()) {
      const display = entry.displayName.toLowerCase();
      if (
        entry.customer.toLowerCase() === needle ||
        display === needle ||
        display.split(/\s+/)[0] === needle
      ) {
        return { kind: "resolved", entry, via: "text" };
      }
    }
  }
  return { kind: "ask" };
}
