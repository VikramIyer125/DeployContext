/**
 * Pure formatting of resolved state (and friends) into Slack blocks.
 * Every claim carries its provenance line — that's the product.
 */
import { dump } from "js-yaml";
import type { Diagnosis, Investigation, Provenance, RegistryEntry } from "../domain/types.js";
import type { ResolveOutcome } from "../resolve/resolver.js";

type Block = Record<string, unknown>;

function provenanceLine(items: Provenance[]): string {
  if (items.length === 0) return "_no provenance recorded_";
  return items
    .map((p) => {
      const label = `${p.source} · ${p.confidence} · ${p.observedAt.slice(0, 10)}`;
      return p.evidenceUrl ? `<${p.evidenceUrl}|${label}>` : label;
    })
    .join("  ·  ");
}

function mrkdwn(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

export function formatState(
  entry: RegistryEntry,
  outcome: ResolveOutcome,
): { text: string; blocks: Block[] } {
  const { state, warnings } = outcome;

  const flagEntries = Object.entries(state.flags.value).sort(([x], [y]) => x.localeCompare(y));
  const enabled = flagEntries.filter(([, v]) => v === true).map(([k]) => k);
  const disabled = flagEntries.filter(([, v]) => v === false).map(([k]) => k);
  const variants = flagEntries.filter(([, v]) => typeof v === "string");

  const flagLines = [
    enabled.length ? `*on:* ${enabled.map((f) => `\`${f}\``).join(" ")}` : null,
    disabled.length ? `*off:* ${disabled.map((f) => `\`${f}\``).join(" ")}` : null,
    variants.length ? `*variants:* ${variants.map(([k, v]) => `\`${k}=${v}\``).join(" ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const configYaml = dump(state.config.value, { lineWidth: 60 }).trimEnd();
  const configShown =
    configYaml.split("\n").length > 16
      ? configYaml.split("\n").slice(0, 16).join("\n") + "\n# … truncated"
      : configYaml;

  const blocks: Block[] = [
    mrkdwn(
      `:package: *${entry.displayName}* (\`${entry.customer}\`) is running *${state.version.value}* — ` +
        `\`${entry.code.repo}\` @ \`${entry.code.ref.value}\` (${entry.code.refType})`,
    ),
    context(`version: ${provenanceLine(state.version.provenance)} · ref: ${provenanceLine(entry.code.ref.provenance)}`),
    mrkdwn(`*Feature flags* (${flagEntries.length} evaluated live)\n${flagLines || "_none_"}`),
    context(`flags: ${provenanceLine(state.flags.provenance)}`),
    mrkdwn(`*Config* ${entry.config ? `(\`${entry.config.path}\` @ \`${entry.code.ref.value}\`)` : ""}\n\`\`\`${configShown}\`\`\``),
    context(`config: ${provenanceLine(state.config.provenance)}`),
  ];

  if (entry.notes.length > 0) {
    blocks.push(context(`:memo: ${entry.notes.join(" · ")}`));
  }
  if (warnings.length > 0) {
    blocks.push(context(`:warning: ${warnings.join(" · ")}`));
  }

  const text =
    `${entry.displayName} is running ${state.version.value} ` +
    `(${entry.code.repo}@${entry.code.ref.value}); flags on: ${enabled.join(", ") || "none"}`;

  return { text, blocks };
}

const VERDICT_META: Record<Diagnosis["verdict"], { emoji: string; label: string }> = {
  "code-issue": { emoji: ":bug:", label: "Code issue" },
  "config-issue": { emoji: ":gear:", label: "Config issue" },
  inconclusive: { emoji: ":grey_question:", label: "Inconclusive" },
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The diagnosis card posted in-thread. On a code-issue verdict it carries the
 * "Attempt fix →" button — the MANDATORY human approval gate; the CodeFixer
 * never launches without that click.
 */
export function formatDiagnosis(
  inv: Investigation,
  diagnosis: Diagnosis,
): { text: string; blocks: Block[] } {
  const meta = VERDICT_META[diagnosis.verdict];
  const blocks: Block[] = [
    mrkdwn(`${meta.emoji} *Diagnosis: ${meta.label}* — ${truncate(diagnosis.culprit, 300)}`),
    mrkdwn(truncate(diagnosis.reasoning, 2500)),
  ];

  if (inv.evidence.length > 0) {
    const items = inv.evidence.slice(0, 6).map((e) => {
      const label = truncate(e.summary, 180);
      const link = e.source.evidenceUrl && e.source.evidenceUrl.startsWith("http")
        ? ` (<${e.source.evidenceUrl}|${e.source.source}>)`
        : ` (${e.source.source})`;
      return `• _${e.kind}_: ${label}${link}`;
    });
    blocks.push(mrkdwn(`*Evidence* (${inv.evidence.length} items, gathered structurally)\n${items.join("\n")}`));
  }

  const action = diagnosis.recommendedAction;
  if (action.type === "flag-change") {
    blocks.push(
      mrkdwn(
        `*Recommended:* flag change\n${action.changes.map((c) => `• \`${c.flag}\` → \`${String(c.to)}\``).join("\n")}`,
      ),
    );
  } else if (action.type === "code-fix") {
    const flags = Object.entries(action.brief.reproductionConditions.flags)
      .map(([k, v]) => `\`${k}=${String(v)}\``)
      .join(" ");
    blocks.push(
      mrkdwn(
        `*Recommended:* code fix against \`${action.brief.repo}\` @ \`${action.brief.ref}\`\n` +
          `_${truncate(action.brief.bugSummary, 400)}_\n` +
          `Reproduces under: ${flags}\n${action.brief.reproductionConditions.versionNote}`,
      ),
    );
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Attempt fix →" },
          action_id: "attempt_fix",
          value: inv.id,
        },
      ],
    });
  } else {
    blocks.push(mrkdwn(`*Recommended:* escalate to a human\n${truncate(action.toHuman, 500)}`));
  }

  blocks.push(context(`investigation \`${inv.id}\` · <${inv.trigger.permalink}|original report> · DeployContext`));

  return {
    text: `Diagnosis for ${inv.customer}: ${diagnosis.verdict} — ${diagnosis.culprit}`,
    blocks,
  };
}

export const CLARIFY_CUSTOMER_TEXT =
  "Which customer is this regarding? I know about: %CUSTOMERS%. (Mention me again with the name.)";

export function clarifyCustomer(known: string[]): string {
  return CLARIFY_CUSTOMER_TEXT.replace("%CUSTOMERS%", known.map((c) => `\`${c}\``).join(", ") || "(none yet)");
}
