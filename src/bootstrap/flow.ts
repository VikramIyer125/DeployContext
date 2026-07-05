/**
 * BootstrapFlow (§5): not a separate machine — a batch of the same proposal
 * flow. RTS mining (code-owned queries) + gh.listRefs evidence → ONE synthesis
 * LLM call clusters evidence into Proposal[] → summary + per-customer confirm
 * cards (posted by the caller).
 */
import type { AnthropicLike } from "../triage.js";
import type { GitHubConnector, SlackSearch, SlackSearchResult } from "../connectors/types.js";
import type { Provenance, RegistryEntry } from "../domain/types.js";
import type { Proposal, ProposalStore } from "../registry/proposals.js";
import type { Registry } from "../registry/registry.js";
import { log } from "../log.js";

export const SYNTHESIS_MODEL = "claude-sonnet-4-6";

/** Code-owned mining queries — tuned against the seeded history. */
const MINING_QUERIES = [
  "shipped deployed customer version",
  "rolled out to customer",
  "pinned tag upgrade window",
  "tracking main deploy",
];

const SYNTHESIS_TOOL = {
  name: "propose_registry",
  description: "Propose deployment-registry entries synthesized from the evidence.",
  input_schema: {
    type: "object" as const,
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            customer: { type: "string", description: "short lowercase id, e.g. 'acme'" },
            displayName: { type: "string" },
            refType: { type: "string", enum: ["branch", "tag"] },
            ref: { type: "string", description: "git ref the customer runs" },
            versionPin: { type: "string", description: "e.g. v2.3.1" },
            notes: { type: "array", items: { type: "string" }, description: "tribal knowledge worth keeping, verbatim-ish" },
            citations: {
              type: "array",
              description: "evidence THIS proposal rests on",
              items: {
                type: "object",
                properties: {
                  url: { type: "string" },
                  source: { type: "string", enum: ["slack", "github"] },
                  quote: { type: "string" },
                },
                required: ["url", "source"],
              },
            },
            confidence: { type: "string", enum: ["inferred-high", "inferred-low"] },
          },
          required: ["customer", "displayName", "refType", "ref", "versionPin", "citations", "confidence"],
        },
      },
    },
    required: ["proposals"],
  },
};

const SYNTHESIS_SYSTEM = `You bootstrap a deployment registry for DeployContext by mining evidence. \
Given Slack messages (deploy announcements, support chatter) and the git refs of the product repo, \
cluster the evidence per CUSTOMER and propose what each customer is running: (git ref) + (version pin). \
Rules: only propose customers supported by actual evidence — never invent; prefer refs that exist in \
the provided ref list; a customer "tracking main" has refType branch/ref main; cite the specific \
messages/refs each proposal rests on; use confidence inferred-high only when version AND ref are \
directly stated. Notes should capture operational tribal knowledge (upgrade windows, pins) verbatim.`;

export interface BootstrapResult {
  proposals: Proposal[];
  /** Customers skipped because the registry already matches the evidence. */
  skipped: string[];
  minedMessages: number;
}

export interface BootstrapDeps {
  slackSearch: SlackSearch;
  github: GitHubConnector;
  anthropic: AnthropicLike;
  registry: Registry;
  proposals: ProposalStore;
  repo: string;
}

export class BootstrapFlow {
  constructor(private readonly deps: BootstrapDeps) {}

  async run(): Promise<BootstrapResult> {
    const { slackSearch, github, anthropic, registry, proposals, repo } = this.deps;

    // ---- Mine evidence (RTS + git refs), dedupe by permalink ---------------
    const messages = new Map<string, SlackSearchResult>();
    for (const q of MINING_QUERIES) {
      const res = await slackSearch.search(q);
      if (!res.ok) {
        log.warn("bootstrap mining query failed", { q, reason: res.reason, detail: res.detail });
        continue;
      }
      for (const m of res.data) messages.set(m.permalink || m.ts, m);
    }
    const refsRes = await github.listRefs(repo);
    const refs = refsRes.ok ? refsRes.data : [];
    if (!refsRes.ok) log.warn("bootstrap listRefs failed", { detail: refsRes.detail });

    const evidenceBlock = [
      `## Slack messages (${messages.size})`,
      ...[...messages.values()].map((m) => `- [${m.author}] "${m.text.slice(0, 400)}" (${m.permalink})`),
      ``,
      `## Git refs of ${repo} (${refs.length})`,
      ...refs.map((r) => `- ${r.type} ${r.name} (last commit ${r.lastCommitAt})`),
    ].join("\n");

    // ---- One synthesis call -------------------------------------------------
    const resp = await anthropic.messages.create({
      model: SYNTHESIS_MODEL,
      max_tokens: 2000,
      system: SYNTHESIS_SYSTEM,
      tools: [SYNTHESIS_TOOL],
      tool_choice: { type: "tool", name: "propose_registry" },
      messages: [{ role: "user", content: evidenceBlock }],
    });
    const toolUse = resp.content.find((c) => c.type === "tool_use" && c.name === "propose_registry");
    const raw = ((toolUse?.input ?? {}) as { proposals?: unknown[] }).proposals ?? [];

    // ---- Graduate into pending proposals (skip already-correct entries) ----
    await registry.ensureLoaded();
    const created: Proposal[] = [];
    const skipped: string[] = [];

    for (const item of raw) {
      const p = item as {
        customer: string;
        displayName: string;
        refType: "branch" | "tag";
        ref: string;
        versionPin: string;
        notes?: string[];
        citations: Array<{ url: string; source: "slack" | "github" }>;
        confidence: "inferred-high" | "inferred-low";
      };
      if (!p.customer || !p.ref || !p.versionPin) continue;
      const customer = p.customer.toLowerCase();

      const provenance: Provenance[] = p.citations.slice(0, 4).map((c) => ({
        source: c.source,
        evidenceUrl: c.url,
        observedAt: new Date().toISOString(),
        confidence: p.confidence,
      }));

      const existing = this.deps.registry.get(customer);
      if (existing && existing.versionPin.value === p.versionPin && existing.code.ref.value === p.ref) {
        skipped.push(customer);
        continue;
      }

      if (existing) {
        created.push(
          proposals.create({
            kind: "version-bump",
            customer,
            change: { versionPin: p.versionPin, ref: p.ref },
            provenance,
          }),
        );
        continue;
      }

      const entry: RegistryEntry = {
        customer,
        displayName: p.displayName || customer,
        code: { repo, refType: p.refType, ref: { value: p.ref, provenance } },
        versionPin: { value: p.versionPin, provenance },
        flagContext: { provider: "unleash", context: { userId: customer, environment: "production" } },
        config: { repo, path: `customers/${customer}/values.yaml` },
        notes: (p.notes ?? []).slice(0, 5),
        slackChannels: [],
      };
      created.push(proposals.create({ kind: "new-customer", customer, entry, provenance }));
    }

    return { proposals: created, skipped, minedMessages: messages.size };
  }
}
