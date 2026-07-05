import { describe, it, expect } from "vitest";
import { formatState, clarifyCustomer } from "../src/slack/format.js";
import { StateResolver } from "../src/resolve/resolver.js";
import { buildTestWorld } from "./helpers.js";

async function resolveAcme() {
  const world = buildTestWorld();
  const resolver = new StateResolver({
    registry: world.registry,
    github: world.github,
    unleash: world.unleash,
    unleashBaseUrl: "http://localhost:4242",
  });
  const res = await resolver.resolve("acme");
  if (!res.ok) throw new Error("resolve failed");
  await world.registry.ensureLoaded();
  return { outcome: res.data, entry: world.registry.get("acme")!, world };
}

describe("formatState", () => {
  it("renders version, ref, flags and config with provenance context lines", async () => {
    const { outcome, entry } = await resolveAcme();
    const { text, blocks } = formatState(entry, outcome);

    expect(text).toContain("Acme Corp");
    expect(text).toContain("v2.3.1");

    const flat = JSON.stringify(blocks);
    expect(flat).toContain("acme-prod-v2.3.1");
    expect(flat).toContain("`new_billing`");
    expect(flat).toContain("`legacy_export`");
    expect(flat).toContain("batchSize: 500");
    // provenance surfaces on every fact
    expect(flat).toContain("unleash · confirmed");
    expect(flat).toContain("github · confirmed");
    expect(flat).toContain("human · confirmed");
    // notes are surfaced
    expect(flat).toContain("upgrade window");
  });

  it("separates enabled and disabled flags", async () => {
    const { outcome, entry } = await resolveAcme();
    const flat = JSON.stringify(formatState(entry, outcome).blocks);
    const onSection = flat.slice(flat.indexOf("*on:*"), flat.indexOf("*off:*"));
    expect(onSection).toContain("new_billing");
    expect(onSection).not.toContain("legacy_export");
  });

  it("surfaces resolver warnings", async () => {
    const { entry, world } = await resolveAcme();
    world.unleash.failWith = { reason: "unavailable", detail: "boom" };
    const resolver = new StateResolver({
      registry: world.registry,
      github: world.github,
      unleash: world.unleash,
      unleashBaseUrl: "http://localhost:4242",
    });
    const res = await resolver.resolve("acme");
    if (!res.ok) throw new Error("resolve failed");
    const flat = JSON.stringify(formatState(entry, res.data).blocks);
    expect(flat).toContain("flags unavailable");
    expect(flat).toContain("warning");
  });

  it("truncates long configs", async () => {
    const { outcome, entry } = await resolveAcme();
    outcome.state.config.value = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`key${i}`, i]),
    );
    const flat = JSON.stringify(formatState(entry, outcome).blocks);
    expect(flat).toContain("truncated");
  });
});

describe("clarifyCustomer", () => {
  it("lists known customers", () => {
    const msg = clarifyCustomer(["acme", "beta"]);
    expect(msg).toContain("`acme`");
    expect(msg).toContain("`beta`");
    expect(msg).toContain("Which customer");
  });
});
