import { describe, it, expect } from "vitest";
import { loadConfig, EnvError } from "../src/env.js";

const FULL_ENV = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  GITHUB_TOKEN: "ghp_test",
  GITHUB_REPO: "yourco/fake-product",
  DEPLOY_CHANNEL_ID: "C123",
};

describe("loadConfig", () => {
  it("loads a complete env with defaults applied", () => {
    const cfg = loadConfig({ ...FULL_ENV });
    expect(cfg.githubRepo).toBe("yourco/fake-product");
    expect(cfg.unleashUrl).toBe("http://localhost:4242");
    expect(cfg.manifestPath).toBe("deployments.yaml");
    expect(cfg.logFixturesPath).toBe("fixtures/logs.json");
    expect(cfg.sqlitePath).toBe("data/deploycontext.db");
    expect(cfg.workspaceTier).toBe("docker");
  });

  it("fails fast naming ALL missing vars at once", () => {
    const env = { ...FULL_ENV } as Record<string, string>;
    delete env.SLACK_BOT_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    try {
      loadConfig(env);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const msg = (e as Error).message;
      expect(msg).toContain("SLACK_BOT_TOKEN");
      expect(msg).toContain("ANTHROPIC_API_KEY");
      expect(msg).not.toContain("GITHUB_TOKEN ");
    }
  });

  it("treats whitespace-only values as missing", () => {
    expect(() => loadConfig({ ...FULL_ENV, SLACK_APP_TOKEN: "   " })).toThrow(/SLACK_APP_TOKEN/);
  });

  it("rejects an invalid WORKSPACE_TIER", () => {
    expect(() => loadConfig({ ...FULL_ENV, WORKSPACE_TIER: "vm" })).toThrow(/WORKSPACE_TIER/);
  });

  it("accepts tempdir tier", () => {
    expect(loadConfig({ ...FULL_ENV, WORKSPACE_TIER: "tempdir" }).workspaceTier).toBe("tempdir");
  });
});
