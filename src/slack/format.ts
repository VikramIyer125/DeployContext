/**
 * Pure formatting of resolved state (and friends) into Slack blocks.
 * Every claim carries its provenance line — that's the product.
 */
import { dump } from "js-yaml";
import type { Provenance, RegistryEntry, ResolvedState } from "../domain/types.js";
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

export const CLARIFY_CUSTOMER_TEXT =
  "Which customer is this regarding? I know about: %CUSTOMERS%. (Mention me again with the name.)";

export function clarifyCustomer(known: string[]): string {
  return CLARIFY_CUSTOMER_TEXT.replace("%CUSTOMERS%", known.map((c) => `\`${c}\``).join(", ") || "(none yet)");
}
