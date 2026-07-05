/**
 * Confirm cards for registry proposals (§5): "Looks like Acme moved to v2.5 —
 * update the registry?" [Confirm] [Ignore]. Corrections happen by replying
 * with the right value and re-proposing (v1).
 */
import type { Proposal } from "../registry/proposals.js";

type Block = Record<string, unknown>;

function mrkdwn(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function proposalCard(p: Proposal): { text: string; blocks: Block[] } {
  let headline: string;
  if (p.kind === "version-bump") {
    const bits = [
      p.change?.versionPin ? `pin *${p.change.versionPin}*` : null,
      p.change?.ref ? `ref \`${p.change.ref}\`` : null,
    ]
      .filter(Boolean)
      .join(", ");
    headline = `:clipboard: Looks like *${p.customer}* moved to ${bits} — update the registry?`;
  } else {
    const e = p.entry!;
    headline =
      `:clipboard: Propose adding *${e.displayName}* (\`${e.customer}\`) to the registry:\n` +
      `• code: \`${e.code.repo}\` @ \`${e.code.ref.value}\` (${e.code.refType})\n` +
      `• versionPin: \`${e.versionPin.value}\`` +
      (e.config ? `\n• config: \`${e.config.path}\`` : "");
  }

  const provenance = p.provenance
    .slice(0, 3)
    .map((x) => (x.evidenceUrl ? `<${x.evidenceUrl}|${x.source} · ${x.confidence}>` : `${x.source} · ${x.confidence}`))
    .join("  ·  ");

  const blocks: Block[] = [
    mrkdwn(headline),
    { type: "context", elements: [{ type: "mrkdwn", text: `evidence: ${provenance || "_none_"} · proposal \`${p.id}\`` }] },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Confirm" },
          action_id: "proposal_confirm",
          value: p.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Ignore" },
          action_id: "proposal_ignore",
          value: p.id,
        },
      ],
    },
  ];

  const text =
    p.kind === "version-bump"
      ? `Proposal: ${p.customer} → ${p.change?.versionPin ?? p.change?.ref}`
      : `Proposal: add ${p.customer} to the registry`;
  return { text, blocks };
}
