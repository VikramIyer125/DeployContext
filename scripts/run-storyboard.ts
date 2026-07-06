/**
 * Definition-of-done test (§1): the FULL storyboard flow, chained —
 * bug report → investigation (real Opus + live Unleash/GitHub/logs) →
 * the diagnosis's ACTUAL CodeFixBrief → CodeFixer (real Agent SDK in the
 * Docker sandbox) → verified PR against the customer's pinned ref.
 * Must succeed ≥ 8/10 runs in the seeded environment.
 *
 * Usage: npx tsx scripts/run-storyboard.ts [--trials N] [--tier docker|tempdir] [--keep-last]
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { GitHubLiveConnector, listRepoTree } from "../src/connectors/github.js";
import { UnleashLiveConnector } from "../src/connectors/unleash.js";
import { SeededLogSource } from "../src/connectors/logs.js";
import { FakeSlackSearch } from "../src/connectors/fakes/index.js";
import { Registry, githubManifestLoader } from "../src/registry/registry.js";
import { StateResolver } from "../src/resolve/resolver.js";
import { InvestigationRunner } from "../src/investigate/runner.js";
import { ToolRegistry } from "../src/investigate/tools.js";
import { InvestigationStore } from "../src/investigate/store.js";
import { ConsoleReporter } from "../src/investigate/reporter.js";
import { CodeFixer } from "../src/fixer/codefixer.js";
import { createWorkspaceManager } from "../src/fixer/workspace.js";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const TRIALS = Number(argValue("trials", "1"));
const TIER = argValue("tier", "docker") as "docker" | "tempdir";
const KEEP_LAST = process.argv.includes("--keep-last");

const { ANTHROPIC_API_KEY, GITHUB_TOKEN } = process.env;
if (!ANTHROPIC_API_KEY || !GITHUB_TOKEN) {
  console.error("ANTHROPIC_API_KEY and GITHUB_TOKEN required (fill .env)");
  process.exit(1);
}
const GITHUB_REPO = process.env.GITHUB_REPO ?? "VikramIyer125/fake-product";
const UNLEASH_URL = process.env.UNLEASH_URL ?? "http://localhost:4242";
const UNLEASH_API_TOKEN =
  process.env.UNLEASH_API_TOKEN ?? "default:production.deploycontext-insecure-client-token";

const TRIGGER_TEXT = `take care of this

Thread context (the report this refers to):
- jordan (Acme): Hey team — our nightly billing exports started failing yesterday. The export job errors out partway and the file never lands. Nothing changed on our side as far as I know.
- priya-support: escalating to eng — this is blocking Acme's finance close`;

/** Mirrors the seeded sandbox history that live RTS surfaces. */
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
      ],
    },
    {
      matches: "export",
      results: [
        {
          text: 'Logging for posterity (2026-06-18): Jordan at Acme mentioned exports "sometimes look off" last week. Couldn\'t reproduce on our side.',
          permalink: "https://hackathonsandbox.slack.com/archives/C0BF6DCE31T/p2000",
          author: "priya-support",
          ts: "1750229000.000200",
        },
      ],
    },
  ]);
}

async function gh(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  const github = new GitHubLiveConnector(GITHUB_TOKEN!);
  const unleash = new UnleashLiveConnector({ url: UNLEASH_URL, clientToken: UNLEASH_API_TOKEN });
  const logs = new SeededLogSource(process.env.LOG_FIXTURES_PATH ?? "fixtures/logs.json", { rebaseToNow: true });
  const registry = new Registry(
    githubManifestLoader(github, GITHUB_REPO, "main", process.env.MANIFEST_PATH ?? "deployments.yaml"),
  );
  const resolver = new StateResolver({ registry, github, unleash, unleashBaseUrl: UNLEASH_URL });
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const tools = new ToolRegistry({
    registry,
    resolver,
    github,
    unleash,
    logs,
    slackSearch: cannedSlackSearch(),
    unleashBaseUrl: UNLEASH_URL,
    githubTree: (repo, ref) => listRepoTree(GITHUB_TOKEN!, repo, ref),
  });
  const fixer = new CodeFixer({
    workspaces: createWorkspaceManager(TIER, process.env.DOCKER_FIXER_IMAGE),
    github,
    githubToken: GITHUB_TOKEN!,
  });

  const results: Array<{ trial: number; stage: string; ok: boolean; detail: string; minutes: number }> = [];

  for (let t = 1; t <= TRIALS; t++) {
    const id = `story${t}-${randomBytes(3).toString("hex")}`;
    console.log(`\n━━━ storyboard trial ${t}/${TRIALS} (${id}) ━━━`);
    const t0 = Date.now();

    // Stage 1: investigation
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
    const diagnosis = await runner.run(inv);
    store.close();

    const cited = `${diagnosis.culprit} ${diagnosis.reasoning}`.toLowerCase();
    const diagnosisOk =
      diagnosis.verdict === "code-issue" &&
      diagnosis.recommendedAction.type === "code-fix" &&
      cited.includes("new_billing") &&
      cited.includes("legacy_export");
    console.log(`diagnosis: ${diagnosis.verdict} — ${diagnosis.culprit.slice(0, 120)}`);
    if (!diagnosisOk || diagnosis.recommendedAction.type !== "code-fix") {
      results.push({
        trial: t,
        stage: "diagnosis",
        ok: false,
        detail: `verdict=${diagnosis.verdict}`,
        minutes: Math.round(((Date.now() - t0) / 60000) * 10) / 10,
      });
      console.log("✗ FAIL at diagnosis stage");
      continue;
    }

    // Stage 2: the diagnosis's ACTUAL brief → CodeFixer
    const outcome = await fixer.attemptFix(diagnosis.recommendedAction.brief, {
      investigationId: id,
      customerDisplay: "Acme Corp",
      triggerPermalink: inv.trigger.permalink,
      diagnosis,
    });
    const minutes = Math.round(((Date.now() - t0) / 60000) * 10) / 10;

    if (outcome.status === "pr-opened") {
      const v = outcome.verification;
      const verified =
        v.reproTestAdded && v.reproTestFailsOnOriginal && v.reproTestPassesOnFixed && v.fullSuitePassed;
      results.push({
        trial: t,
        stage: "full-flow",
        ok: verified,
        detail: `${outcome.prUrl} (${v.linesChanged} lines)`,
        minutes,
      });
      console.log(`${verified ? "✓ PASS" : "✗ FAIL"} full flow in ${minutes} min → ${outcome.prUrl}`);
      if (!(KEEP_LAST && t === TRIALS)) {
        const prNumber = outcome.prUrl.split("/").pop();
        await gh("PATCH", `/repos/${GITHUB_REPO}/pulls/${prNumber}`, { state: "closed" });
        await gh("DELETE", `/repos/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(`deploycontext/fix-${id}`)}`);
        console.log(`  cleaned up PR #${prNumber}`);
      }
    } else {
      results.push({ trial: t, stage: "fix", ok: false, detail: outcome.status, minutes });
      console.log(`✗ FAIL at fix stage: ${outcome.status} (${minutes} min)`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n═══ STORYBOARD SUMMARY: ${passed}/${TRIALS} full-flow passes ═══`);
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} trial ${r.trial} [${r.stage}] ${r.minutes} min — ${r.detail}`);
  }
  unleash.destroy();
  process.exit(passed >= Math.ceil(TRIALS * 0.8) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
