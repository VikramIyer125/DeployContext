import { describe, it, expect } from "vitest";
import { parseManifest, serializeManifest, ManifestError } from "../src/registry/manifest.js";
import { TEST_MANIFEST } from "./helpers.js";

describe("parseManifest", () => {
  it("parses the demo manifest into registry entries", () => {
    const entries = parseManifest(TEST_MANIFEST);
    expect(entries.map((e) => e.customer)).toEqual(["acme", "beta"]);

    const acme = entries[0];
    expect(acme.displayName).toBe("Acme Corp");
    expect(acme.code).toMatchObject({ repo: "yourco/fake-product", refType: "tag" });
    expect(acme.code.ref.value).toBe("acme-prod-v2.3.1");
    expect(acme.code.ref.provenance).toEqual([
      {
        source: "slack",
        evidenceUrl: "https://yourco.slack.com/archives/C1/p2",
        observedAt: "2026-05-03",
        confidence: "inferred-high",
      },
    ]);
    expect(acme.versionPin.value).toBe("v2.3.1");
    expect(acme.versionPin.provenance[0].confidence).toBe("confirmed");
    expect(acme.flagContext).toEqual({
      provider: "unleash",
      context: { userId: "acme", environment: "production" },
    });
    expect(acme.config).toEqual({ repo: "yourco/fake-product", path: "customers/acme/values.yaml" });
    expect(acme.slackChannels).toEqual(["C0123ACME"]);
    expect(acme.notes).toEqual(["Runs pinned; upgrade window is quarterly, next in Sept."]);
  });

  it("defaults missing provenance to an empty list", () => {
    const entries = parseManifest(TEST_MANIFEST);
    const beta = entries[1];
    expect(beta.versionPin.provenance).toEqual([]);
    expect(beta.code.ref.provenance).toEqual([]);
  });

  it("allows null/absent config", () => {
    const yaml = `customers:
  solo:
    displayName: Solo
    code: { repo: x/y, refType: branch, ref: main }
    versionPin: v1
    flagContext: { provider: unleash, context: { userId: solo } }
`;
    const [entry] = parseManifest(yaml);
    expect(entry.config).toBeNull();
    expect(entry.notes).toEqual([]);
    expect(entry.slackChannels).toEqual([]);
  });

  it("rejects invalid YAML", () => {
    expect(() => parseManifest(":::not yaml{{")).toThrow(ManifestError);
  });

  it("rejects a manifest without customers", () => {
    expect(() => parseManifest("foo: bar")).toThrow(/top-level "customers"/);
  });

  it("rejects a bad refType", () => {
    const yaml = `customers:
  x:
    displayName: X
    code: { repo: a/b, refType: sha, ref: deadbeef }
    versionPin: v1
    flagContext: { provider: unleash, context: {} }
`;
    expect(() => parseManifest(yaml)).toThrow(/refType/);
  });

  it("rejects a missing displayName", () => {
    const yaml = `customers:
  x:
    code: { repo: a/b, refType: branch, ref: main }
    versionPin: v1
    flagContext: { provider: unleash, context: {} }
`;
    expect(() => parseManifest(yaml)).toThrow(/displayName/);
  });

  it("rejects invalid provenance confidence", () => {
    const yaml = `customers:
  x:
    displayName: X
    code: { repo: a/b, refType: branch, ref: main }
    versionPin: v1
    flagContext: { provider: unleash, context: {} }
    provenance:
      versionPin: { source: human, evidenceUrl: "", observedAt: "2026-01-01", confidence: very-sure }
`;
    expect(() => parseManifest(yaml)).toThrow(/confidence/);
  });

  it("rejects a non-unleash flag provider", () => {
    const yaml = `customers:
  x:
    displayName: X
    code: { repo: a/b, refType: branch, ref: main }
    versionPin: v1
    flagContext: { provider: launchdarkly, context: {} }
`;
    expect(() => parseManifest(yaml)).toThrow(/flagContext/);
  });
});

describe("serializeManifest", () => {
  it("round-trips: parse(serialize(parse(x))) === parse(x)", () => {
    const entries = parseManifest(TEST_MANIFEST);
    const reparsed = parseManifest(serializeManifest(entries));
    expect(reparsed).toEqual(entries);
  });

  it("emits the maintained-by header", () => {
    const out = serializeManifest(parseManifest(TEST_MANIFEST));
    expect(out.startsWith("# deployments.yaml — maintained by DeployContext")).toBe(true);
  });
});
