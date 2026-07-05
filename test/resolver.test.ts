import { describe, it, expect } from "vitest";
import { StateResolver } from "../src/resolve/resolver.js";
import { Registry } from "../src/registry/registry.js";
import { err } from "../src/connectors/types.js";
import { buildTestWorld, ACME_FLAGS } from "./helpers.js";

const UNLEASH_URL = "http://localhost:4242";

function makeResolver() {
  const world = buildTestWorld();
  return {
    ...world,
    resolver: new StateResolver({
      registry: world.registry,
      github: world.github,
      unleash: world.unleash,
      unleashBaseUrl: UNLEASH_URL,
    }),
  };
}

describe("StateResolver", () => {
  it("resolves acme's full state with provenance on every fact", async () => {
    const { resolver } = makeResolver();
    const res = await resolver.resolve("acme");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const { state, warnings } = res.data;
    expect(warnings).toEqual([]);
    expect(state.customer).toBe("acme");

    // version comes from the manifest pin, carrying manifest provenance
    expect(state.version.value).toBe("v2.3.1");
    expect(state.version.provenance[0]).toMatchObject({ source: "human", confidence: "confirmed" });

    // flags are live from Unleash with fresh provenance
    expect(state.flags.value).toEqual(ACME_FLAGS);
    expect(state.flags.value.new_billing).toBe(true);
    expect(state.flags.value.legacy_export).toBe(false);
    expect(state.flags.provenance[0]).toMatchObject({ source: "unleash", confidence: "confirmed" });
    expect(state.flags.provenance[0].evidenceUrl).toContain(UNLEASH_URL);

    // config is read from GitHub at the customer's pinned ref
    expect(state.config.value).toMatchObject({
      export: { delimiter: ",", batchSize: 500, includeHeader: false },
      region: "us-east-1",
    });
    expect(state.config.provenance[0]).toMatchObject({ source: "github", confidence: "confirmed" });
    expect(state.config.provenance[0].evidenceUrl).toContain("acme-prod-v2.3.1");
  });

  it("resolves beta against main", async () => {
    const { resolver } = makeResolver();
    const res = await resolver.resolve("beta");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.state.version.value).toBe("v2.5.0");
    expect(res.data.state.flags.value.new_billing).toBe(false);
    expect(res.data.state.flags.value.legacy_export).toBe(true);
    expect(res.data.state.config.value).toMatchObject({ region: "eu-west-1" });
  });

  it("returns not-found with known customers for an unknown customer", async () => {
    const { resolver } = makeResolver();
    const res = await resolver.resolve("globex");
    expect(res).toMatchObject({ ok: false, reason: "not-found" });
    if (res.ok) return;
    expect(res.detail).toContain("acme");
    expect(res.detail).toContain("beta");
  });

  it("degrades to a warning when Unleash is down (flags empty, rest intact)", async () => {
    const { resolver, unleash } = makeResolver();
    unleash.failWith = { reason: "unavailable", detail: "connection refused" };
    const res = await resolver.resolve("acme");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.warnings).toHaveLength(1);
    expect(res.data.warnings[0]).toContain("flags unavailable");
    expect(res.data.state.flags.value).toEqual({});
    expect(res.data.state.flags.provenance).toEqual([]);
    expect(res.data.state.config.value).toMatchObject({ region: "us-east-1" });
  });

  it("degrades to a warning when config is missing at the ref", async () => {
    const { resolver, github } = makeResolver();
    delete github.files["acme-prod-v2.3.1"]["customers/acme/values.yaml"];
    const res = await resolver.resolve("acme");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.warnings.some((w) => w.includes("config unavailable"))).toBe(true);
    expect(res.data.state.config.value).toEqual({});
    expect(res.data.state.flags.value.new_billing).toBe(true);
  });

  it("warns when config exists but is not a mapping", async () => {
    const { resolver, github } = makeResolver();
    github.files["acme-prod-v2.3.1"]["customers/acme/values.yaml"] = "- just\n- a\n- list\n";
    const res = await resolver.resolve("acme");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.warnings.some((w) => w.includes("config unparseable"))).toBe(true);
    expect(res.data.state.config.value).toEqual({});
  });

  it("propagates registry loader failure", async () => {
    const world = buildTestWorld();
    const registry = new Registry(async () => err("auth", "bad manifest token"));
    const resolver = new StateResolver({
      registry,
      github: world.github,
      unleash: world.unleash,
      unleashBaseUrl: UNLEASH_URL,
    });
    const res = await resolver.resolve("acme");
    expect(res).toMatchObject({ ok: false, reason: "auth" });
  });
});

describe("Registry", () => {
  it("maps channels to customers", async () => {
    const { registry } = buildTestWorld();
    await registry.ensureLoaded();
    expect(registry.byChannel("C0123ACME")?.customer).toBe("acme");
    expect(registry.byChannel("C_UNKNOWN")).toBeUndefined();
  });

  it("caches until refresh", async () => {
    const { registry } = buildTestWorld();
    expect(registry.isLoaded).toBe(false);
    await registry.ensureLoaded();
    expect(registry.isLoaded).toBe(true);
    expect(registry.list()).toHaveLength(2);
  });
});
