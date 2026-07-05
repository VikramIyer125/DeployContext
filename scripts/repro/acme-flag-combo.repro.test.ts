/**
 * Reproduction test for the seeded demo bug. Injected into a fake-product
 * checkout by scripts/verify-seeded-bug.sh — NOT part of fake-product's
 * committed suite.
 *
 * Under Acme's flag combination (new_billing=on, legacy_export=off) the
 * billing formatter requires a ledgerRef that only the legacy exporter
 * stamps. Expected: FAILS on tag acme-prod-v2.3.1, PASSES on main.
 */
import { describe, it, expect } from "vitest";
import { ExportService, type Logger } from "../src/exportService.js";
import { StaticFlagProvider } from "../src/flags.js";
import type { CustomerConfig } from "../src/config.js";
import type { ExportRecord } from "../src/types.js";

const config: CustomerConfig = {
  export: { delimiter: ",", batchSize: 500, includeHeader: false },
  region: "us-east-1",
  support: { tier: "enterprise" },
};

const nullLogger: Logger = { info: () => {}, error: () => {} };

const records: ExportRecord[] = [
  { id: "9001", customer: "acme", amountCents: 250000, currency: "USD", issuedAt: "2026-07-01" },
  { id: "9002", customer: "acme", amountCents: 99900, currency: "USD", issuedAt: "2026-07-02" },
];

describe("export under Acme's flag combination", () => {
  it("exports with new_billing=on and legacy_export=off", () => {
    const service = new ExportService(
      new StaticFlagProvider({ new_billing: true, legacy_export: false }),
      config,
      nullLogger,
    );
    const result = service.runExport("acme", records);
    expect(result.count).toBe(2);
  });
});
