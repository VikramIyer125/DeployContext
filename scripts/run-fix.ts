/**
 * M4 exit test: run the REAL CodeFixer (Agent SDK in the sandbox tier) against
 * the seeded bug, N times, scoring each outcome.
 *
 * Pass criteria per trial:
 *   - outcome is pr-opened (verified: repro added, fails-on-original,
 *     passes-on-fixed, full suite green — all computed by wrapper code)
 *   - linesChanged ≤ 15 (the seeded bug is a small fix)
 *
 * Cleanup: closes the PR + deletes the fix branch after each passing trial
 * (pass --keep-last to keep the final trial's PR for the demo).
 *
 * Usage:
 *   npx tsx scripts/run-fix.ts [--trials N] [--tier docker|tempdir] [--keep-last]
 */
import "dotenv/config";
import { CodeFixer } from "../src/fixer/codefixer.js";
import { createWorkspaceManager } from "../src/fixer/workspace.js";
import { GitHubLiveConnector } from "../src/connectors/github.js";
import type { CodeFixBrief, FixOutcome } from "../src/domain/types.js";
import { randomBytes } from "node:crypto";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const TRIALS = Number(argValue("trials", "1"));
const TIER = argValue("tier", process.env.WORKSPACE_TIER ?? "docker") as "docker" | "tempdir";
const KEEP_LAST = process.argv.includes("--keep-last");

const { ANTHROPIC_API_KEY, GITHUB_TOKEN } = process.env;
if (!ANTHROPIC_API_KEY || !GITHUB_TOKEN) {
  console.error("ANTHROPIC_API_KEY and GITHUB_TOKEN required (fill .env)");
  process.exit(1);
}
const GITHUB_REPO = process.env.GITHUB_REPO ?? "VikramIyer125/fake-product";

/** The brief exactly as M3's diagnoses produce it (see run-investigation.ts trials). */
const BRIEF: CodeFixBrief = {
  repo: GITHUB_REPO,
  ref: "acme-prod-v2.3.1",
  bugSummary:
    "Billing exports crash for customers with new_billing=on and legacy_export=off: formatBillingRow requires record.ledgerRef, but ledgerRef is only stamped by stampLedgerRefs(), which runs only when legacy_export is enabled.",
  reproductionConditions: {
    flags: { new_billing: true, legacy_export: false },
    versionNote:
      "Only reproduces on v2.3.1 (tag acme-prod-v2.3.1). main (v2.5.0) derives a fallback ledgerRef, so Beta is unaffected.",
  },
  evidence: [
    {
      kind: "log-line",
      summary:
        "6 log matches: ERROR export_service: cannot read field 'ledgerRef' — customer=acme version=2.3.1 flags=new_billing,!legacy_export",
      source: { source: "logs", evidenceUrl: "fixture://logs.json", observedAt: "2026-07-05", confidence: "confirmed" },
    },
    {
      kind: "state-delta",
      summary: "diff(acme, beta): version v2.3.1 vs v2.5.0; flag deltas include new_billing (on vs off), legacy_export (off vs on)",
      source: { source: "unleash", evidenceUrl: "http://localhost:4242/projects/default/features", observedAt: "2026-07-05", confidence: "confirmed" },
    },
  ],
  constraints: ["minimal diff", "no new dependencies", "match repo style"],
};

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

async function cleanup(prUrl: string, branch: string): Promise<void> {
  const prNumber = prUrl.split("/").pop();
  await gh("PATCH", `/repos/${GITHUB_REPO}/pulls/${prNumber}`, { state: "closed" });
  await gh("DELETE", `/repos/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(branch)}`);
  console.log(`  cleaned up: closed PR #${prNumber}, deleted ${branch}`);
}

function scoreOutcome(outcome: FixOutcome): string[] {
  if (outcome.status !== "pr-opened") return [`status=${outcome.status}, expected pr-opened`];
  const failures: string[] = [];
  const v = outcome.verification;
  if (!v.reproTestAdded) failures.push("repro test not added");
  if (!v.reproTestFailsOnOriginal) failures.push("repro does not fail on original");
  if (!v.reproTestPassesOnFixed) failures.push("repro does not pass on fixed");
  if (!v.fullSuitePassed) failures.push("full suite not green");
  if (v.linesChanged > 15) failures.push(`linesChanged=${v.linesChanged} > 15`);
  return failures;
}

async function main(): Promise<void> {
  const fixer = new CodeFixer({
    workspaces: createWorkspaceManager(TIER, process.env.DOCKER_FIXER_IMAGE),
    github: new GitHubLiveConnector(GITHUB_TOKEN!),
    githubToken: GITHUB_TOKEN!,
  });

  const results: Array<{ trial: number; status: string; pass: boolean; failures: string[]; minutes: number; url?: string }> = [];

  for (let t = 1; t <= TRIALS; t++) {
    const id = `trial${t}-${randomBytes(3).toString("hex")}`;
    console.log(`\n━━━ fix trial ${t}/${TRIALS} (tier=${TIER}, inv=${id}) ━━━`);
    const t0 = Date.now();
    const outcome = await fixer.attemptFix(BRIEF, {
      investigationId: id,
      customerDisplay: "Acme Corp",
      triggerPermalink: "https://hackathonsandbox.slack.com/archives/C0BF6DCE31T/p-demo",
    });
    const minutes = Math.round(((Date.now() - t0) / 60000) * 10) / 10;
    const failures = scoreOutcome(outcome);
    const pass = failures.length === 0;

    console.log(`outcome: ${outcome.status} (${minutes} min)`);
    if (outcome.status === "pr-opened") {
      console.log(`  PR: ${outcome.prUrl}`);
      console.log(`  verification: ${JSON.stringify(outcome.verification)}`);
    } else if (outcome.status === "no-repro") {
      console.log(`  detail: ${outcome.detail.slice(0, 300)}`);
    } else if (outcome.status === "fix-unverified") {
      console.log(`  branch: ${outcome.branchUrl}\n  detail: ${outcome.detail.slice(0, 300)}`);
    } else {
      console.log(`  reason: ${outcome.reason}\n  transcript tail: ${outcome.transcript.slice(-300)}`);
    }
    console.log(pass ? `✓ PASS` : `✗ FAIL: ${failures.join("; ")}`);

    results.push({
      trial: t,
      status: outcome.status,
      pass,
      failures,
      minutes,
      url: outcome.status === "pr-opened" ? outcome.prUrl : undefined,
    });

    if (outcome.status === "pr-opened" && !(KEEP_LAST && t === TRIALS)) {
      await cleanup(outcome.prUrl, `deploycontext/fix-${id}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n═══ SUMMARY: ${passed}/${TRIALS} passed (tier=${TIER}) ═══`);
  for (const r of results) {
    console.log(
      `  ${r.pass ? "✓" : "✗"} trial ${r.trial}: ${r.status} (${r.minutes} min)${r.url ? ` ${r.url}` : ""}${r.failures.length ? ` — ${r.failures.join("; ")}` : ""}`,
    );
  }
  process.exit(passed >= Math.ceil(TRIALS * 0.8) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
