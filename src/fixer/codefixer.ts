/**
 * CodeFixer — interface to the rest of the system is exactly
 * attemptFix(brief) (§6). The wrapper owns everything trust-sensitive:
 * workspace lifecycle, verification, branch/push/PR (the sandbox never sees
 * the GitHub token), and outcome classification.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeFixBrief, FixOutcome } from "../domain/types.js";
import type { FileChange, GitHubConnector } from "../connectors/types.js";
import type { Workspace, WorkspaceManager } from "./workspace.js";
import { buildFixPrompt, FIX_REPORT_PATH } from "./fixPrompt.js";
import { computeVerification, isVerified } from "./verify.js";
import { buildPrBody, type PrContext } from "./prBody.js";
import { sdkAgentRunner, type AgentRunner } from "./agentRunner.js";
import { log } from "../log.js";

export const FIXER_MODEL = "claude-opus-4-8";
const WALL_CLOCK_MS = 10 * 60 * 1000; // §6: 10 min, then kill
const MAX_AGENT_TURNS = 60;

export interface CodeFixerDeps {
  workspaces: WorkspaceManager;
  github: GitHubConnector;
  githubToken: string;
  agentRunner?: AgentRunner;
  options?: { wallClockMs?: number; maxTurns?: number; model?: string };
}

export class CodeFixer {
  private readonly runAgent: AgentRunner;

  constructor(private readonly deps: CodeFixerDeps) {
    this.runAgent = deps.agentRunner ?? sdkAgentRunner;
  }

  async attemptFix(brief: CodeFixBrief, ctx?: PrContext): Promise<FixOutcome> {
    const prCtx: PrContext = ctx ?? { investigationId: `adhoc-${Date.now().toString(36)}` };

    let workspace: Workspace;
    try {
      workspace = await this.deps.workspaces.create({
        repo: brief.repo,
        ref: brief.ref,
        githubToken: this.deps.githubToken,
      });
    } catch (e) {
      return { status: "failed", reason: `workspace init failed: ${(e as Error).message}`, transcript: "" };
    }

    try {
      const agent = await this.runAgent({
        workspace,
        prompt: buildFixPrompt(brief),
        timeoutMs: this.deps.options?.wallClockMs ?? WALL_CLOCK_MS,
        maxTurns: this.deps.options?.maxTurns ?? MAX_AGENT_TURNS,
        model: this.deps.options?.model ?? FIXER_MODEL,
      });
      log.info("fixer agent finished", {
        completed: agent.completed,
        timedOut: agent.timedOut,
        turns: agent.turns,
        costUsd: agent.costUsd,
      });

      if (agent.timedOut) {
        return {
          status: "failed",
          reason: `fix attempt exceeded the wall clock and was killed`,
          transcript: agent.transcriptTail,
        };
      }

      // ---- Wrapper-computed verification (never trusted from the model) ----
      const verification = await computeVerification(workspace);
      const fixReport = await readFile(join(workspace.dir, FIX_REPORT_PATH), "utf8").catch(() => null);
      log.info("verification computed", verification.report);

      if (!verification.report.reproTestAdded || !verification.report.reproTestFailsOnOriginal) {
        // no-repro is information, not failure: the diagnosis may be wrong.
        const which = !verification.report.reproTestAdded
          ? "no reproduction test was produced"
          : "the reproduction test does not fail on the original code";
        return {
          status: "no-repro",
          detail: `${which}. ${fixReport ? `Fixer report:\n${fixReport.slice(0, 1200)}` : `Agent transcript tail:\n${agent.transcriptTail.slice(-800)}`}`,
        };
      }

      if (verification.report.linesChanged === 0) {
        return {
          status: "failed",
          reason: "bug reproduced, but the agent produced no fix",
          transcript: agent.transcriptTail,
        };
      }

      // A fix exists → it leaves the sandbox via the wrapper only.
      const branch = `deploycontext/fix-${prCtx.investigationId}`;
      const files = await this.collectFiles(workspace, verification.changedFiles);

      const pushed = await this.pushBranch(brief, branch, files);
      if (!pushed.ok) {
        return {
          status: "failed",
          reason: `fix verified locally but pushing failed: ${pushed.detail}`,
          transcript: agent.transcriptTail,
        };
      }
      const branchUrl = `https://github.com/${brief.repo}/tree/${branch}`;

      if (!isVerified(verification.report)) {
        return {
          status: "fix-unverified",
          branchUrl,
          detail: `verification incomplete: ${verification.details.join(" | ")}`,
        };
      }

      const base = await this.resolveBaseBranch(brief);
      if (!base.ok) {
        return { status: "fix-unverified", branchUrl, detail: `could not prepare PR base: ${base.detail}` };
      }

      const pr = await this.deps.github.openPr(brief.repo, {
        base: base.name,
        head: branch,
        title: `[DeployContext] ${firstLine(brief.bugSummary)} (${brief.ref})`,
        body: buildPrBody({ brief, ctx: prCtx, verification: verification.report, fixReport }),
      });
      if (!pr.ok) {
        return { status: "fix-unverified", branchUrl, detail: `PR creation failed: ${pr.detail}` };
      }

      return {
        status: "pr-opened",
        prUrl: pr.data.url,
        summary: firstLine(brief.bugSummary),
        verification: verification.report,
      };
    } finally {
      await workspace.destroy().catch((e) => log.warn("workspace destroy failed", { error: String(e) }));
    }
  }

  private async collectFiles(workspace: Workspace, paths: string[]): Promise<FileChange[]> {
    const files: FileChange[] = [];
    for (const path of paths) {
      const content = await readFile(join(workspace.dir, path), "utf8").catch(() => null);
      if (content !== null) files.push({ path, content });
    }
    return files;
  }

  private async pushBranch(
    brief: CodeFixBrief,
    branch: string,
    files: FileChange[],
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const created = await this.deps.github.createBranch(brief.repo, brief.ref, branch);
    if (!created.ok) return { ok: false, detail: created.detail };
    const pushed = await this.deps.github.pushFiles(
      brief.repo,
      branch,
      files,
      `Fix: ${firstLine(brief.bugSummary)}\n\nGenerated by DeployContext against pinned ref ${brief.ref}.`,
    );
    if (!pushed.ok) return { ok: false, detail: pushed.detail };
    return { ok: true };
  }

  /**
   * PR base: the pinned branch itself, or a maintenance branch cut from the
   * tag for tag pins (§6) — never main.
   */
  private async resolveBaseBranch(
    brief: CodeFixBrief,
  ): Promise<{ ok: true; name: string } | { ok: false; detail: string }> {
    const refs = await this.deps.github.listRefs(brief.repo);
    if (!refs.ok) return { ok: false, detail: refs.detail };
    const match = refs.data.find((r) => r.name === brief.ref);
    if (match?.type === "branch") return { ok: true, name: brief.ref };

    const maint = `maint/${brief.ref}`;
    if (!refs.data.some((r) => r.name === maint && r.type === "branch")) {
      const created = await this.deps.github.createBranch(brief.repo, brief.ref, maint);
      if (!created.ok) return { ok: false, detail: created.detail };
    }
    return { ok: true, name: maint };
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0].slice(0, 100);
}
