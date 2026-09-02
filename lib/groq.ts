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
 */
const RETRY_LIMIT = 2;
const MAX_BACKOFF_MS = 20_000;

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
  constructor(readonly waitMs: number | undefined) {
    super(
      waitMs
        ? `Groq rate limit reached, and the wait it asked for (${Math.round(waitMs / 1000)}s) is longer than this run can spare`
        : "Groq rate limit reached",
    );
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

  for (let attempt = 1; ; attempt++) {
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
        const worthWaiting =
          attempt < RETRY_LIMIT &&
          waitMs !== undefined &&
          waitMs <= MAX_BACKOFF_MS &&
          waitMs + 2000 < spare;
        if (!worthWaiting) throw new RateLimitedError(waitMs);
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
      throw err;
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
