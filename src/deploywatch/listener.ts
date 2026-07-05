/**
 * Deploy-watch (§5): passive listening scoped to ONE configured channel.
 * Haiku classifies "is this a deploy announcement?"; hits become version-bump
 * Proposals (provenance = message permalink, inferred-high) behind a confirm
 * card. NO proactive issue-detection anywhere.
 */
import type { AnthropicLike } from "../triage.js";
import type { Registry } from "../registry/registry.js";
import type { Proposal, ProposalStore } from "../registry/proposals.js";

export const DEPLOY_CLASSIFIER_MODEL = "claude-haiku-4-5";

const CLASSIFY_TOOL = {
  name: "classify_deploy",
  description: "Report whether the message announces a customer deployment.",
  input_schema: {
    type: "object" as const,
    properties: {
      is_deploy_announcement: {
        type: "boolean",
        description: "true only for a CUSTOMER-facing deploy/rollout/pin announcement (staging/internal-only do not count)",
      },
      customer: { type: "string", description: "customer name mentioned, lowercased" },
      version: { type: "string", description: "version like v2.5.0, if stated" },
      ref: { type: "string", description: "git ref/tag/branch, if stated" },
    },
    required: ["is_deploy_announcement"],
  },
};

const SYSTEM = `You watch a #deploys channel for DeployContext. Decide whether a message announces \
that a CUSTOMER is now running something new (deploy/rollout/version pin change for a named customer). \
Staging, dogfood, internal-only, CI chatter, or reminders about future windows are NOT announcements. \
Extract customer/version/ref only when explicitly stated.`;

export interface DeployAnnouncement {
  isAnnouncement: boolean;
  customer?: string;
  version?: string;
  ref?: string;
}

export async function classifyDeployMessage(
  anthropic: AnthropicLike,
  text: string,
): Promise<DeployAnnouncement> {
  const resp = await anthropic.messages.create({
    model: DEPLOY_CLASSIFIER_MODEL,
    max_tokens: 200,
    system: SYSTEM,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_deploy" },
    messages: [{ role: "user", content: `Message posted in #deploys:\n${text}` }],
  });
  const toolUse = resp.content.find((c) => c.type === "tool_use" && c.name === "classify_deploy");
  const parsed = (toolUse?.input ?? {}) as {
    is_deploy_announcement?: boolean;
    customer?: string;
    version?: string;
    ref?: string;
  };
  return {
    isAnnouncement: parsed.is_deploy_announcement === true,
    customer: parsed.customer?.trim().toLowerCase() || undefined,
    version: parsed.version?.trim() || undefined,
    ref: parsed.ref?.trim() || undefined,
  };
}

/**
 * Turn a classified announcement into a pending version-bump Proposal.
 * Returns null when it isn't actionable (not an announcement / unknown
 * customer / nothing to change).
 */
export function draftBumpProposal(opts: {
  announcement: DeployAnnouncement;
  registry: Registry;
  proposals: ProposalStore;
  permalink: string;
}): Proposal | null {
  const { announcement, registry, proposals, permalink } = opts;
  if (!announcement.isAnnouncement || !announcement.customer) return null;

  const entry =
    registry.get(announcement.customer) ??
    registry.list().find((e) => e.displayName.toLowerCase().split(/\s+/)[0] === announcement.customer);
  if (!entry) return null;

  const versionPin = announcement.version;
  const ref = announcement.ref;
  if (!versionPin && !ref) return null;

  // Skip no-ops (already at this version/ref).
  if (
    (!versionPin || entry.versionPin.value === versionPin) &&
    (!ref || entry.code.ref.value === ref)
  ) {
    return null;
  }

  return proposals.create({
    kind: "version-bump",
    customer: entry.customer,
    change: {
      ...(versionPin && entry.versionPin.value !== versionPin ? { versionPin } : {}),
      ...(ref && entry.code.ref.value !== ref ? { ref } : {}),
    },
    provenance: [
      {
        source: "slack",
        evidenceUrl: permalink,
        observedAt: new Date().toISOString(),
        confidence: "inferred-high",
      },
    ],
  });
}
