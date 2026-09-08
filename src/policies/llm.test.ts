/**
 * The model arms are not run, but the parts that decide whether a run would be honest
 * are tested. A parser that quietly coerces bad output into a plausible number would
 * defeat the benchmark more thoroughly than any bug in the scoring.
 */
import { describe, expect, it } from "vitest";
import {
  BudgetGate, MODEL_ARMS, assertStratifiable, estimateCost, parseVerdict,
} from "./llm.js";

describe("parseVerdict accepts what it should", () => {
  it("parses a clean verdict", () => {
    const r = parseVerdict('{"risk":0.7,"reason":"handover notice","evidence_quote":"new maintainer","abstain":false}');
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.verdict.risk).toBe(0.7);
    expect(r.verdict.abstain).toBe(false);
  });

  it("unwraps a code fence without treating it as repair", () => {
    const r = parseVerdict('```json\n{"risk":0.2,"reason":"x","evidence_quote":"","abstain":false}\n```');
    expect(r.status).toBe("ok");
  });

  it("accepts an abstention with no risk value", () => {
    const r = parseVerdict('{"reason":"nothing to go on","evidence_quote":"","abstain":true}');
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.verdict.abstain).toBe(true);
    expect(Number.isNaN(r.verdict.risk)).toBe(true);
  });
});

describe("parseVerdict refuses rather than salvages", () => {
  const bad: Array<[string, string, RegExp]> = [
    ["prose instead of JSON", "I think this package is fine.", /not JSON/],
    ["an array", "[1,2,3]", /got an array/],
    ["a bare number", "0.5", /expected an object/],
    ["missing abstain", '{"risk":0.5,"reason":"x"}', /abstain missing/],
    ["risk as a string", '{"risk":"high","abstain":false}', /risk missing or not a finite number/],
    ["risk above 1", '{"risk":7,"abstain":false}', /outside \[0,1\]/],
    ["risk below 0", '{"risk":-0.2,"abstain":false}', /outside \[0,1\]/],
    ["truncated output", '{"risk":0.4,"reason":"the pack', /not JSON/],
  ];
  for (const [label, raw, why] of bad) {
    it(`rejects ${label}`, () => {
      const r = parseVerdict(raw);
      expect(r.status).toBe("unparseable");
      if (r.status !== "unparseable") return;
      expect(r.why).toMatch(why);
      // The original is kept so an unparseable result stays auditable.
      expect(r.raw).toBe(raw);
    });
  }

  it("does not clamp an out-of-range score into a plausible one", () => {
    // 7 could be clamped to 1 and would look like a confident high-risk call.
    // Clamping would hide a model that misread the scale.
    const r = parseVerdict('{"risk":7,"abstain":false}');
    expect(r.status).toBe("unparseable");
  });
});

describe("budget gate is a ceiling, not a warning", () => {
  it("throws rather than logging when the ceiling is passed", () => {
    const g = new BudgetGate(1.0);
    g.record(0.6);
    expect(g.spentUsd).toBeCloseTo(0.6);
    expect(() => g.record(0.5)).toThrow(/budget exceeded/);
  });

  it("refuses an unaffordable call before it is issued", () => {
    const g = new BudgetGate(1.0);
    g.record(0.9);
    expect(g.canAfford(0.05)).toBe(true);
    expect(g.canAfford(0.5)).toBe(false);
  });
});

describe("cost estimates", () => {
  it("prices all three arms for the real universe", () => {
    for (const arm of MODEL_ARMS) {
      const e = estimateCost(arm, 3215);
      expect(e.usdBatched).toBeGreaterThan(0);
      expect(e.usdBatched).toBeLessThan(e.usdListPrice);
      // Sanity: no arm should cost more than the project's stated $50 ceiling.
      expect(e.usdListPrice).toBeLessThan(50);
    }
  });

  it("orders the arms by price as their tiers imply", () => {
    const [flash, haiku, sonnet] = MODEL_ARMS.map((a) => estimateCost(a, 3215).usdBatched);
    expect(flash!).toBeLessThan(haiku!);
    expect(haiku!).toBeLessThan(sonnet!);
  });
});

describe("cutoff stratification", () => {
  it("every registered arm can actually be split at its cutoff", () => {
    for (const arm of MODEL_ARMS) {
      expect(() => assertStratifiable(arm)).not.toThrow();
      expect(arm.trainingCutoff).toMatch(/^\d{4}-\d{2}$/);
      expect(arm.cutoffEvidence.length).toBeGreaterThan(20);
    }
  });

  it("the case splits agree with the frozen case count", () => {
    for (const arm of MODEL_ARMS) {
      const { preCutoff, postCutoff } = arm.caseSplit;
      expect(preCutoff + postCutoff).toBe(643);
    }
  });

  it("refuses an arm whose cutoff is unpublished", () => {
    // gemini-3.1-flash-lite was registered here until 2026-09-07 and had to go: its
    // model card states no cutoff, so the strata are undefined.
    const arm = { ...MODEL_ARMS[0]!, policy: "unpublished", trainingCutoff: "unstated" };
    expect(() => assertStratifiable(arm)).toThrow(/not a YYYY-MM date/);
  });

  it("refuses an arm whose cutoff leaves a stratum too small to interpret", () => {
    const arm = {
      ...MODEL_ARMS[0]!,
      policy: "lopsided",
      caseSplit: { preCutoff: 604, postCutoff: 39 },
    };
    expect(() => assertStratifiable(arm)).toThrow(/cannot separate its own AUC/);
  });
});
