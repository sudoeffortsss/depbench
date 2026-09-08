/**
 * The HTTP layer every ingest goes through.
 *
 * Three behaviours here are not conveniences, they are requirements the design leans on:
 *
 *   1. A failed fetch is a result, not an absence. `fetchJson` returns a discriminated
 *      union so callers must handle failure explicitly, and the ingest records it as a
 *      row. That is what makes `no_answer` computable rather than invisible
 *      (BLUEPRINT.md section 7, rule 1).
 *
 *   2. Rate limits are measured, not guessed. FINDINGS.md F1 and F7 record the numbers:
 *      the downloads API caps bulk at 128 and starts refusing above roughly 3 req/s, and
 *      an early clean reading was the token bucket's opening allowance rather than a
 *      sustainable rate. We stay under it and back off on 429.
 *
 *   3. A silent truncation is worse than a loud failure. F7 also records the time our own
 *      download script printed success while tar was reporting a truncated stream. Every
 *      response here is either parsed successfully or reported as failed.
 */

export interface FetchOk<T> {
  ok: true;
  status: number;
  body: T;
  raw: string;
}

export interface FetchFail {
  ok: false;
  status: number | null;
  error: string;
}

export type FetchResult<T> = FetchOk<T> | FetchFail;

export interface RateLimitOptions {
  /** Minimum milliseconds between the start of one request and the next. */
  minIntervalMs: number;
  /** Attempts per URL, including the first. */
  maxAttempts?: number;
  /** Base for exponential backoff after a 429 or 5xx. */
  backoffBaseMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Serialises requests to a fixed minimum interval. Deliberately not a token bucket:
 * a bucket lets a burst through, and a burst is exactly how we exhausted npm's
 * allowance while merely measuring it (F7).
 */
export class RateLimiter {
  private nextAllowedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.minIntervalMs;
    if (waitMs > 0) await sleep(waitMs);
  }

  /** Called after a 429 so the next request starts well after the penalty. */
  penalise(ms: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + ms);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The retry, rate-limit and backoff behaviour, with the decoding left to the caller.
 *
 * `fetchJson` and `fetchBytes` differ only in what they do with a 200, and that
 * difference is not worth two copies of the 429-penalty and abort-timeout handling.
 */
async function fetchWith<T>(
  url: string,
  limiter: RateLimiter,
  opts: RateLimitOptions,
  headers: Record<string, string>,
  decode: (res: Response) => Promise<FetchResult<T>>,
): Promise<FetchResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoffBase = opts.backoffBaseMs ?? 1000;
  const timeoutMs = opts.requestTimeoutMs ?? 30_000;

  let lastStatus: number | null = null;
  let lastError = "no attempt made";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await limiter.wait();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, ...headers },
      });
      lastStatus = res.status;

      if (res.status === 429 || res.status >= 500) {
        const penalty = backoffBase * 2 ** (attempt - 1);
        limiter.penalise(penalty);
        lastError = `HTTP ${res.status}`;
        await res.body?.cancel();
        continue;
      }

      if (!res.ok) {
        // 404 and friends are terminal and meaningful: the package is gone.
        // Report rather than retry.
        const text = await res.text().catch(() => "");
        return { ok: false, status: res.status, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
      }

      return await decode(res);
    } catch (e) {
      lastError = String(e).slice(0, 200);
      if (attempt < maxAttempts) await sleep(backoffBase * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: lastStatus, error: `${lastError} after ${maxAttempts} attempts` };
}

export async function fetchJson<T>(
  url: string,
  limiter: RateLimiter,
  opts: RateLimitOptions,
  headers: Record<string, string> = {},
): Promise<FetchResult<T>> {
  return fetchWith<T>(url, limiter, opts, headers, async (res) => {
    const raw = await res.text();
    try {
      return { ok: true, status: res.status, body: JSON.parse(raw) as T, raw };
    } catch (e) {
      // A 200 whose body will not parse is a failure, not an empty success.
      return {
        ok: false,
        status: res.status,
        error: `unparseable JSON (${raw.length} bytes): ${String(e).slice(0, 120)}`,
      };
    }
  });
}

/**
 * The same contract for binary payloads. Used for package tarballs, which are the only
 * source of the README and package.json *as they stood on the scoring date*: a packument
 * carries at most the current release's readme field, and for many packages not even
 * that (minimist's is zero bytes).
 */
export async function fetchBytes(
  url: string,
  limiter: RateLimiter,
  opts: RateLimitOptions,
  headers: Record<string, string> = {},
): Promise<FetchResult<Uint8Array>> {
  return fetchWith<Uint8Array>(url, limiter, opts, headers, async (res) => {
    const buf = new Uint8Array(await res.arrayBuffer());
    // A 200 with no body is a failure dressed as a success, which is the shape of error
    // this benchmark exists to catch.
    if (buf.length === 0) {
      return { ok: false, status: res.status, error: "empty body on a 200" };
    }
    return { ok: true, status: res.status, body: buf, raw: `${buf.length} bytes` };
  });
}

/**
 * npm asks that automated clients identify themselves. Doing so is also self-interested:
 * an identifiable client can be rate-limited rather than blocked.
 */
export const USER_AGENT =
  "truthlag/0.1 (+https://github.com/sudoeffortsss/truthlag) research benchmark";

/** Measured limits, kept in one place so they are easy to find and to justify. */
export const LIMITS = {
  /** Registry took 30 sequential requests with zero failures (F1). 5 req/s is polite. */
  registryIntervalMs: 200,
  /** Downloads API refused above ~3 req/s once its allowance was spent (F1, F7). */
  downloadsIntervalMs: 400,
  /** Hard cap enforced by the API itself: 256 returns 400 (F1). */
  downloadsMaxBatch: 128,
} as const;
