/**
 * AUC is the headline. If it is wrong, everything downstream is wrong and nothing
 * complains, so it is tested against hand-computable cases rather than trusted.
 */
import { describe, expect, it } from "vitest";
import { auc, computeMetrics, type ScoredPackage } from "./metrics.js";

const row = (p: Partial<ScoredPackage> & { pkg_name: string }): ScoredPackage => ({
  score: 0.5, abstain: false, parse_status: "ok", is_case: false,
  releases_last_90d: 1, downloads_prior_month: 1000, ...p,
});

describe("auc", () => {
  it("is 1 when every case outranks every control", () => {
    expect(auc([0.9, 0.8, 0.7], [0.3, 0.2, 0.1])).toBe(1);
  });

  it("is 0 when the ordering is exactly inverted", () => {
    expect(auc([0.1, 0.2], [0.8, 0.9])).toBe(0);
  });

  it("is 0.5 when every score is tied", () => {
    expect(auc([0.5, 0.5, 0.5], [0.5, 0.5])).toBe(0.5);
  });

  it("counts a case/control tie as half a point", () => {
    // one case at 0.5, one control at 0.5 -> a single comparison, tied -> 0.5
    expect(auc([0.5], [0.5])).toBe(0.5);
  });

  it("matches a hand-computed mixed case", () => {
    // cases 0.4, 0.6 ; controls 0.3, 0.5, 0.7
    // comparisons: .4>.3 win, .4<.5 loss, .4<.7 loss, .6>.3 win, .6>.5 win, .6<.7 loss
    // 3 wins of 6 -> 0.5
    expect(auc([0.4, 0.6], [0.3, 0.5, 0.7])).toBeCloseTo(0.5, 10);
  });
});

describe("rule 1: unanswerable rows stay in the denominator", () => {
  it("counts failures in coverage rather than dropping them", () => {
    const rows = [
      row({ pkg_name: "a", is_case: true, score: 0.9 }),
      row({ pkg_name: "b", score: 0.1 }),
      row({ pkg_name: "c", score: null, parse_status: "error" }),
      row({ pkg_name: "d", score: null, parse_status: "unparseable" }),
    ];
    const m = computeMetrics("p", rows);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.coverage.total).toBe(4);
    expect(m.coverage.scored).toBe(2);
    expect(m.coverage.noAnswer).toBe(2);
    expect(m.coverage.noAnswerRate).toBe(0.5);
  });
});

describe("rule 2: abstention is separate from being wrong", () => {
  it("reports abstentions apart from failures, and whether they were well placed", () => {
    const rows = [
      row({ pkg_name: "a", is_case: true, score: 0.9 }),
      row({ pkg_name: "b", score: 0.1 }),
      row({ pkg_name: "c", is_case: true, score: null, abstain: true }),
      row({ pkg_name: "d", score: null, abstain: true }),
    ];
    const m = computeMetrics("p", rows);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.coverage.abstained).toBe(2);
    expect(m.coverage.noAnswer).toBe(0);
    // half the declined packages were cases
    expect(m.guardrails.abstainHitRate).toBe(0.5);
  });
});

describe("rule 3: the headline refuses rather than mislead", () => {
  it("refuses when nothing could be scored", () => {
    const rows = [
      row({ pkg_name: "a", score: null, parse_status: "error" }),
      row({ pkg_name: "b", score: null, abstain: true }),
    ];
    const m = computeMetrics("p", rows);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.reason).toMatch(/no package received a score/);
  });

  it("refuses when abstentions removed one whole class", () => {
    const rows = [
      row({ pkg_name: "a", is_case: true, score: null, abstain: true }),
      row({ pkg_name: "b", score: 0.2 }),
      row({ pkg_name: "c", score: 0.3 }),
    ];
    const m = computeMetrics("p", rows);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.reason).toMatch(/needs both classes/);
  });

  it("never returns an auc without coverage beside it", () => {
    const rows = [
      row({ pkg_name: "a", is_case: true, score: 0.9 }),
      row({ pkg_name: "b", score: 0.1 }),
    ];
    const m = computeMetrics("p", rows);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    // structural: the success type carries coverage, so there is no way to have one
    // without the other
    expect(m.coverage).toBeDefined();
    expect(m.coverage.scoredFraction).toBe(1);
  });
});

describe("guardrails", () => {
  it("catches a policy that flags every active package", () => {
    const rows: ScoredPackage[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(row({ pkg_name: `case${i}`, is_case: true, score: 0.9 }));
    }
    for (let i = 0; i < 90; i++) {
      rows.push(row({ pkg_name: `ctl${i}`, score: 0.9, releases_last_90d: 5 }));
    }
    const m = computeMetrics("flag-everything", rows);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.auc).toBe(0.5);                                  // no discrimination
    expect(m.guardrails.activeControlFalseFlagRate).toBeGreaterThan(0.8);
  });
});
