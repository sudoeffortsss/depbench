import { describe, expect, it } from "vitest";
import { resolveSealDate } from "./seal.js";

const NOW = new Date("2026-09-08T14:00:00Z");

describe("resolveSealDate", () => {
  it("uses an explicit date, so a failed day can be re-sealed under its own name", () => {
    expect(resolveSealDate("2026-09-01", NOW)).toBe("2026-09-01");
  });

  it("falls back to today when the variable is unset", () => {
    expect(resolveSealDate(undefined, NOW)).toBe("2026-09-08");
  });

  it("falls back to today when the variable is the empty string", () => {
    // This is the case that broke. The workflow sets TRUTHLAG_DATE from
    // github.event.inputs.date, which on a scheduled run is "" rather than unset, and
    // `??` passes "" straight through. The ledger sealed to predictions/.jsonl.
    expect(resolveSealDate("", NOW)).toBe("2026-09-08");
  });

  it("falls back when the variable is whitespace", () => {
    expect(resolveSealDate("   ", NOW)).toBe("2026-09-08");
  });

  it("refuses a malformed date rather than naming a file after it", () => {
    expect(() => resolveSealDate("yesterday", NOW)).toThrow(/must be YYYY-MM-DD/);
    expect(() => resolveSealDate("2026-9-8", NOW)).toThrow(/must be YYYY-MM-DD/);
    expect(() => resolveSealDate("2026-09-08T00:00:00Z", NOW)).toThrow(/must be YYYY-MM-DD/);
  });

  it("names the bad value in the error, so the workflow log says what happened", () => {
    expect(() => resolveSealDate("nope", NOW)).toThrow(/"nope"/);
  });
});
