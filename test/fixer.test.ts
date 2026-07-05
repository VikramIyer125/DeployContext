/**
 * CodeFixer integration tests — REAL TempDirWorkspace cloning the local
 * fake-product repo, REAL wrapper verification (vitest runs in the checkout),
 * fake agents standing in for the SDK. GitHub writes go to FakeGitHub.
 */
import { describe, it, expect } from "vitest";
import { readFile, writeFile, symlink, readFile as rf } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CodeFixer } from "../src/fixer/codefixer.js";
import { TempDirWorkspaceManager, type Workspace } from "../src/fixer/workspace.js";
import { REPRO_TEST_PATH, FIX_REPORT_PATH } from "../src/fixer/fixPrompt.js";
import type { AgentRunner, AgentRunResult } from "../src/fixer/agentRunner.js";
import type { CodeFixBrief } from "../src/domain/types.js";
import { FakeGitHub } from "../src/connectors/fakes/index.js";
import { buildTestWorld } from "./helpers.js";

const FAKE_PRODUCT_DIR = join(process.cwd(), "fake-product");
const HAS_FAKE_PRODUCT =
  existsSync(FAKE_PRODUCT_DIR) && existsSync(join(FAKE_PRODUCT_DIR, "node_modules"));

const BRIEF: CodeFixBrief = {
  repo: "yourco/fake-product",
  ref: "acme-prod-v2.3.1",
  bugSummary: "formatBillingRow requires ledgerRef, which only the legacy exporter stamps",
  reproductionConditions: {
    flags: { new_billing: true, legacy_export: false },
    versionNote: "only on v2.3.1 (tag acme-prod-v2.3.1); main has a guard",
  },
  evidence: [
    {
      kind: "log-line",
      summary: "6 errors: cannot read field 'ledgerRef'",
      source: { source: "logs", evidenceUrl: "fixture://logs.json", observedAt: "2026-07-05", confidence: "confirmed" },
    },
  ],
  constraints: ["minimal diff", "no new dependencies"],
};

function manager(): TempDirWorkspaceManager {
  return new TempDirWorkspaceManager({
    cloneUrl: () => `file://${FAKE_PRODUCT_DIR}`,
    skipInstall: true, // node_modules is symlinked from the local fake-product instead
  });
}

async function linkNodeModules(ws: Workspace): Promise<void> {
  await symlink(join(FAKE_PRODUCT_DIR, "node_modules"), join(ws.dir, "node_modules"));
}

const agentDone: AgentRunResult = {
  completed: true,
  timedOut: false,
  turns: 5,
  costUsd: 0,
  transcriptTail: "done",
};

/** Writes the real repro test + the real ≤15-line guard fix + FIX_REPORT. */
const goodAgent: AgentRunner = async ({ workspace }) => {
  await linkNodeModules(workspace);
  const repro = await rf(join(process.cwd(), "scripts/repro/acme-flag-combo.repro.test.ts"), "utf8");
  await writeFile(join(workspace.dir, REPRO_TEST_PATH), repro);

  const formatterPath = join(workspace.dir, "src/exporters/billingFormatter.ts");
  const original = await readFile(formatterPath, "utf8");
  const fixed = original
    .replace(`import { requireField } from "../util/assert.js";\n`, "")
    .replace(
      `  const ledgerRef = requireField(record, "ledgerRef");`,
      "  // legacy_export may be disabled, in which case no ledgerRef was stamped.\n" +
        "  const ledgerRef =\n" +
        '    record.ledgerRef ?? `LGR-${record.issuedAt.slice(0, 4)}-${record.id.padStart(6, "0")}`;',
    );
  if (fixed === original) throw new Error("test setup: fix did not apply");
  await writeFile(formatterPath, fixed);

  await writeFile(
    join(workspace.dir, FIX_REPORT_PATH),
    "## Root cause\nformatBillingRow assumed the legacy exporter ran.\n## Change rationale\nDerive the ref.\n## Risk notes\nLow.\n",
  );
  return agentDone;
};

/** Writes nothing at all. */
const lazyAgent: AgentRunner = async () => agentDone;

/** Repro test is real, but the "fix" doesn't address the bug. */
const wrongFixAgent: AgentRunner = async ({ workspace }) => {
  await linkNodeModules(workspace);
  const repro = await rf(join(process.cwd(), "scripts/repro/acme-flag-combo.repro.test.ts"), "utf8");
  await writeFile(join(workspace.dir, REPRO_TEST_PATH), repro);
  const versionPath = join(workspace.dir, "src/version.ts");
  await writeFile(versionPath, `export const VERSION = "2.3.2";\n`);
  return agentDone;
};

/** Cheating agent: a repro test that passes even on the original code. */
const cheatingAgent: AgentRunner = async ({ workspace }) => {
  await linkNodeModules(workspace);
  await writeFile(
    join(workspace.dir, REPRO_TEST_PATH),
    `import { it, expect } from "vitest";\nit("repro", () => { expect(true).toBe(true); });\n`,
  );
  const versionPath = join(workspace.dir, "src/version.ts");
  await writeFile(versionPath, `export const VERSION = "2.3.2";\n`);
  return agentDone;
};

const timeoutAgent: AgentRunner = async () => ({
  completed: false,
  timedOut: true,
  turns: 60,
  costUsd: 0,
  transcriptTail: "…still cloning the kitchen sink…",
});

function fixer(agent: AgentRunner): { fixer: CodeFixer; github: FakeGitHub } {
  const { github } = buildTestWorld();
  return {
    github,
    fixer: new CodeFixer({
      workspaces: manager(),
      github,
      githubToken: "test-token-not-real",
      agentRunner: agent,
    }),
  };
}

describe.skipIf(!HAS_FAKE_PRODUCT)("CodeFixer (real workspace + real verification)", () => {
  it(
    "verified fix → branch from the pinned tag, PR against maint branch, full causal-chain body",
    async () => {
      const { fixer: cf, github } = fixer(goodAgent);
      const outcome = await cf.attemptFix(BRIEF, {
        investigationId: "itest1",
        customerDisplay: "Acme Corp",
        triggerPermalink: "https://sandbox.slack.com/archives/C0BF6DCE31T/p42",
      });

      expect(outcome.status).toBe("pr-opened");
      if (outcome.status !== "pr-opened") return;
      expect(outcome.verification).toEqual({
        reproTestAdded: true,
        reproTestFailsOnOriginal: true,
        reproTestPassesOnFixed: true,
        fullSuitePassed: true,
        linesChanged: expect.any(Number),
      });
      expect(outcome.verification.linesChanged).toBeGreaterThan(0);
      expect(outcome.verification.linesChanged).toBeLessThanOrEqual(15);

      // wrapper-side GitHub writes: fix branch from the tag, PR to maint/<tag>
      const pr = github.prs[0];
      expect(pr.base).toBe("maint/acme-prod-v2.3.1");
      expect(pr.head).toBe("deploycontext/fix-itest1");
      expect(pr.body).toContain("https://sandbox.slack.com/archives/C0BF6DCE31T/p42");
      expect(pr.body).toContain("Acme Corp");
      expect(pr.body).toContain("cannot read field 'ledgerRef'");
      expect(pr.body).toContain("Root cause");
      expect(pr.body).toContain("| Repro test fails on original | ✅ |");
      expect(pr.body).toContain("Generated by");

      const push = github.pushes[0];
      expect(push.branch).toBe("deploycontext/fix-itest1");
      const pushedPaths = push.files.map((f) => f.path);
      expect(pushedPaths).toContain("src/exporters/billingFormatter.ts");
      expect(pushedPaths).toContain(REPRO_TEST_PATH);
      expect(pushedPaths).not.toContain(FIX_REPORT_PATH);
    },
    180_000,
  );

  it(
    "agent produces nothing → no-repro (diagnosis-was-wrong signal), no GitHub writes",
    async () => {
      const { fixer: cf, github } = fixer(lazyAgent);
      const outcome = await cf.attemptFix(BRIEF, { investigationId: "itest2" });
      expect(outcome.status).toBe("no-repro");
      if (outcome.status !== "no-repro") return;
      expect(outcome.detail).toContain("no reproduction test");
      expect(github.pushes).toHaveLength(0);
      expect(github.prs).toHaveLength(0);
    },
    60_000,
  );

  it(
    "repro ok but fix doesn't work → branch pushed, NO PR (fix-unverified)",
    async () => {
      const { fixer: cf, github } = fixer(wrongFixAgent);
      const outcome = await cf.attemptFix(BRIEF, { investigationId: "itest3" });
      expect(outcome.status).toBe("fix-unverified");
      if (outcome.status !== "fix-unverified") return;
      expect(outcome.branchUrl).toContain("deploycontext/fix-itest3");
      expect(github.pushes).toHaveLength(1);
      expect(github.prs).toHaveLength(0);
    },
    180_000,
  );

  it(
    "repro test that passes on original code → no-repro, nothing pushed",
    async () => {
      const { fixer: cf, github } = fixer(cheatingAgent);
      const outcome = await cf.attemptFix(BRIEF, { investigationId: "itest4" });
      expect(outcome.status).toBe("no-repro");
      if (outcome.status !== "no-repro") return;
      expect(outcome.detail).toContain("does not fail on the original");
      expect(github.pushes).toHaveLength(0);
    },
    180_000,
  );

  it(
    "wall-clock timeout → failed with transcript, no verification, no writes",
    async () => {
      const { fixer: cf, github } = fixer(timeoutAgent);
      const outcome = await cf.attemptFix(BRIEF, { investigationId: "itest5" });
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.reason).toContain("wall clock");
      expect(outcome.transcript).toContain("kitchen sink");
      expect(github.pushes).toHaveLength(0);
    },
    60_000,
  );

  it(
    "workspace has no origin remote and no token anywhere in .git",
    async () => {
      const captured: string[] = [];
      const spyAgent: AgentRunner = async ({ workspace }) => {
        const config = await readFile(join(workspace.dir, ".git", "config"), "utf8");
        captured.push(config);
        return agentDone;
      };
      const { fixer: cf } = fixer(spyAgent);
      await cf.attemptFix(BRIEF, { investigationId: "itest6" });
      expect(captured[0]).not.toContain("origin");
      expect(captured[0]).not.toContain("test-token-not-real");
    },
    60_000,
  );
});
