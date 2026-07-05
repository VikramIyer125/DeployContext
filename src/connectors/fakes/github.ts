/**
 * In-memory GitHubConnector for offline tests. Seed it with refs and
 * per-ref file trees; it records branch/push/PR mutations for assertions.
 */
import type { ConnectorResult, FileChange, GitHubConnector } from "../types.js";
import { ok, err } from "../types.js";

export interface FakeGitHubSeed {
  refs?: Array<{ name: string; type: "branch" | "tag"; lastCommitAt: string }>;
  /** ref → path → content */
  files?: Record<string, Record<string, string>>;
}

export class FakeGitHub implements GitHubConnector {
  refs: Array<{ name: string; type: "branch" | "tag"; lastCommitAt: string }>;
  files: Record<string, Record<string, string>>;
  pushes: Array<{ repo: string; branch: string; files: FileChange[]; message: string }> = [];
  prs: Array<{ repo: string; base: string; head: string; title: string; body: string }> = [];
  failWith: { reason: "auth" | "not-found" | "rate-limited" | "unavailable"; detail: string } | null =
    null;

  constructor(seed: FakeGitHubSeed = {}) {
    this.refs = seed.refs ?? [];
    this.files = structuredClone(seed.files ?? {});
  }

  async listRefs(
    _repo: string,
  ): Promise<ConnectorResult<Array<{ name: string; type: "branch" | "tag"; lastCommitAt: string }>>> {
    if (this.failWith) return err(this.failWith.reason, this.failWith.detail);
    return ok([...this.refs]);
  }

  async readFile(repo: string, ref: string, path: string): Promise<ConnectorResult<string>> {
    if (this.failWith) return err(this.failWith.reason, this.failWith.detail);
    const content = this.files[ref]?.[path];
    if (content === undefined) return err("not-found", `${repo}@${ref}:${path} not found`);
    return ok(content);
  }

  async createBranch(repo: string, fromRef: string, name: string): Promise<ConnectorResult<void>> {
    if (this.failWith) return err(this.failWith.reason, this.failWith.detail);
    if (!this.files[fromRef]) return err("not-found", `ref "${fromRef}" not found in ${repo}`);
    this.files[name] = { ...this.files[fromRef] };
    this.refs.push({ name, type: "branch", lastCommitAt: new Date().toISOString() });
    return ok(undefined);
  }

  async pushFiles(
    repo: string,
    branch: string,
    files: FileChange[],
    message: string,
  ): Promise<ConnectorResult<void>> {
    if (this.failWith) return err(this.failWith.reason, this.failWith.detail);
    if (!this.files[branch]) return err("not-found", `branch "${branch}" not found in ${repo}`);
    for (const f of files) this.files[branch][f.path] = f.content;
    this.pushes.push({ repo, branch, files, message });
    return ok(undefined);
  }

  async openPr(
    repo: string,
    p: { base: string; head: string; title: string; body: string },
  ): Promise<ConnectorResult<{ url: string }>> {
    if (this.failWith) return err(this.failWith.reason, this.failWith.detail);
    this.prs.push({ repo, ...p });
    return ok({ url: `https://github.com/${repo}/pull/${this.prs.length}` });
  }
}
