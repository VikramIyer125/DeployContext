/**
 * Live GitHub connector (REST v3, bot-account PAT). Dumb by design: no
 * caching, no retry policy, no cross-referencing — errors are data.
 *
 * pushFiles uses the git data API so a multi-file change lands as ONE commit.
 */
import type { ConnectorResult, FileChange, GitHubConnector } from "./types.js";
import { ok, err } from "./types.js";

const API = "https://api.github.com";

/**
 * List file paths at a ref (used by the read_code tool to guide the model
 * after a missed path). Standalone helper, not part of GitHubConnector.
 */
export async function listRepoTree(
  token: string,
  repo: string,
  ref: string,
  apiBase: string = API,
): Promise<ConnectorResult<string[]>> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (e) {
    return err("unavailable", `network error calling GitHub: ${(e as Error).message}`);
  }
  if (!res.ok) {
    if (res.status === 404) return err("not-found", `ref "${ref}" not found in ${repo}`);
    return err("unavailable", `tree ${repo}@${ref} → ${res.status}`);
  }
  const data = (await res.json()) as { tree: Array<{ path: string; type: string }> };
  return ok(data.tree.filter((t) => t.type === "blob").map((t) => t.path).slice(0, 300));
}

export class GitHubLiveConnector implements GitHubConnector {
  constructor(
    private readonly token: string,
    private readonly apiBase: string = API,
  ) {}

  private async req(
    method: string,
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<ConnectorResult<Response>> {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: accept,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      return err("unavailable", `network error calling GitHub: ${(e as Error).message}`);
    }
    if (res.ok) return ok(res);
    const detail = `${method} ${path} → ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500);
    if (res.status === 401) return err("auth", detail);
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      return remaining === "0" ? err("rate-limited", detail) : err("auth", detail);
    }
    if (res.status === 404) return err("not-found", detail);
    return err("unavailable", detail);
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<ConnectorResult<T>> {
    const res = await this.req(method, path, body);
    if (!res.ok) return res;
    return ok((await res.data.json()) as T);
  }

  async listRefs(
    repo: string,
  ): Promise<ConnectorResult<Array<{ name: string; type: "branch" | "tag"; lastCommitAt: string }>>> {
    const [branches, tags] = await Promise.all([
      this.json<Array<{ name: string; commit: { sha: string } }>>(
        "GET",
        `/repos/${repo}/branches?per_page=100`,
      ),
      this.json<Array<{ name: string; commit: { sha: string } }>>(
        "GET",
        `/repos/${repo}/tags?per_page=100`,
      ),
    ]);
    if (!branches.ok) return branches;
    if (!tags.ok) return tags;

    const refs = [
      ...branches.data.map((b) => ({ name: b.name, type: "branch" as const, sha: b.commit.sha })),
      ...tags.data.map((t) => ({ name: t.name, type: "tag" as const, sha: t.commit.sha })),
    ];

    // One commit lookup per unique sha to attach lastCommitAt.
    const dates = new Map<string, string>();
    for (const sha of new Set(refs.map((r) => r.sha))) {
      const commit = await this.json<{ commit: { committer: { date: string } } }>(
        "GET",
        `/repos/${repo}/commits/${sha}`,
      );
      if (!commit.ok) return commit;
      dates.set(sha, commit.data.commit.committer.date);
    }

    return ok(refs.map(({ name, type, sha }) => ({ name, type, lastCommitAt: dates.get(sha)! })));
  }

  async readFile(repo: string, ref: string, path: string): Promise<ConnectorResult<string>> {
    const res = await this.req(
      "GET",
      `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      undefined,
      "application/vnd.github.raw+json",
    );
    if (!res.ok) return res;
    return ok(await res.data.text());
  }

  /** Resolve a branch name, tag name (annotated or lightweight), or raw sha to a commit sha. */
  private async resolveSha(repo: string, ref: string): Promise<ConnectorResult<string>> {
    if (/^[0-9a-f]{40}$/i.test(ref)) return ok(ref);
    for (const kind of ["heads", "tags"]) {
      const res = await this.json<{ object: { sha: string; type: string } }>(
        "GET",
        `/repos/${repo}/git/ref/${kind}/${encodeURIComponent(ref)}`,
      );
      if (!res.ok) {
        if (res.reason === "not-found") continue;
        return res;
      }
      if (res.data.object.type === "tag") {
        // Annotated tag: dereference to the underlying commit.
        const tag = await this.json<{ object: { sha: string } }>(
          "GET",
          `/repos/${repo}/git/tags/${res.data.object.sha}`,
        );
        if (!tag.ok) return tag;
        return ok(tag.data.object.sha);
      }
      return ok(res.data.object.sha);
    }
    return err("not-found", `ref "${ref}" not found in ${repo} (tried heads/ and tags/)`);
  }

  async createBranch(repo: string, fromRef: string, name: string): Promise<ConnectorResult<void>> {
    const sha = await this.resolveSha(repo, fromRef);
    if (!sha.ok) return sha;
    const res = await this.req("POST", `/repos/${repo}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha: sha.data,
    });
    if (!res.ok) {
      // 422 "Reference already exists" — treat as success for retry friendliness.
      if (res.detail.includes("already exists")) return ok(undefined);
      return res;
    }
    return ok(undefined);
  }

  async pushFiles(
    repo: string,
    branch: string,
    files: FileChange[],
    message: string,
  ): Promise<ConnectorResult<void>> {
    const head = await this.json<{ object: { sha: string } }>(
      "GET",
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    if (!head.ok) return head;

    const headCommit = await this.json<{ tree: { sha: string } }>(
      "GET",
      `/repos/${repo}/git/commits/${head.data.object.sha}`,
    );
    if (!headCommit.ok) return headCommit;

    const tree = await this.json<{ sha: string }>("POST", `/repos/${repo}/git/trees`, {
      base_tree: headCommit.data.tree.sha,
      tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    });
    if (!tree.ok) return tree;

    const commit = await this.json<{ sha: string }>("POST", `/repos/${repo}/git/commits`, {
      message,
      tree: tree.data.sha,
      parents: [head.data.object.sha],
    });
    if (!commit.ok) return commit;

    const update = await this.req("PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha: commit.data.sha,
    });
    if (!update.ok) return update;
    return ok(undefined);
  }

  async openPr(
    repo: string,
    p: { base: string; head: string; title: string; body: string },
  ): Promise<ConnectorResult<{ url: string }>> {
    const res = await this.json<{ html_url: string }>("POST", `/repos/${repo}/pulls`, p);
    if (res.ok) return ok({ url: res.data.html_url });

    // If a PR for this head already exists, surface it instead of failing.
    if (res.detail.includes("already exists")) {
      const owner = repo.split("/")[0];
      const existing = await this.json<Array<{ html_url: string }>>(
        "GET",
        `/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(p.head)}`,
      );
      if (existing.ok && existing.data.length > 0) return ok({ url: existing.data[0].html_url });
    }
    return res;
  }
}
