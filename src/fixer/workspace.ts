/**
 * WorkspaceManager — the fixer's sandbox (§6).
 *
 * Security invariants (MUST):
 * - The GitHub token NEVER enters the sandbox: the clone happens on the host
 *   and the tokenized remote is scrubbed before anything else runs. We verify
 *   the scrub and fail closed.
 * - Tier 2 (docker, primary): after init (npm install with network), the
 *   container is disconnected from the network and we VERIFY it can't reach
 *   out before the agent phase begins. Everything the model executes runs via
 *   `docker exec` in that container.
 * - Tier 1 (tempdir, fallback): same shape without the container; commands run
 *   on the host with a minimal env (no tokens). Approximates no-network via
 *   tool scoping per the brief.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "../log.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Workspace {
  /** Host path of the repo checkout (wrapper reads/verifies from here). */
  readonly dir: string;
  readonly tier: "docker" | "tempdir";
  /** Run `bash -c command` in the workspace (inside the container on Tier 2). */
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  destroy(): Promise<void>;
}

export interface WorkspaceCreateOpts {
  repo: string; // owner/name
  ref: string;
  githubToken: string;
}

export interface WorkspaceManager {
  readonly tier: "docker" | "tempdir";
  create(opts: WorkspaceCreateOpts): Promise<Workspace>;
}

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Minimal env for host-side commands: no tokens, no inherited secrets. */
function minimalEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? homedir(),
  };
}

/** Spawn argv (no shell string interpolation) and capture output. */
export function run(
  argv: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: minimalEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\nspawn error: ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

export type CloneUrlBuilder = (repo: string, token: string) => string;
const defaultCloneUrl: CloneUrlBuilder = (repo, token) =>
  `https://x-access-token:${token}@github.com/${repo}.git`;

/**
 * Host-side clone at the pinned ref, then scrub the tokenized remote and
 * VERIFY nothing under .git still contains the token. Fails closed.
 */
async function cloneScrubbed(
  opts: WorkspaceCreateOpts,
  destDir: string,
  cloneUrl: CloneUrlBuilder,
): Promise<string> {
  const url = cloneUrl(opts.repo, opts.githubToken);
  const clone = await run(
    ["git", "clone", "--quiet", "--depth", "1", "--branch", opts.ref, url, "repo"],
    { cwd: destDir, timeoutMs: 120_000 },
  );
  if (clone.code !== 0) {
    throw new Error(`clone of ${opts.repo}@${opts.ref} failed: ${clone.stderr.slice(0, 400)}`);
  }
  const repoDir = join(destDir, "repo");
  const scrub = await run(["git", "remote", "remove", "origin"], { cwd: repoDir });
  if (scrub.code !== 0) throw new Error(`remote scrub failed: ${scrub.stderr}`);

  // Verify: the token must not survive anywhere in .git (fail closed).
  if (opts.githubToken.length > 0) {
    const config = await readFile(join(repoDir, ".git", "config"), "utf8");
    const grep = await run(["grep", "-r", "--fixed-strings", "-l", opts.githubToken, ".git"], {
      cwd: repoDir,
    });
    if (config.includes(opts.githubToken) || grep.code === 0) {
      throw new Error("token scrub verification failed — refusing to hand workspace to the agent");
    }
  }
  return repoDir;
}

async function workRoot(): Promise<string> {
  // Under $HOME so Docker Desktop's default file sharing covers the mount.
  const root = join(homedir(), ".deploycontext", "work");
  await mkdir(root, { recursive: true });
  return root;
}

// ---------------------------------------------------------------- Tier 1 --

class TempDirWorkspace implements Workspace {
  readonly tier = "tempdir" as const;

  constructor(
    readonly dir: string,
    private readonly rootDir: string,
  ) {}

  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return run(["bash", "-c", command], { cwd: this.dir, timeoutMs: opts?.timeoutMs });
  }

  async destroy(): Promise<void> {
    await rm(this.rootDir, { recursive: true, force: true });
  }
}

export class TempDirWorkspaceManager implements WorkspaceManager {
  readonly tier = "tempdir" as const;

  constructor(private readonly opts: { cloneUrl?: CloneUrlBuilder; skipInstall?: boolean } = {}) {}

  async create(create: WorkspaceCreateOpts): Promise<Workspace> {
    const root = await mkdtemp(join(await workRoot(), "dcfix-"));
    try {
      const repoDir = await cloneScrubbed(create, root, this.opts.cloneUrl ?? defaultCloneUrl);
      const ws = new TempDirWorkspace(repoDir, root);
      if (!this.opts.skipInstall) {
        const install = await ws.exec("npm install --no-fund --no-audit", {
          timeoutMs: INSTALL_TIMEOUT_MS,
        });
        if (install.code !== 0) {
          throw new Error(`npm install failed: ${install.stderr.slice(0, 400)}`);
        }
      }
      log.info("tempdir workspace ready", { dir: ws.dir });
      return ws;
    } catch (e) {
      await rm(root, { recursive: true, force: true });
      throw e;
    }
  }
}

// ---------------------------------------------------------------- Tier 2 --

class DockerWorkspace implements Workspace {
  readonly tier = "docker" as const;

  constructor(
    readonly dir: string,
    private readonly rootDir: string,
    private readonly container: string,
  ) {}

  async exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const inner = Math.max(1, Math.ceil(timeoutMs / 1000));
    // `timeout` inside the container so hung commands die there too; the
    // outer JS timer is the backstop.
    return run(
      ["docker", "exec", this.container, "timeout", `${inner}s`, "bash", "-c", command],
      { timeoutMs: timeoutMs + 10_000 },
    );
  }

  async destroy(): Promise<void> {
    await run(["docker", "rm", "-f", this.container], { timeoutMs: 30_000 });
    await rm(this.rootDir, { recursive: true, force: true });
  }
}

export class DockerWorkspaceManager implements WorkspaceManager {
  readonly tier = "docker" as const;

  constructor(
    private readonly opts: {
      image?: string;
      cloneUrl?: CloneUrlBuilder;
      skipInstall?: boolean;
    } = {},
  ) {}

  async create(create: WorkspaceCreateOpts): Promise<Workspace> {
    const daemon = await run(["docker", "info", "--format", "ok"], { timeoutMs: 15_000 });
    if (daemon.code !== 0) {
      throw new Error(
        "Docker daemon not reachable (WORKSPACE_TIER=docker). Start Docker, or set WORKSPACE_TIER=tempdir.",
      );
    }

    const image = this.opts.image ?? "node:22";
    const root = await mkdtemp(join(await workRoot(), "dcfix-"));
    const container = `dcfix-${randomBytes(4).toString("hex")}`;
    try {
      const repoDir = await cloneScrubbed(create, root, this.opts.cloneUrl ?? defaultCloneUrl);

      const started = await run(
        [
          "docker", "run", "-d", "--name", container,
          "-v", `${repoDir}:/workspace`, "-w", "/workspace",
          image, "sleep", "infinity",
        ],
        { timeoutMs: 180_000 }, // may pull the image on first use
      );
      if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr.slice(0, 400)}`);

      const ws = new DockerWorkspace(repoDir, root, container);

      // The mounted repo is owned by the host user; git inside the container
      // runs as root and needs this to operate on it.
      await run(["docker", "exec", container, "git", "config", "--global", "--add", "safe.directory", "/workspace"]);

      if (!this.opts.skipInstall) {
        // Init phase: network still on; install linux-native deps inside the
        // container. No credentials exist anywhere in it.
        const install = await ws.exec("npm install --no-fund --no-audit", {
          timeoutMs: INSTALL_TIMEOUT_MS,
        });
        if (install.code !== 0) {
          throw new Error(`npm install (in container) failed: ${install.stderr.slice(0, 400)}`);
        }
      }

      // ---- Network off, then PROVE it (fail closed) -----------------------
      const disconnect = await run(["docker", "network", "disconnect", "bridge", container], {
        timeoutMs: 30_000,
      });
      if (disconnect.code !== 0) {
        throw new Error(`network disconnect failed: ${disconnect.stderr.slice(0, 300)}`);
      }
      const probe = await ws.exec(
        `node -e "fetch('https://registry.npmjs.org',{signal:AbortSignal.timeout(4000)}).then(()=>{console.log('REACHABLE');process.exit(0)}).catch(()=>{console.log('UNREACHABLE');process.exit(7)})"`,
        { timeoutMs: 20_000 },
      );
      if (!probe.stdout.includes("UNREACHABLE")) {
        throw new Error("network-isolation probe FAILED — container can still reach the network");
      }
      log.info("docker workspace ready (network disconnected + verified)", {
        container,
        dir: ws.dir,
      });
      return ws;
    } catch (e) {
      await run(["docker", "rm", "-f", container], { timeoutMs: 30_000 });
      await rm(root, { recursive: true, force: true });
      throw e;
    }
  }
}

export function createWorkspaceManager(
  tier: "docker" | "tempdir",
  dockerImage?: string,
): WorkspaceManager {
  return tier === "docker"
    ? new DockerWorkspaceManager({ image: dockerImage })
    : new TempDirWorkspaceManager();
}
