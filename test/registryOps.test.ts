import { describe, it, expect } from "vitest";
import { ProposalStore } from "../src/registry/proposals.js";
import { RegistryManager } from "../src/registry/manager.js";
import { parseManifest } from "../src/registry/manifest.js";
import { Registry } from "../src/registry/registry.js";
import { ok } from "../src/connectors/types.js";
import { buildTestWorld, TEST_MANIFEST } from "./helpers.js";
import type { Provenance } from "../src/domain/types.js";

const PROV: Provenance[] = [
  {
    source: "slack",
    evidenceUrl: "https://sandbox.slack.com/archives/C0BEUB621F1/p777",
    observedAt: "2026-07-05T12:00:00Z",
    confidence: "inferred-high",
  },
];

function makeManager() {
  const world = buildTestWorld();
  const store = new ProposalStore(":memory:");
  const manager = new RegistryManager({
    github: world.github,
    registry: world.registry,
    repo: "yourco/fake-product",
    manifestPath: "deployments.yaml",
  });
  return { world, store, manager };
}

describe("ProposalStore", () => {
  it("round-trips proposals with payload, card, and status transitions", () => {
    const store = new ProposalStore(":memory:");
    const p = store.create({
      kind: "version-bump",
      customer: "acme",
      change: { versionPin: "v2.5.0" },
      provenance: PROV,
    });
    expect(store.get(p.id)).toMatchObject({
      kind: "version-bump",
      customer: "acme",
      change: { versionPin: "v2.5.0" },
      status: "pending",
    });
    expect(store.get(p.id)!.provenance).toEqual(PROV);

    store.setCard(p.id, "C0BEUB621F1", "123.456");
    expect(store.get(p.id)!.confirmCard).toEqual({ channel: "C0BEUB621F1", ts: "123.456" });

    store.setStatus(p.id, "applied");
    expect(store.get(p.id)!.status).toBe("applied");
    expect(store.pending()).toHaveLength(0);
  });
});

describe("RegistryManager.apply", () => {
  it("version bump → DIRECT commit to main with updated pin and new provenance", async () => {
    const { world, store, manager } = makeManager();
    const p = store.create({
      kind: "version-bump",
      customer: "acme",
      change: { versionPin: "v2.5.0", ref: "main" },
      provenance: PROV,
    });
    const res = await manager.apply(p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mode).toBe("commit");

    expect(world.github.pushes).toHaveLength(1);
    const push = world.github.pushes[0];
    expect(push.branch).toBe("main");
    const updated = parseManifest(push.files[0].content);
    const acme = updated.find((e) => e.customer === "acme")!;
    expect(acme.versionPin.value).toBe("v2.5.0");
    expect(acme.code.ref.value).toBe("main");
    expect(acme.versionPin.provenance).toEqual(PROV);
    // beta untouched
    expect(updated.find((e) => e.customer === "beta")!.versionPin.value).toBe("v2.5.0");
    expect(world.github.prs).toHaveLength(0);
  });

  it("new customer → branch + PR against main, never a direct commit", async () => {
    const { world, store, manager } = makeManager();
    const entries = parseManifest(TEST_MANIFEST);
    const gamma = structuredClone(entries[0]);
    gamma.customer = "gamma";
    gamma.displayName = "Gamma LLC";
    const p = store.create({ kind: "new-customer", customer: "gamma", entry: gamma, provenance: PROV });

    const res = await manager.apply(p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mode).toBe("pr");

    expect(world.github.prs).toHaveLength(1);
    expect(world.github.prs[0].base).toBe("main");
    expect(world.github.prs[0].head).toBe(`deploycontext/registry-${p.id}`);
    expect(world.github.prs[0].body).toContain(PROV[0].evidenceUrl);
    const pushed = parseManifest(world.github.pushes[0].files[0].content);
    expect(pushed.map((e) => e.customer)).toEqual(["acme", "beta", "gamma"]);
  });

  it("errors as data: unknown customer, empty change", async () => {
    const { store, manager } = makeManager();
    const unknown = store.create({
      kind: "version-bump",
      customer: "globex",
      change: { versionPin: "v9" },
      provenance: PROV,
    });
    expect(await manager.apply(unknown)).toMatchObject({ ok: false, reason: "not-found" });

    const empty = store.create({ kind: "version-bump", customer: "acme", change: {}, provenance: PROV });
    expect(await manager.apply(empty)).toMatchObject({ ok: false });
  });

  it("refreshes the registry cache after a direct commit", async () => {
    const { world, store } = makeManager();
    // registry backed by the fake github's mutable main manifest
    const registry = new Registry(async () => world.github.readFile("yourco/fake-product", "main", "deployments.yaml"));
    const manager = new RegistryManager({
      github: world.github,
      registry,
      repo: "yourco/fake-product",
      manifestPath: "deployments.yaml",
    });
    await registry.ensureLoaded();
    expect(registry.get("acme")!.versionPin.value).toBe("v2.3.1");

    const p = store.create({
      kind: "version-bump",
      customer: "acme",
      change: { versionPin: "v2.5.0" },
      provenance: PROV,
    });
    const res = await manager.apply(p);
    expect(res.ok).toBe(true);
    expect(registry.get("acme")!.versionPin.value).toBe("v2.5.0");
  });
});
