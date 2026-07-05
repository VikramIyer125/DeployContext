/**
 * M3 exit test: run the REAL investigation loop (Opus + live Unleash/GitHub +
 * seeded logs) headlessly against the storyboard bug report, N times, and
 * score each diagnosis.
 *
 * Pass criteria per trial (auto-scored):
 *   - verdict === "code-issue" with a code-fix recommendation
 *   - the flag delta is cited: both new_billing and legacy_export appear
 *   - reproduction flags: new_billing=true(/on), legacy_export=false(/off)
 *   - the brief targets the customer's pinned ref (acme-prod-v2.3.1)
 *
 * Usage:
 *   npx tsx scripts/run-investigation.ts [--trials N] [--slack fake|live]
 *
 * --slack fake (default): canned results mirroring the seeded sandbox content.
 * --slack live: real RTS (expects to degrade gracefully headlessly — no
 *   action token exists outside a live mention).
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { GitHubLiveConnector, listRepoTree } from "../src/connectors/github.js";
import { UnleashLiveConnector } from "../src/connectors/unleash.js";
import { SeededLogSource } from "../src/connectors/logs.js";
import { FakeSlackSearch } from "../src/connectors/fakes/index.js";
import { RtsSlackSearch, LatestActionTokenStore } from "../src/connectors/slackSearch.js";
import { Registry, githubManifestLoader } from "../src/registry/registry.js";
import { StateResolver } from "../src/resolve/resolver.js";
import { InvestigationRunner } from "../src/investigate/runner.js";
import { ToolRegistry } from "../src/investigate/tools.js";
import { InvestigationStore } from "../src/investigate/store.js";
import { ConsoleReporter } from "../src/investigate/reporter.js";
import type { Diagnosis } from "../src/domain/types.js";
import { WebClient } from "@slack/web-api";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TRIALS = Number(argValue("trials", "1"));
const SLACK_MODE = argValue("slack", "fake");

const { ANTHROPIC_API_KEY, GITHUB_TOKEN } = process.env;
if (!ANTHROPIC_API_KEY || !GITHUB_TOKEN) {
  console.error("ANTHROPIC_API_KEY and GITHUB_TOKEN required (fill .env)");
  process.exit(1);
}
const GITHUB_REPO = process.env.GITHUB_REPO ?? "VikramIyer125/fake-product";
const UNLEASH_URL = process.env.UNLEASH_URL ?? "http://localhost:4242";
const UNLEASH_API_TOKEN =
  process.env.UNLEASH_API_TOKEN ?? "default:production.deploycontext-insecure-client-token";
const LOG_FIXTURES_PATH = process.env.LOG_FIXTURES_PATH ?? "fixtures/logs.json";

/** The storyboard bug report, as the mention handler would package it. */
const TRIGGER_TEXT = `take care of this

Thread context (the report this refers to):
- jordan (Acme): Hey team — our nightly billing exports started failing yesterday. The export job errors out partway and the file never lands. Nothing changed on our side as far as I know.
- priya-support: escalating to eng — this is blocking Acme's finance close`;

/** Mirrors the seeded sandbox history that live RTS would surface. */
function cannedSlackSearch(): FakeSlackSearch {
  return new FakeSlackSearch([
    {
      matches: "acme",
      results: [
        {
          text: "Shipped acme-prod-v2.3.1 to Acme 🚀 (tag `acme-prod-v2.3.1`, 2026-05-02). Reminder: Acme stays pinned — their upgrade window is quarterly, next one in September.",
          permalink: "https://hackathonsandbox.slack.com/archives/C0BEUB621F1/p1000",
          author: "sam-eng",
          ts: "1746220980.000100",
        },
        {
          text: "FYI from CS: Acme's September upgrade window is confirmed for Sept 14–18. Until then they're on acme-prod-v2.3.1.",
          permalink: "https://hackathonsandbox.slack.com/archives/C0BEUB621F1/p1001",
          author: "priya-support",
          ts: "1750900000.000100",
        },
      ],
    },
    {
      matches: "export",
      results: [
        {
          text: 'Logging for posterity (2026-06-18): Jordan at Acme mentioned exports "sometimes look off" last week. Couldn\'t reproduce on our side, no error attached. Will watch for a recurrence.',
          permalink: "https://hackathonsandbox.slack.com/archives/C0BF6DCE31T/p2000",
          author: "priya-support",
          ts: "1750229000.000200",
        },
      ],
    },
    {
      matches: "beta",
      results: [
        {
          text: "Beta Industries is now tracking `main` — rolled v2.5.0 out to them on 2026-06-10 ✅",
          permalink: "https://hackathonsandbox.slack.com/archives/C0BEUB621F1/p1002",
          author: "sam-eng",
          ts: "1749570000.000100",
        },
      ],
    },
  ]);
}

interface TrialResult {
  trial: number;
  verdict: Diagnosis["verdict"];
  culprit: string;
  pass: boolean;
  failures: string[];
  seconds: number;
  evidenceCount: number;
}

function score(d: Diagnosis, evidenceCount: number): string[] {
  const failures: string[] = [];
  if (d.verdict !== "code-issue") failures.push(`verdict=${d.verdict}, expected code-issue`);
  if (d.recommendedAction.type !== "code-fix") {
    failures.push(`action=${d.recommendedAction.type}, expected code-fix`);
    return failures;
  }
  const brief = d.recommendedAction.brief;
  const cited = `${d.culprit} ${d.reasoning} ${brief.bugSummary} ${brief.reproductionConditions.versionNote}`.toLowerCase();
  if (!cited.includes("new_billing")) failures.push("does not cite new_billing");
  if (!cited.includes("legacy_export")) failures.push("does not cite legacy_export");

  const flags = brief.reproductionConditions.flags;
  const truthy = (v: unknown) => v === true || v === "true" || v === "on";
  const falsy = (v: unknown) => v === false || v === "false" || v === "off";
  if (!truthy(flags.new_billing)) failures.push(`repro flags.new_billing=${JSON.stringify(flags.new_billing)}, expected on`);
  if (!falsy(flags.legacy_export)) failures.push(`repro flags.legacy_export=${JSON.stringify(flags.legacy_export)}, expected off`);
  if (brief.ref !== "acme-prod-v2.3.1") failures.push(`brief.ref=${brief.ref}, expected acme-prod-v2.3.1`);
  if (evidenceCount < 2) failures.push(`only ${evidenceCount} evidence items`);
  return failures;
}

async function main(): Promise<void> {
  const github = new GitHubLiveConnector(GITHUB_TOKEN!);
  const unleash = new UnleashLiveConnector({ url: UNLEASH_URL, clientToken: UNLEASH_API_TOKEN });
  const logs = new SeededLogSource(LOG_FIXTURES_PATH, { rebaseToNow: true });
  const registry = new Registry(githubManifestLoader(github, GITHUB_REPO, "main", process.env.MANIFEST_PATH ?? "deployments.yaml"));
  const resolver = new StateResolver({ registry, github, unleash, unleashBaseUrl: UNLEASH_URL });
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const slackSearch =
    SLACK_MODE === "live"
      ? new RtsSlackSearch(new WebClient(process.env.SLACK_BOT_TOKEN), new LatestActionTokenStore())
      : cannedSlackSearch();

  const tools = new ToolRegistry({
    registry,
    resolver,
    github,
    unleash,
    logs,
    slackSearch,
    unleashBaseUrl: UNLEASH_URL,
    githubTree: (repo, ref) => listRepoTree(GITHUB_TOKEN!, repo, ref),
  });

  const results: TrialResult[] = [];
  for (let t = 1; t <= TRIALS; t++) {
    const store = new InvestigationStore(":memory:");
    const runner = new InvestigationRunner({
      llm: anthropic,
      tools,
      registry,
      resolver,
      store,
      reporter: new ConsoleReporter(),
    });
    const inv = store.create({
      trigger: {
        channel: "C0BF6DCE31T",
        threadTs: `${Date.now() / 1000}`,
        permalink: "https://hackathonsandbox.slack.com/archives/C0BF6DCE31T/p-demo",
        text: TRIGGER_TEXT,
      },
      customer: "acme",
    });

    console.log(`\n━━━ trial ${t}/${TRIALS} (inv ${inv.id}, slack=${SLACK_MODE}) ━━━`);
    const t0 = Date.now();
    const diagnosis = await runner.run(inv);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const failures = score(diagnosis, inv.evidence.length);

    results.push({
      trial: t,
      verdict: diagnosis.verdict,
      culprit: diagnosis.culprit,
      pass: failures.length === 0,
      failures,
      seconds,
      evidenceCount: inv.evidence.length,
    });
    console.log(`verdict: ${diagnosis.verdict} — ${diagnosis.culprit}`);
    console.log(`reasoning: ${diagnosis.reasoning.slice(0, 400)}`);
    console.log(
      failures.length === 0
        ? `✓ PASS (${seconds}s, ${inv.evidence.length} evidence items)`
        : `✗ FAIL (${seconds}s): ${failures.join("; ")}`,
    );
    store.close();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n═══ SUMMARY: ${passed}/${TRIALS} passed ═══`);
  for (const r of results) {
    console.log(
      `  ${r.pass ? "✓" : "✗"} trial ${r.trial}: ${r.verdict} (${r.seconds}s, ${r.evidenceCount} ev)${r.failures.length ? ` — ${r.failures.join("; ")}` : ""}`,
    );
  }
  unleash.destroy();
  process.exit(passed >= Math.ceil(TRIALS * 0.8) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
