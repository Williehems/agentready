/**
 * Groq client. Ported from maps-lead-hunter/server/lib/ai.js, minus the memory
 * injection that project needs. Plain fetch against the OpenAI-compatible
 * endpoint, no SDK, JSON mode for structured decisions.
 *
 * openai/gpt-oss-120b on the free tier is the agent's brain for the MVP. The
 * llama-3.3 line this was first written against is no longer served, so if this
 * 404s with model_not_found, list /v1/models and pick the current flagship.
 * Text only: no paid vision model anywhere in this build.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";

/**
 * gpt-oss thinks before it answers, and those reasoning tokens are drawn from
 * the same max_tokens budget as the answer. Ask for 20 tokens and reasoning eats
 * all of them, the content comes back empty, and JSON mode rejects the call with
 * json_validate_failed rather than telling you the budget was the problem. So
 * every call gets headroom whatever the caller asked for.
 */
const MIN_TOKENS = 512;

/**
 * Low effort is measured, not assumed: on a trivial JSON reply it cut reasoning
 * from 207 characters to 33 and completion tokens from 64 to 24, same answer.
 * Deciding one click on one page does not need deliberation.
 */
const REASONING_EFFORT = "low";

/**
 * Node's fetch has no total-request timeout, so a call that stalls mid-stream
 * stalls forever. Measured: one such call held an entire audit open for over ten
 * minutes with no error anywhere. A decision this small has no business taking
 * more than a few seconds, and the caller can end a run cleanly on a failed
 * decision, so cutting it off degrades the run instead of hanging it.
 */
const TIMEOUT_MS = 45_000;

/**
 * The free tier meters tokens per minute, and an audit is a burst: ten decisions
 * about a page in under a minute. Measured on this key: a six-step run hit
 * "Limit 8000, Used 7492" and the seventh decision came back 429. That ends the
 * run for a reason that has nothing to do with the site being audited, which is
 * the one kind of wrong answer this product cannot afford.
 *
 * Groq says exactly how long to wait, so wait that long and ask again. Anything
 * past a short wait is not worth holding a browser session open for.
 *
 * Four attempts rather than two, because the waits it asks for near the window
 * roll are about a second and the spare-budget guard below is what actually stops
 * us. Measured: a docs-site run died at step 7 with 163s of run budget left,
 * having spent its one retry on a 429 that asked for 1s.
 */
const RETRY_LIMIT = 4;
const MAX_BACKOFF_MS = 20_000;

/**
 * A connection that never carried the request is worth trying again. The POST was
 * not answered, so no decision was made and nothing was metered, and the cost of
 * giving up is the entire run: measured live, one such fault at step 0 ended an
 * audit and threw away a browser session, while the same endpoint answered six
 * times out of six in 263-975ms from this machine a minute later.
 */
const TRANSPORT_RETRIES = 2;
const TRANSPORT_BACKOFF_MS = 700;

/**
 * The reason behind a bare "fetch failed", or undefined when the failure was
 * something else entirely.
 *
 * Node reports every network-layer fault as `TypeError: fetch failed` and puts
 * the actual cause one level down, so a reset connection, a DNS miss and a TLS
 * failure all read as the same twelve characters. Seen live: a run stopped with
 * nothing but "fetch failed" against an API that was up.
 */
export function transportFault(err: unknown): string | undefined {
  if (!(err instanceof TypeError) || !/fetch failed|network|socket/i.test(err.message)) {
    return undefined;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${cause.message} (${code})` : cause.message;
  }
  return err.message;
}

/** Groq's 429 body carries "Please try again in 12.239999999s". Believe it. */
function retryAfterMs(body: string, headers: Headers): number | undefined {
  const header = Number(headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const m = /try again in ([\d.]+)\s*s/i.exec(body);
  if (!m) return undefined;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What one call cost, and what the key had left when it answered.
 *
 * Recorded because the free tier, not price, is what limits this product. Reading
 * it off the response beats estimating: Groq reports the remaining balance on
 * every call, and a governor working from that number never has to model a bucket
 * it cannot see.
 */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  remainingTokens?: number;
  limitTokens?: number;
  resetMs?: number;
}

/** "547ms", "1.5s" and "2m52.8s" are all shapes Groq writes. */
export function durationMs(v: string | null): number | undefined {
  if (!v) return undefined;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  let seen = false;
  // exec in a loop rather than matchAll, whose iterator this project's default
  // compile target rejects without downlevelIteration.
  const re = /([\d.]+)\s*(ms|s|m|h)/g;
  for (let m = re.exec(v); m; m = re.exec(v)) {
    const q = Number(m[1]);
    if (!Number.isFinite(q)) continue;
    seen = true;
    total += q * unit[m[2]];
  }
  return seen ? total : undefined;
}

/** A header that is a number, or nothing. `Number(null)` is 0, which is a lie. */
function num(v: string | null): number | undefined {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The token allowance as last reported, so the next call can wait instead of
 * walking into a 429.
 *
 * Module scope. One machine runs one audit at a time in this build, and two
 * concurrent runs on one key would both undercount; the fix for that is a queue,
 * and there is nothing yet to queue. Stated rather than quietly assumed.
 *
 * Measured on this key: limit 8000, and after spending 73 tokens the reset came
 * back as 547ms. So it refills continuously at limit/60s rather than emptying and
 * clearing on a window boundary, which is why waiting a few seconds works at all.
 */
export interface Allowance {
  remaining: number;
  limit: number;
  /** When `remaining` was read, so the refill since then can be added on. */
  at: number;
}

let bucket: Allowance | undefined;

const refillPerMs = (limit: number) => limit / 60_000;

/**
 * The allowance the response headers do not mention.
 *
 * Measured on this key, and the reason run 8 died at step 3 of 14: the refusal
 * was `on tokens per day (TPD): Limit 200000, Used 199919, Requested 2394.
 * Please try again in 16m39.216s`, while the very same response's headers read
 * limit-tokens 8000 remaining-tokens 5668 and limit-requests 1000 remaining
 * 997. Every header said there was room. The bucket that was empty is named
 * nowhere but in the prose of the refusal.
 *
 * So it is read from there, and remembered, because the consequence is not a
 * pause but a day: at 200000 a day this refills near 139 tokens a minute, and
 * one decision on a docs page costs about 2400 of them. A run that walks into
 * this spends a browser session to think one thought and then stops, which is
 * why it is worth knowing before the browser is acquired rather than after.
 */
export interface DailyAllowance {
  /** Which allowance ran out, in Groq's own words: "tokens per day (TPD)". */
  bucket: string;
  limit: number;
  used: number;
  /** What the refused call was asking for, which sets how long a wait helps. */
  requested: number;
  /** How long Groq said to wait, which is the only figure that reflects refill. */
  waitMs: number;
  at: number;
}

let daily: DailyAllowance | undefined;

/**
 * The day bucket named in a 429 body, or nothing when the refusal was about a
 * minute. Only day buckets are kept: a minute is a pause the governor already
 * handles from the headers, and treating one as a day would refuse runs that
 * would have gone through seconds later.
 */
export function parseDailyRefusal(body: string, now = Date.now()): DailyAllowance | undefined {
  const m =
    /on ((?:tokens|requests) per day \((?:TPD|RPD)\)): Limit (\d+), Used (\d+), Requested (\d+)/i.exec(
      body,
    );
  if (!m) return undefined;
  // Up to the sentence end rather than the first full stop, because the duration
  // has one inside it: "16m39.216s." would otherwise be read as sixteen minutes
  // flat, and the compound shape is the one a day bucket always answers with.
  const waitMs = durationMs(/try again in (.+?)(?:\.\s|\.$|$)/i.exec(body)?.[1] ?? null);
  return {
    bucket: m[1],
    limit: Number(m[2]),
    used: Number(m[3]),
    requested: Number(m[4]),
    waitMs: waitMs ?? 0,
    at: now,
  };
}

/**
 * What is known about the day's allowance, or nothing if it has never refused us.
 *
 * Silence is not the same as room: the day bucket is invisible until it is empty,
 * so a caller must read this as "no reason to think otherwise" rather than as a
 * balance. That is the honest shape of the information Groq gives.
 */
export function dailyState(): DailyAllowance | undefined {
  return daily;
}

/** For tests, and for a process that wants to stop trusting a stale refusal. */
export function forgetDailyRefusal(): void {
  daily = undefined;
}

/**
 * How long until the day's allowance covers one more call of the usual size, or
 * 0 to go now.
 *
 * Groq's own wait is the starting point rather than arithmetic on Used, because
 * only Groq knows how its day bucket refills; the elapsed time since is
 * subtracted because a refusal ten minutes old has been refilling for ten
 * minutes. Nothing is added for a larger call than the one refused: a wait that
 * turns out short costs one 429, and a wait that is too long costs an audit
 * nobody ran.
 *
 * Takes the state rather than only reading the module one, so the arithmetic can
 * be checked without a live refusal to produce it.
 */
export function dailyHoldMs(state: DailyAllowance | undefined = daily, now = Date.now()): number {
  if (!state) return 0;
  return Math.max(0, state.waitMs - (now - state.at));
}

/**
 * How long a call of this size must wait for the allowance to cover it, or 0 to
 * go now.
 *
 * No reading means no wait: a fresh process knows nothing about the key and
 * guessing a hold would delay every first call of the day for nothing. The first
 * answer supplies the real number.
 */
export function holdMs(reserve: number, b: Allowance | undefined, now: number): number {
  if (!b) return 0;
  const rate = refillPerMs(b.limit);
  const affordable = Math.min(b.limit, b.remaining + Math.max(0, now - b.at) * rate);
  const short = reserve - affordable;
  return short > 0 ? Math.ceil(short / rate) : 0;
}

/**
 * What to set aside for one call: the prompt, plus whatever the answer may run to.
 *
 * Four characters to the token is the ordinary English ratio and it only has to be
 * close, because the true balance is read back from Groq after every call. An
 * estimate that is slightly off corrects itself on the next one. The floor matters
 * more than the ratio: reasoning tokens are drawn from the same budget, so a call
 * asking for 20 is really asking for MIN_TOKENS.
 */
export function reserveTokens(messages: ChatMessage[], maxTokens: number): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4) + Math.max(maxTokens, MIN_TOKENS);
}

/** Both a 200 and a 429 carry the allowance headers, so both are worth reading. */
function readBucket(headers: Headers): Usage {
  const limitTokens = num(headers.get("x-ratelimit-limit-tokens"));
  const remainingTokens = num(headers.get("x-ratelimit-remaining-tokens"));
  if (limitTokens !== undefined && remainingTokens !== undefined) {
    bucket = { remaining: remainingTokens, limit: limitTokens, at: Date.now() };
  }
  return {
    promptTokens: 0,
    completionTokens: 0,
    limitTokens,
    remainingTokens,
    resetMs: durationMs(headers.get("x-ratelimit-reset-tokens")),
  };
}


export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called once per answered call, so a run can record what it spent. */
  onUsage?: (u: Usage) => void;
  /** Called when the governor holds a call back, so the pause is visible. */
  onWait?: (ms: number, why: string) => void;
}

/** A refusal that is about our account, not about the caller's request. */
export class RateLimitedError extends Error {
  /**
   * `why` says which of the three refusals this was, because they call for
   * different answers and a run that reports the wrong one sends its reader after
   * the wrong fix. Measured: a run stopped after using up its retries and said the
   * 1s wait was longer than it could spare, with 163s of budget left.
   */
  constructor(readonly waitMs: number | undefined, why?: string) {
    super(why ? `Groq rate limit reached: ${why}` : "Groq rate limit reached");
    this.name = "RateLimitedError";
  }
}

export async function groqChat(
  messages: ChatMessage[],
  {
    maxTokens = 400,
    temperature = 0.1,
    json = false,
    signal,
    timeoutMs = TIMEOUT_MS,
    onUsage,
    onWait,
  }: ChatOptions = {},
): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");

  // One clock for the whole call including any backoff, so a retry can never
  // outlive the budget the caller gave us.
  const clock = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  /** Counted apart, because a network blip must not spend the rate-limit budget. */
  let rateAttempt = 1;
  let transportRetries = 0;
  const reserve = reserveTokens(messages, maxTokens);

  for (;;) {
    try {
      // Wait for the allowance rather than walking into a 429. The refusal costs
      // the same wait plus a wasted round trip, and on the free tier it is the
      // commonest way a run dies for a reason the audited site did not cause:
      // measured on this key, "Limit 8000, Used 7492" and a 429 on the seventh
      // decision of a six-step run.
      const waitMs = holdMs(reserve, bucket, Date.now());
      if (waitMs > 0) {
        const spare = timeoutMs - (Date.now() - started);
        if (waitMs + 1500 >= spare) {
          throw new RateLimitedError(
            waitMs,
            `${reserve} tokens needs ${Math.round(waitMs / 1000)}s of allowance, longer than this call can spare`,
          );
        }
        onWait?.(waitMs, `holding ${Math.round(waitMs / 1000)}s for the token allowance`);
        await sleep(waitMs);
      }

      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages,
          max_tokens: Math.max(maxTokens, MIN_TOKENS),
          temperature,
          reasoning_effort: REASONING_EFFORT,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: signal ? AbortSignal.any([signal, clock]) : clock,
      });

      if (res.status === 429) {
        const text = await res.text();
        readBucket(res.headers);
        const waitMs = retryAfterMs(text, res.headers);
        // Remembered before any decision about this call, because the fact
        // outlives the call: a day bucket that is empty now is empty for the next
        // run too, and that run should not spend a browser session finding out.
        const day = parseDailyRefusal(text);
        if (day) daily = { ...day, waitMs: waitMs ?? day.waitMs };
        const spare = timeoutMs - (Date.now() - started);
        if (daily && day) {
          // No retry and no attempt counting. The wait here is measured in
          // minutes at best, so the only useful thing left to do is say which
          // allowance ran out, in Groq's own words, and how long it wants.
          throw new RateLimitedError(
            daily.waitMs,
            `our free tier is out of ${daily.bucket}: ${daily.used} of ${daily.limit} used, and this call asked for ${daily.requested} more. It refills in about ${Math.round(daily.waitMs / 60_000)} minutes`,
          );
        }
        if (rateAttempt >= RETRY_LIMIT) {
          throw new RateLimitedError(waitMs, `it refused ${rateAttempt} attempts in a row`);
        }
        if (waitMs === undefined) throw new RateLimitedError(waitMs, "it did not say how long to wait");
        if (waitMs > MAX_BACKOFF_MS || waitMs + 2000 >= spare) {
          throw new RateLimitedError(
            waitMs,
            `the wait it asked for (${Math.round(waitMs / 1000)}s) is longer than this run can spare`,
          );
        }
        rateAttempt++;
        await sleep(waitMs + 300);
        continue;
      }

      if (!res.ok) {
        throw new Error(`Groq error ${res.status}: ${await res.text()}`);
      }
      const spend = readBucket(res.headers);
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      onUsage?.({
        ...spend,
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      });
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("Groq returned no content");
      return content.trim();
    } catch (err) {
      // An abort arrives as a bare "This operation was aborted", which tells the
      // reader nothing. Whose clock ran out is the whole message. The clock covers
      // reading the body too, so this catch has to wrap that as well as the fetch.
      if (err instanceof Error && err.name === "AbortError" && !signal?.aborted) {
        throw new Error(`Groq did not answer within ${Math.round(timeoutMs / 1000)}s`);
      }
      const fault = transportFault(err);
      if (!fault) throw err;
      const wait = TRANSPORT_BACKOFF_MS * (transportRetries + 1);
      if (transportRetries < TRANSPORT_RETRIES && wait + 1500 < timeoutMs - (Date.now() - started)) {
        transportRetries++;
        await sleep(wait);
        continue;
      }
      // Named, so the run says what went wrong instead of "fetch failed".
      throw new Error(`Groq could not be reached: ${fault}`);
    }
  }
}

/**
 * JSON-mode call that tolerates the model wrapping its object in prose or a
 * fenced block, which open models do occasionally even in JSON mode.
 */
export async function groqJson<T>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
  const raw = await groqChat(messages, { ...opts, json: true });
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    }
    throw new Error(`Groq did not return JSON: ${raw.slice(0, 200)}`);
  }
}
