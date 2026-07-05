/**
 * The fixer's work order — templated from the CodeFixBrief (§6).
 * Reproduce-first is enforced by BOTH this prompt and the wrapper's
 * verification (which never trusts the model's claims).
 */
import type { CodeFixBrief } from "../domain/types.js";

export const REPRO_TEST_PATH = "test/deploycontext-repro.test.ts";
export const FIX_REPORT_PATH = "FIX_REPORT.md";

export const FIXER_SYSTEM_PROMPT = `You are a careful senior engineer fixing one bug in a sandboxed \
checkout of a customer-pinned deployment. You edit files with the file tools and execute ONLY via the \
run_command tool (it runs inside the sandbox; there is no network). Keep diffs minimal and match the \
repo's existing style. Never touch the .git directory.`;

export function buildFixPrompt(brief: CodeFixBrief): string {
  const flags = Object.entries(brief.reproductionConditions.flags)
    .map(([k, v]) => `  ${k} = ${String(v)}`)
    .join("\n");
  const evidence = brief.evidence
    .slice(0, 10)
    .map((e) => `- [${e.kind}] ${e.summary}${e.source.evidenceUrl ? ` (${e.source.evidenceUrl})` : ""}`)
    .join("\n");

  return `You are fixing a bug in a CUSTOMER-PINNED deployment of ${brief.repo} at ref \`${brief.ref}\`. \
The repository is already checked out in your working directory with dependencies installed. \
Do not rebase, do not port changes from main, do not add or upgrade dependencies.

## Bug
${brief.bugSummary}

## Reproduction conditions
Flags:
${flags}
${brief.reproductionConditions.configExcerpt ? `Config excerpt:\n${brief.reproductionConditions.configExcerpt}\n` : ""}Version note: ${brief.reproductionConditions.versionNote}

## Evidence from the investigation
${evidence || "- (none attached)"}

## Constraints
${brief.constraints.map((c) => `- ${c}`).join("\n")}

## Work order — follow strictly, in order
1. REPRODUCE FIRST. Write a failing test at exactly \`${REPRO_TEST_PATH}\` that demonstrates the bug \
under the reproduction conditions above (inject flags the way the existing tests do). Run it with \
run_command (\`npx vitest run ${REPRO_TEST_PATH}\`). DO NOT PROCEED until it fails for the expected \
reason. If you cannot make it fail for the right reason, STOP: write \`${FIX_REPORT_PATH}\` explaining \
exactly why reproduction failed, change no source files, and end.
2. FIX. Make the minimal change that makes the repro test pass. Match repo style. Respect the constraints.
3. VERIFY. Run the repro test (must pass now) and then the full suite (\`npx vitest run\`) with run_command.
4. REPORT. Write \`${FIX_REPORT_PATH}\` at the repo root with sections: "## Root cause", \
"## Change rationale", "## Risk notes".

Notes:
- run_command is your ONLY way to execute anything; it runs inside the sandboxed checkout with NO network.
- The wrapper independently re-runs your test against the original and fixed code — cutting corners \
cannot pass verification, only honest work can.`;
}
