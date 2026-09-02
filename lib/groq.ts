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

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  signal?: AbortSignal;
}

export async function groqChat(
  messages: ChatMessage[],
  { maxTokens = 400, temperature = 0.1, json = false, signal }: ChatOptions = {},
): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");

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
    signal,
  });

  if (!res.ok) {
    throw new Error(`Groq error ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned no content");
  return content.trim();
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
