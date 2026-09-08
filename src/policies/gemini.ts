/**
 * Gemini client for the model arms.
 *
 * Deliberately the synchronous `generateContent` endpoint rather than the Batch API.
 * Batch is half price and the estimator says so, but this file was written without an
 * API key available to test against, and shipping an untested request flow that only
 * runs when money is being spent is the wrong trade for $0.50. The sync path is what
 * every call here has been written to, and the saving is documented rather than taken.
 *
 * Everything that makes this a benchmark rather than a demo lives in the failure paths:
 *
 *   - A response that will not parse becomes `unparseable` and stays in the denominator.
 *     No repair pass, no fallback number. Models fail to parse constantly and rules
 *     almost never do, which is what makes harness rule 1 load-bearing here.
 *   - Spend accumulates from `usageMetadata`, the provider's own count, not from an
 *     estimate. The gate throws rather than warns.
 *   - Every raw response is stored, so an unparseable result can be read back and
 *     argued with rather than taken on trust.
 */

import type { PGlite } from "@electric-sql/pglite";
import { RateLimiter, sleep } from "../ingest/http.js";
import { BudgetGate, type ModelArm, parseVerdict } from "./llm.js";
import type { Condition } from "./prompts.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** Free-tier limits are far lower; this paces for a paid key and backs off on 429. */
const DEFAULT_INTERVAL_MS = 120;

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export type GeminiResult =
  | { ok: true; text: string; usage: GeminiUsage }
  | { ok: false; kind: "error" | "timeout" | "refused"; detail: string; usage: GeminiUsage };

export function apiKey(): string {
  const k = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!k) {
    throw new Error(
      "no GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment. Nothing was spent. " +
        "Set it and re-run; `npx tsx src/policies/estimate.ts` prints the projected cost first.",
    );
  }
  return k;
}

function priceOf(arm: ModelArm, inTok: number, outTok: number): number {
  return (inTok / 1e6) * arm.inputPerMTok + (outTok / 1e6) * arm.outputPerMTok;
}

export async function callGemini(
  arm: ModelArm,
  systemPrompt: string,
  userContent: string,
  limiter: RateLimiter,
  key: string,
  maxAttempts = 4,
): Promise<GeminiResult> {
  const zero: GeminiUsage = { inputTokens: 0, outputTokens: 0, usd: 0 };
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    generationConfig: {
      // Asking for JSON at the API level removes the most common parse failure without
      // repairing anything: the model is constrained, the output is not edited.
      responseMimeType: "application/json",
      temperature: 0,
      maxOutputTokens: 512,
      // Thinking off, and this is not a tuning preference.
      //
      // Gemini 2.5 counts reasoning tokens against maxOutputTokens. On a 4,100-token
      // package prompt the model spent its entire budget thinking and the visible answer
      // was cut off mid-number, arriving as `{ "risk": 0.` — which the parser correctly
      // refused, so the failure showed up as a wall of unparseable rows rather than as
      // an error. Measured on one call: 369 thinking tokens against 72 of answer.
      //
      // Raising the cap would work and would also make every arm's cost depend on how
      // much each model chose to deliberate, which is not a variable this benchmark is
      // trying to hold. The task is a rubric with a fixed output shape. Off.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let lastDetail = "no attempt made";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await limiter.wait();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(`${ENDPOINT}/${arm.model}:generateContent`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status >= 500) {
        limiter.penalise(1000 * 2 ** (attempt - 1));
        lastDetail = `HTTP ${res.status}`;
        await res.body?.cancel();
        continue;
      }
      const json = (await res.json()) as any;
      if (!res.ok) {
        return {
          ok: false, kind: "error", usage: zero,
          detail: `HTTP ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`,
        };
      }

      const um = json.usageMetadata ?? {};
      const inTok = Number(um.promptTokenCount ?? 0);
      // Reasoning tokens bill at the output rate and arrive in their own field. Counting
      // only `candidatesTokenCount` under-reports spend by whatever the model chose to
      // think, which on one measured call was 369 tokens against 72 of answer: a five-
      // fold understatement. Thinking is disabled above, so this is normally zero; it is
      // added anyway, because a budget gate fed an optimistic number is not a gate.
      const outTok =
        Number(um.candidatesTokenCount ?? 0) + Number(um.thoughtsTokenCount ?? 0);
      const usage: GeminiUsage = { inputTokens: inTok, outputTokens: outTok, usd: priceOf(arm, inTok, outTok) };

      const cand = json.candidates?.[0];
      // A safety block is not an empty answer: it is the model declining, and it is
      // recorded as such so it cannot be confused with an abstention it chose.
      if (!cand || cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") {
        return {
          ok: false, kind: "refused", usage,
          detail: `finishReason=${cand?.finishReason ?? "no candidate"}`,
        };
      }
      // Truncation is our fault, not the model's, and it must not be filed as the model
      // producing bad JSON. It is named here so a run that hits it is visibly a
      // configuration failure rather than a finding about parse rates.
      if (cand.finishReason === "MAX_TOKENS") {
        return {
          ok: false, kind: "error", usage,
          detail: "truncated at maxOutputTokens: the answer was cut off, not malformed",
        };
      }
      const text = (cand.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
      if (!text) {
        return { ok: false, kind: "error", usage, detail: "empty text in a 200 response" };
      }
      return { ok: true, text, usage };
    } catch (e) {
      lastDetail = String(e).slice(0, 200);
      const aborted = /abort/i.test(lastDetail);
      if (attempt >= maxAttempts) {
        return { ok: false, kind: aborted ? "timeout" : "error", usage: zero, detail: lastDetail };
      }
      await sleep(1000 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, kind: "error", usage: zero, detail: `${lastDetail} after ${maxAttempts} attempts` };
}

/** Separates the parse failure reason from the raw text it could not parse. */
const SEPARATOR = "\n---\n";

export interface ScoreRow {
  pkg_name: string;
  condition: Condition;
  score: number | null;
  abstain: boolean;
  parse_status: "ok" | "unparseable" | "error" | "timeout";
  raw_output: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/**
 * One call, turned into a row the harness can score.
 *
 * The mapping from failure to `parse_status` is the whole point: nothing here can return
 * "no row". A package that failed is a package that failed, in the denominator, named.
 */
export async function scoreOne(
  arm: ModelArm,
  spec: { key: Condition; prompt: string },
  pkgName: string,
  content: string,
  limiter: RateLimiter,
  key: string,
  gate: BudgetGate,
): Promise<ScoreRow> {
  const base = {
    pkg_name: pkgName,
    condition: spec.key,
    score: null as number | null,
    abstain: false,
    inputTokens: 0,
    outputTokens: 0,
    usd: 0,
  };

  const res = await callGemini(arm, spec.prompt, content, limiter, key);
  const usage = res.usage;
  // Recorded before anything else, so a run halted by the gate still accounts for what
  // it actually spent rather than losing the last call.
  gate.record(usage.usd);

  if (!res.ok) {
    return {
      ...base,
      parse_status: res.kind === "timeout" ? "timeout" : "error",
      raw_output: res.kind + ": " + res.detail,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usd: usage.usd,
    };
  }

  // The probe conditions do not return a risk verdict, so they are stored raw and read
  // by their own analysis rather than forced through the verdict parser.
  if (spec.key === "reidentify" || spec.key === "recall") {
    return {
      ...base,
      parse_status: "ok",
      raw_output: res.text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usd: usage.usd,
    };
  }

  const parsed = parseVerdict(res.text);
  if (parsed.status !== "ok") {
    return {
      ...base,
      parse_status: "unparseable",
      raw_output: parsed.why + SEPARATOR + res.text.slice(0, 2000),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usd: usage.usd,
    };
  }
  return {
    pkg_name: pkgName,
    condition: spec.key,
    score: parsed.verdict.abstain ? null : parsed.verdict.risk,
    abstain: parsed.verdict.abstain,
    parse_status: "ok",
    raw_output: res.text,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    usd: usage.usd,
  };
}

export function makeLimiter(intervalMs = DEFAULT_INTERVAL_MS): RateLimiter {
  return new RateLimiter(intervalMs);
}

/** Rows already written for this run, so an interrupted run resumes instead of repaying. */
export async function alreadyScored(db: PGlite, runId: number): Promise<Set<string>> {
  const r = await db.query<{ pkg_name: string; policy: string }>(
    `SELECT pkg_name, policy FROM policy_score WHERE run_id = $1`,
    [runId],
  );
  return new Set(r.rows.map((x) => x.policy + " " + x.pkg_name));
}
