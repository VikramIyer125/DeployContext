/**
 * VerificationReport — computed by WRAPPER CODE against the workspace,
 * NEVER trusted from model output (§3/§6 invariant).
 *
 * Procedure (all executed in the sandbox by the wrapper):
 *   1. git status/diff → what changed (the untracked repro test is excluded
 *      from linesChanged by construction).
 *   2. `git stash` the fix → run the repro test → must FAIL on original.
 *   3. `git stash pop` → run the repro test → must PASS on fixed.
 *   4. full suite must pass.
 */
import type { VerificationReport } from "../domain/types.js";
import { REPRO_TEST_PATH, FIX_REPORT_PATH } from "./fixPrompt.js";
import type { ExecResult } from "./workspace.js";

export interface VerifyTarget {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
}

export interface VerificationOutcome {
  report: VerificationReport;
  /** Tracked-modified + untracked files (repro test included, FIX_REPORT excluded). */
  changedFiles: string[];
  /** Human-readable trace of each check, for escalations and the PR body. */
  details: string[];
}

const TEST_TIMEOUT_MS = 180_000;

export async function computeVerification(ws: VerifyTarget): Promise<VerificationOutcome> {
  const details: string[] = [];

  const status = await ws.exec("git status --porcelain");
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const flag = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (flag === "??") untracked.push(path);
    else modified.push(path);
  }
  const reproTestAdded = untracked.includes(REPRO_TEST_PATH) || modified.includes(REPRO_TEST_PATH);
  details.push(
    `changed: ${modified.length} tracked (${modified.join(", ") || "none"}), ${untracked.length} untracked (${untracked.join(", ") || "none"})`,
  );

  const numstat = await ws.exec("git diff --numstat");
  let linesChanged = 0;
  for (const line of numstat.stdout.split("\n")) {
    const m = line.match(/^(\d+)\s+(\d+)\s+/);
    if (m) linesChanged += Number(m[1]) + Number(m[2]);
  }

  const runRepro = async (label: string): Promise<boolean> => {
    const run = await ws.exec(`npx vitest run ${REPRO_TEST_PATH}`, { timeoutMs: TEST_TIMEOUT_MS });
    const passed = run.code === 0 && !run.timedOut;
    details.push(`repro test on ${label}: ${passed ? "PASS" : "FAIL"} (exit ${run.code})`);
    return passed;
  };

  let reproTestFailsOnOriginal = false;
  let reproTestPassesOnFixed = false;
  let fullSuitePassed = false;

  if (reproTestAdded) {
    const hasFix = modified.length > 0;
    if (hasFix) {
      const stash = await ws.exec("git stash push --quiet");
      if (stash.code !== 0) {
        details.push(`could not stash fix for original-code check: ${stash.stderr.slice(0, 200)}`);
      } else {
        reproTestFailsOnOriginal = !(await runRepro("ORIGINAL (fix stashed)"));
        const pop = await ws.exec("git stash pop --quiet");
        if (pop.code !== 0) {
          details.push(`FATAL: git stash pop failed — workspace inconsistent: ${pop.stderr.slice(0, 200)}`);
          return {
            report: {
              reproTestAdded,
              reproTestFailsOnOriginal,
              reproTestPassesOnFixed: false,
              fullSuitePassed: false,
              linesChanged,
            },
            changedFiles: dedupe(modified, untracked),
            details,
          };
        }
      }
    } else {
      // No fix present: the current tree IS the original.
      reproTestFailsOnOriginal = !(await runRepro("ORIGINAL (no fix present)"));
    }

    if (hasFix) {
      reproTestPassesOnFixed = await runRepro("FIXED");
      const suite = await ws.exec("npx vitest run", { timeoutMs: TEST_TIMEOUT_MS });
      fullSuitePassed = suite.code === 0 && !suite.timedOut;
      details.push(`full suite on FIXED: ${fullSuitePassed ? "PASS" : "FAIL"} (exit ${suite.code})`);
    }
  } else {
    details.push(`no repro test found at ${REPRO_TEST_PATH}`);
  }

  return {
    report: {
      reproTestAdded,
      reproTestFailsOnOriginal,
      reproTestPassesOnFixed,
      fullSuitePassed,
      linesChanged,
    },
    changedFiles: dedupe(modified, untracked),
    details,
  };
}

function dedupe(modified: string[], untracked: string[]): string[] {
  return [...new Set([...modified, ...untracked])].filter((p) => p !== FIX_REPORT_PATH);
}

export function isVerified(report: VerificationReport): boolean {
  return (
    report.reproTestAdded &&
    report.reproTestFailsOnOriginal &&
    report.reproTestPassesOnFixed &&
    report.fullSuitePassed
  );
}
