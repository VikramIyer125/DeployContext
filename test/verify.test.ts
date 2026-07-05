import { describe, it, expect } from "vitest";
import { computeVerification, isVerified } from "../src/fixer/verify.js";
import { REPRO_TEST_PATH } from "../src/fixer/fixPrompt.js";
import type { ExecResult } from "../src/fixer/workspace.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (code = 1): ExecResult => ({ code, stdout: "", stderr: "", timedOut: false });

/** Stateful fake workspace: repro test fails unless the fix is present. */
function fakeWorkspace(opts: {
  reproAdded: boolean;
  fixedFiles: string[];
  reproFailsOnOriginal: boolean;
  reproPassesOnFixed: boolean;
  suitePasses: boolean;
  stashPopFails?: boolean;
}) {
  let stashed = false;
  const calls: string[] = [];
  return {
    calls,
    async exec(command: string): Promise<ExecResult> {
      calls.push(command);
      if (command.startsWith("git status")) {
        const lines = [
          ...opts.fixedFiles.map((f) => ` M ${f}`),
          ...(opts.reproAdded ? [`?? ${REPRO_TEST_PATH}`] : []),
          "?? FIX_REPORT.md",
        ];
        return ok(lines.join("\n"));
      }
      if (command.startsWith("git diff --numstat")) {
        return ok(opts.fixedFiles.map((f) => `5\t2\t${f}`).join("\n"));
      }
      if (command.startsWith("git stash push")) {
        stashed = true;
        return ok();
      }
      if (command.startsWith("git stash pop")) {
        if (opts.stashPopFails) return fail(1);
        stashed = false;
        return ok();
      }
      if (command.includes(`vitest run ${REPRO_TEST_PATH}`)) {
        if (stashed) return opts.reproFailsOnOriginal ? fail() : ok();
        return opts.reproPassesOnFixed ? ok() : fail();
      }
      if (command.includes("vitest run")) {
        return opts.suitePasses ? ok() : fail();
      }
      return ok();
    },
  };
}

describe("computeVerification", () => {
  it("full green path: all checks pass, lines counted, FIX_REPORT excluded from changed files", async () => {
    const ws = fakeWorkspace({
      reproAdded: true,
      fixedFiles: ["src/exporters/billingFormatter.ts"],
      reproFailsOnOriginal: true,
      reproPassesOnFixed: true,
      suitePasses: true,
    });
    const out = await computeVerification(ws);
    expect(out.report).toEqual({
      reproTestAdded: true,
      reproTestFailsOnOriginal: true,
      reproTestPassesOnFixed: true,
      fullSuitePassed: true,
      linesChanged: 7,
    });
    expect(isVerified(out.report)).toBe(true);
    expect(out.changedFiles).toEqual(["src/exporters/billingFormatter.ts", REPRO_TEST_PATH]);
    expect(out.changedFiles).not.toContain("FIX_REPORT.md");
    // ordering: original check happens between stash push and pop
    const pushIdx = ws.calls.findIndex((c) => c.startsWith("git stash push"));
    const popIdx = ws.calls.findIndex((c) => c.startsWith("git stash pop"));
    const firstRepro = ws.calls.findIndex((c) => c.includes(`vitest run ${REPRO_TEST_PATH}`));
    expect(pushIdx).toBeLessThan(firstRepro);
    expect(firstRepro).toBeLessThan(popIdx);
  });

  it("repro test that passes on original ⇒ reproTestFailsOnOriginal=false", async () => {
    const ws = fakeWorkspace({
      reproAdded: true,
      fixedFiles: ["src/a.ts"],
      reproFailsOnOriginal: false,
      reproPassesOnFixed: true,
      suitePasses: true,
    });
    const out = await computeVerification(ws);
    expect(out.report.reproTestFailsOnOriginal).toBe(false);
    expect(isVerified(out.report)).toBe(false);
  });

  it("missing repro test skips all test runs", async () => {
    const ws = fakeWorkspace({
      reproAdded: false,
      fixedFiles: ["src/a.ts"],
      reproFailsOnOriginal: true,
      reproPassesOnFixed: true,
      suitePasses: true,
    });
    const out = await computeVerification(ws);
    expect(out.report.reproTestAdded).toBe(false);
    expect(out.report.reproTestFailsOnOriginal).toBe(false);
    expect(ws.calls.some((c) => c.includes("vitest"))).toBe(false);
    expect(out.details.join(" ")).toContain("no repro test");
  });

  it("repro test with no fix: current tree is treated as original", async () => {
    const ws = fakeWorkspace({
      reproAdded: true,
      fixedFiles: [],
      reproFailsOnOriginal: true,
      reproPassesOnFixed: false,
      suitePasses: true,
    });
    // with no fix, "stashed" never becomes true → repro run hits the fixed branch
    // of the fake, which returns fail → counted as fails-on-original.
    const out = await computeVerification(ws);
    expect(out.report.reproTestAdded).toBe(true);
    expect(out.report.reproTestFailsOnOriginal).toBe(true);
    expect(out.report.reproTestPassesOnFixed).toBe(false);
    expect(out.report.linesChanged).toBe(0);
    expect(ws.calls.some((c) => c.startsWith("git stash"))).toBe(false);
  });

  it("fails closed when stash pop breaks the workspace", async () => {
    const ws = fakeWorkspace({
      reproAdded: true,
      fixedFiles: ["src/a.ts"],
      reproFailsOnOriginal: true,
      reproPassesOnFixed: true,
      suitePasses: true,
      stashPopFails: true,
    });
    const out = await computeVerification(ws);
    expect(out.report.reproTestPassesOnFixed).toBe(false);
    expect(out.report.fullSuitePassed).toBe(false);
    expect(isVerified(out.report)).toBe(false);
    expect(out.details.join(" ")).toContain("FATAL");
  });
});
