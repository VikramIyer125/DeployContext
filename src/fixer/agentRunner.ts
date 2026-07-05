/**
 * SDK agent runner — the Claude Agent SDK process runs on the HOST (wrapper
 * side); the model's only execution path is the run_command tool, which is
 * bound to Workspace.exec (docker exec into the network-less container on
 * Tier 2). File tools are path-guarded to the checkout. The agent subprocess
 * env carries NO GitHub/Slack tokens.
 */
import { realpath } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import {
  query,
  tool,
  createSdkMcpServer,
  type HookCallback,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Workspace } from "./workspace.js";
import { FIXER_SYSTEM_PROMPT } from "./fixPrompt.js";
import { log } from "../log.js";

export interface AgentRunArgs {
  workspace: Workspace;
  prompt: string;
  timeoutMs: number;
  maxTurns: number;
  model: string;
}

export interface AgentRunResult {
  completed: boolean;
  timedOut: boolean;
  turns: number;
  costUsd: number;
  transcriptTail: string;
}

export type AgentRunner = (args: AgentRunArgs) => Promise<AgentRunResult>;

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);

/**
 * Path guard for the built-in file tools, enforced via a PreToolUse hook —
 * `canUseTool` is never consulted under bypassPermissions, hooks always run.
 * Scopes the agent to the checkout and keeps it out of .git.
 */
function pathGuardHook(rootReal: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    if (!FILE_TOOLS.has(pre.tool_name)) return {};
    const raw =
      (pre.tool_input as { file_path?: string; path?: string }).file_path ??
      (pre.tool_input as { path?: string }).path;
    if (!raw) return {}; // e.g. Glob/Grep with no path → defaults to cwd
    const abs = isAbsolute(raw) ? raw : resolve(rootReal, raw);
    const inside = abs === rootReal || abs.startsWith(`${rootReal}/`);
    const touchesGit = abs.includes("/.git/") || abs.endsWith("/.git");
    if (!inside || touchesGit) {
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: "deny",
          permissionDecisionReason: `path outside the sandboxed checkout (or .git) is off-limits: ${raw}`,
        },
      };
    }
    return {};
  };
}

export const sdkAgentRunner: AgentRunner = async ({ workspace, prompt, timeoutMs, maxTurns, model }) => {
  const rootReal = await realpath(workspace.dir);

  const sandboxServer = createSdkMcpServer({
    name: "sandbox",
    version: "1.0.0",
    tools: [
      tool(
        "run_command",
        "Run a shell command inside the sandboxed repo checkout (cwd = repo root, NO network). Use for npm/vitest/node/ls etc.",
        {
          command: z.string().describe("bash command to run"),
          timeout_seconds: z.number().optional().describe("default 120"),
        },
        async (args) => {
          const result = await workspace.exec(args.command, {
            timeoutMs: Math.min(args.timeout_seconds ?? 120, 300) * 1000,
          });
          const text = [
            result.timedOut ? "(command timed out)" : `exit code: ${result.code}`,
            "--- stdout (tail) ---",
            result.stdout.slice(-6000),
            "--- stderr (tail) ---",
            result.stderr.slice(-3000),
          ].join("\n");
          return { content: [{ type: "text", text }] };
        },
      ),
    ],
  });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  const transcript: string[] = [];
  let completed = false;
  let timedOut = false;
  let turns = 0;
  let costUsd = 0;

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: workspace.dir,
        model,
        maxTurns,
        systemPrompt: FIXER_SYSTEM_PROMPT,
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "mcp__sandbox__run_command"],
        disallowedTools: ["Bash", "WebFetch", "WebSearch", "Task", "NotebookEdit"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        mcpServers: { sandbox: sandboxServer },
        abortController: abort,
        // Minimal env: the fixer subprocess never sees GitHub/Slack tokens.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
        },
        hooks: {
          PreToolUse: [{ hooks: [pathGuardHook(rootReal)] }],
        },
      },
    })) {
      if (message.type === "assistant") {
        const blocks = (message as { message?: { content?: Array<{ type: string; text?: string }> } })
          .message?.content;
        for (const b of blocks ?? []) {
          if (b.type === "text" && b.text) transcript.push(b.text);
        }
      }
      if (message.type === "result") {
        const r = message as { subtype?: string; num_turns?: number; total_cost_usd?: number };
        completed = r.subtype === "success";
        turns = r.num_turns ?? 0;
        costUsd = r.total_cost_usd ?? 0;
      }
    }
  } catch (e) {
    if (abort.signal.aborted) {
      timedOut = true;
    } else {
      transcript.push(`agent error: ${(e as Error).message}`);
      log.error("fixer agent error", { error: (e as Error).message });
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    completed,
    timedOut,
    turns,
    costUsd,
    transcriptTail: transcript.join("\n\n").slice(-4000),
  };
};
