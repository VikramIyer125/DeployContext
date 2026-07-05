/**
 * M5 exit test (bootstrap half): run BootstrapFlow with the REAL synthesis
 * model + REAL GitHub refs against an EMPTY registry, with Slack mining
 * results mirroring the seeded sandbox history (live RTS needs a
 * human-authored mention; that path is exercised in the sandbox rehearsal).
 *
 * Pass criteria: exactly the two seeded customers are proposed —
 *   acme  → tag acme-prod-v2.3.1, versionPin v2.3.1 (with the pin note)
 *   beta  → branch main, versionPin v2.5.0
 * each citing seeded-history permalinks.
 *
 * Usage: npx tsx scripts/run-bootstrap.ts
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { BootstrapFlow } from "../src/bootstrap/flow.js";
import { ProposalStore } from "../src/registry/proposals.js";
import { Registry } from "../src/registry/registry.js";
import { GitHubLiveConnector, listRepoTree } from "../src/connectors/github.js";
import { FakeSlackSearch } from "../src/connectors/fakes/index.js";
import { ok } from "../src/connectors/types.js";

const { ANTHROPIC_API_KEY, GITHUB_TOKEN } = process.env;
if (!ANTHROPIC_API_KEY || !GITHUB_TOKEN) {
  console.error("ANTHROPIC_API_KEY and GITHUB_TOKEN required (fill .env)");
  process.exit(1);
}
const GITHUB_REPO = process.env.GITHUB_REPO ?? "VikramIyer125/fake-product";

/** Mirrors fixtures/slack-seed.json — what live RTS mining would surface. */
const seededSearch = new FakeSlackSearch([
  {
    matches: "shipped",
    results: [
      {
        text: "Shipped acme-prod-v2.3.1 to Acme 🚀 (tag `acme-prod-v2.3.1`, 2026-05-02). Reminder: Acme stays pinned — their upgrade window is quarterly, next one in September.",
        permalink: "https://hackathonsandbox.slack.com/archives/C0BEUB621F1/p100",
        author: "sam-eng",
        ts: "1746220980.000100",
      },
      {
        text: "Deploy complete: v2.2.0 → all customers (2026-03-08).",
        permalink: "https://hackathonsandbox.slack.com/archives/C0BEUB621F1/p101",
        author: "devops-bot",
        ts: "1741420800.000100",
      },
    ],
  },
  {
    matches: "rolled",
    results: [
      {
        text: "Beta Industries is now tracking `main` — rolled v2.5.0 out to them on 2026-06-10 ✅",
        permalink: "https://hackathonsandbox.slack.com/archives/C0BEUB621F1/p200",
        author: "sam-eng",
        ts: "1749570000.000100",
      },
      {
        text: "v2.4.2 hotfix rolled to internal dogfood only, not customer-facing (2026-05-27).",
        permalink: "https://hackathonsandbox.slack.com/archives/C0BEUB621F1/p201",
        author: "lee-eng",
        ts: "1748360000.000100",
      },
    ],
  },
  {
    matches: "pinned",
    results: [
      {
        text: "FYI from CS: Acme's September upgrade window is confirmed for Sept 14–18. Until then they're on acme-prod-v2.3.1.",
        permalink: "https://hackathonsandbox.slack.com/archives/C0BEUB621F1/p300",
        author: "priya-support",
        ts: "1750900000.000100",
      },
    ],
  },
  {
    matches: "tracking",
    results: [
      {
        text: "Deploy complete: v2.5.0 → staging (2026-06-09).",
        permalink: "https://hackathonsandbox.slack.com/archives/C0BEUB621F1/p400",
        author: "devops-bot",
        ts: "1749480000.000100",
      },
    ],
  },
]);

async function main(): Promise<void> {
  const flow = new BootstrapFlow({
    slackSearch: seededSearch,
    github: new GitHubLiveConnector(GITHUB_TOKEN!),
    anthropic: new Anthropic({ apiKey: ANTHROPIC_API_KEY }),
    registry: new Registry(async () => ok("customers: {}\n")), // fresh world
    proposals: new ProposalStore(":memory:"),
    repo: GITHUB_REPO,
    githubTree: (repo, ref) => listRepoTree(GITHUB_TOKEN!, repo, ref),
  });

  const result = await flow.run();
  console.log(`mined ${result.minedMessages} messages; ${result.proposals.length} proposal(s)\n`);
  for (const p of result.proposals) {
    console.log(`── proposal ${p.id} (${p.kind}) — ${p.customer}`);
    console.log(JSON.stringify({ entry: p.entry, change: p.change, provenance: p.provenance }, null, 1));
  }

  const failures: string[] = [];
  const acme = result.proposals.find((p) => p.customer === "acme");
  const beta = result.proposals.find((p) => p.customer === "beta");
  if (result.proposals.length !== 2) failures.push(`expected 2 proposals, got ${result.proposals.length}`);
  if (!acme?.entry) failures.push("no acme proposal");
  else {
    if (acme.entry.code.ref.value !== "acme-prod-v2.3.1") failures.push(`acme ref=${acme.entry.code.ref.value}`);
    if (acme.entry.code.refType !== "tag") failures.push(`acme refType=${acme.entry.code.refType}`);
    if (acme.entry.versionPin.value !== "v2.3.1") failures.push(`acme pin=${acme.entry.versionPin.value}`);
    if (!acme.entry.versionPin.provenance.some((x) => x.evidenceUrl.includes("/p100"))) {
      failures.push("acme missing the deploy-announcement citation");
    }
  }
  if (!beta?.entry) failures.push("no beta proposal");
  else {
    if (beta.entry.code.ref.value !== "main") failures.push(`beta ref=${beta.entry.code.ref.value}`);
    if (beta.entry.code.refType !== "branch") failures.push(`beta refType=${beta.entry.code.refType}`);
    if (beta.entry.versionPin.value !== "v2.5.0") failures.push(`beta pin=${beta.entry.versionPin.value}`);
  }

  console.log(failures.length === 0 ? "\n✓ PASS: proposed registry matches seeded history" : `\n✗ FAIL: ${failures.join("; ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
