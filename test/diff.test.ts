import { describe, it, expect } from "vitest";
import { diff } from "../src/resolve/diff.js";
import { makeState } from "./helpers.js";

describe("diff()", () => {
  it("returns no deltas for identical states", () => {
    const a = makeState({
      customer: "acme",
      version: "v2.3.1",
      flags: { x: true, y: "variant-a" },
      config: { export: { batchSize: 500 }, region: "us-east-1" },
    });
    const b = makeState({
      customer: "beta",
      version: "v2.3.1",
      flags: { x: true, y: "variant-a" },
      config: { export: { batchSize: 500 }, region: "us-east-1" },
    });
    const d = diff(a, b);
    expect(d).toEqual({ a: "acme", b: "beta", versionDelta: null, flagDeltas: [], configDeltas: [] });
  });

  it("labels the delta with both customer ids", () => {
    const d = diff(makeState({ customer: "acme" }), makeState({ customer: "beta" }));
    expect(d.a).toBe("acme");
    expect(d.b).toBe("beta");
  });

  describe("versionDelta", () => {
    it("is null when versions match", () => {
      const d = diff(
        makeState({ customer: "a", version: "v2.5.0" }),
        makeState({ customer: "b", version: "v2.5.0" }),
      );
      expect(d.versionDelta).toBeNull();
    });

    it("captures both sides when versions differ", () => {
      const d = diff(
        makeState({ customer: "a", version: "v2.3.1" }),
        makeState({ customer: "b", version: "v2.5.0" }),
      );
      expect(d.versionDelta).toEqual({ a: "v2.3.1", b: "v2.5.0" });
    });
  });

  describe("flagDeltas", () => {
    it("captures boolean flips", () => {
      const d = diff(
        makeState({ customer: "a", flags: { new_billing: true, legacy_export: false } }),
        makeState({ customer: "b", flags: { new_billing: false, legacy_export: true } }),
      );
      expect(d.flagDeltas).toEqual([
        { flag: "legacy_export", a: false, b: true },
        { flag: "new_billing", a: true, b: false },
      ]);
    });

    it("captures string variant differences", () => {
      const d = diff(
        makeState({ customer: "a", flags: { theme: "dark" } }),
        makeState({ customer: "b", flags: { theme: "light" } }),
      );
      expect(d.flagDeltas).toEqual([{ flag: "theme", a: "dark", b: "light" }]);
    });

    it("captures flags present on only one side as undefined on the other", () => {
      const d = diff(
        makeState({ customer: "a", flags: { only_a: true } }),
        makeState({ customer: "b", flags: { only_b: false } }),
      );
      expect(d.flagDeltas).toEqual([
        { flag: "only_a", a: true, b: undefined },
        { flag: "only_b", a: undefined, b: false },
      ]);
    });

    it("does not report a flag false on both sides", () => {
      const d = diff(
        makeState({ customer: "a", flags: { off_everywhere: false } }),
        makeState({ customer: "b", flags: { off_everywhere: false } }),
      );
      expect(d.flagDeltas).toEqual([]);
    });

    it("sorts deltas alphabetically for determinism", () => {
      const d = diff(
        makeState({ customer: "a", flags: { zeta: true, alpha: true, mid: true } }),
        makeState({ customer: "b", flags: { zeta: false, alpha: false, mid: false } }),
      );
      expect(d.flagDeltas.map((f) => f.flag)).toEqual(["alpha", "mid", "zeta"]);
    });

    it("distinguishes false from missing", () => {
      const d = diff(
        makeState({ customer: "a", flags: { f: false } }),
        makeState({ customer: "b", flags: {} }),
      );
      expect(d.flagDeltas).toEqual([{ flag: "f", a: false, b: undefined }]);
    });
  });

  describe("configDeltas", () => {
    it("is empty for identical nested configs", () => {
      const cfg = { export: { batchSize: 500, delimiter: "," }, support: { tier: "enterprise" } };
      const d = diff(
        makeState({ customer: "a", config: structuredClone(cfg) }),
        makeState({ customer: "b", config: structuredClone(cfg) }),
      );
      expect(d.configDeltas).toEqual([]);
    });

    it("reports nested scalar changes with dotted paths", () => {
      const d = diff(
        makeState({ customer: "a", config: { export: { batchSize: 500 } } }),
        makeState({ customer: "b", config: { export: { batchSize: 100 } } }),
      );
      expect(d.configDeltas).toEqual([{ path: "export.batchSize", a: 500, b: 100 }]);
    });

    it("reports deeply nested changes", () => {
      const d = diff(
        makeState({ customer: "a", config: { a: { b: { c: { d: 1 } } } } }),
        makeState({ customer: "b", config: { a: { b: { c: { d: 2 } } } } }),
      );
      expect(d.configDeltas).toEqual([{ path: "a.b.c.d", a: 1, b: 2 }]);
    });

    it("reports keys missing on one side", () => {
      const d = diff(
        makeState({ customer: "a", config: { region: "us-east-1" } }),
        makeState({ customer: "b", config: {} }),
      );
      expect(d.configDeltas).toEqual([{ path: "region", a: "us-east-1", b: undefined }]);
    });

    it("treats null as an atomic value", () => {
      const d = diff(
        makeState({ customer: "a", config: { x: null } }),
        makeState({ customer: "b", config: { x: 5 } }),
      );
      expect(d.configDeltas).toEqual([{ path: "x", a: null, b: 5 }]);
    });

    it("treats equal arrays as equal", () => {
      const d = diff(
        makeState({ customer: "a", config: { hosts: ["a", "b"] } }),
        makeState({ customer: "b", config: { hosts: ["a", "b"] } }),
      );
      expect(d.configDeltas).toEqual([]);
    });

    it("reports differing arrays as one atomic delta at the array path", () => {
      const d = diff(
        makeState({ customer: "a", config: { hosts: ["a", "b"] } }),
        makeState({ customer: "b", config: { hosts: ["a", "c"] } }),
      );
      expect(d.configDeltas).toEqual([{ path: "hosts", a: ["a", "b"], b: ["a", "c"] }]);
    });

    it("compares objects nested inside arrays deeply-but-atomically", () => {
      const d1 = diff(
        makeState({ customer: "a", config: { rules: [{ match: "x", allow: true }] } }),
        makeState({ customer: "b", config: { rules: [{ allow: true, match: "x" }] } }),
      );
      expect(d1.configDeltas).toEqual([]);

      const d2 = diff(
        makeState({ customer: "a", config: { rules: [{ match: "x" }] } }),
        makeState({ customer: "b", config: { rules: [{ match: "y" }] } }),
      );
      expect(d2.configDeltas).toHaveLength(1);
      expect(d2.configDeltas[0].path).toBe("rules");
    });

    it("reports a type change (object vs scalar) as one atomic delta", () => {
      const d = diff(
        makeState({ customer: "a", config: { limits: { rps: 10 } } }),
        makeState({ customer: "b", config: { limits: 10 } }),
      );
      expect(d.configDeltas).toEqual([{ path: "limits", a: { rps: 10 }, b: 10 }]);
    });

    it("reports array vs object as one atomic delta", () => {
      const d = diff(
        makeState({ customer: "a", config: { x: [1, 2] } }),
        makeState({ customer: "b", config: { x: { 0: 1, 1: 2 } } }),
      );
      expect(d.configDeltas).toHaveLength(1);
      expect(d.configDeltas[0].path).toBe("x");
    });

    it("sorts config deltas by path for determinism", () => {
      const d = diff(
        makeState({ customer: "a", config: { z: 1, a: 1, m: { q: 1 } } }),
        makeState({ customer: "b", config: { z: 2, a: 2, m: { q: 2 } } }),
      );
      expect(d.configDeltas.map((c) => c.path)).toEqual(["a", "m.q", "z"]);
    });
  });

  it("handles the demo scenario end-to-end (acme vs beta)", () => {
    const acme = makeState({
      customer: "acme",
      version: "v2.3.1",
      flags: { new_billing: true, legacy_export: false, dark_mode_v2: true, beta_dashboard: false },
      config: {
        export: { delimiter: ",", batchSize: 500, includeHeader: false },
        region: "us-east-1",
        support: { tier: "enterprise" },
      },
    });
    const beta = makeState({
      customer: "beta",
      version: "v2.5.0",
      flags: { new_billing: false, legacy_export: true, dark_mode_v2: true, beta_dashboard: true },
      config: {
        export: { delimiter: "|", batchSize: 100, includeHeader: true },
        region: "eu-west-1",
        support: { tier: "standard" },
      },
    });
    const d = diff(acme, beta);
    expect(d.versionDelta).toEqual({ a: "v2.3.1", b: "v2.5.0" });
    expect(d.flagDeltas).toEqual([
      { flag: "beta_dashboard", a: false, b: true },
      { flag: "legacy_export", a: false, b: true },
      { flag: "new_billing", a: true, b: false },
    ]);
    expect(d.configDeltas.map((c) => c.path)).toEqual([
      "export.batchSize",
      "export.delimiter",
      "export.includeHeader",
      "region",
      "support.tier",
    ]);
  });

  it("is pure: does not mutate its inputs", () => {
    const a = makeState({ customer: "a", flags: { f: true }, config: { x: { y: 1 } } });
    const b = makeState({ customer: "b", flags: { f: false }, config: { x: { y: 2 } } });
    const aCopy = structuredClone(a);
    const bCopy = structuredClone(b);
    diff(a, b);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });
});
