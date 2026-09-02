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

  for (;;) {
    try {
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
        const waitMs = retryAfterMs(text, res.headers);
        const spare = timeoutMs - (Date.now() - started);
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
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
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
