import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { POST as audit } from "../app/api/audit/route";
import { POST as stop } from "../app/api/audit/stop/route";
import { GET as replay } from "../app/api/replay/route";
import { beginRun, budget, endRun, mayStart, resetGate } from "../lib/runs";

/**
 * The three HTTP surfaces, on every path that does not need a browser.
 *
 * Which is every refusal, and the refusals are the part worth pinning: a stranger
 * sending nonsense, a target that is not ours to touch, an instance with no keys,
 * and a visitor who has had their turn. Each one has to answer with a sentence and
 * the right status, because the alternative is a stack trace in a stream the page
 * is already rendering as an audit.
 *
 * Nothing here launches a browser or calls a model, so the suite stays offline and
 * keyless. The one path deliberately not covered is the successful run: it opens a
 * metered browser on the first line, and a test that costs money every time it runs
 * is a test nobody runs.
 */

const KEYS = ["SOLARI_API_KEY", "GROQ_API_KEY"] as const;

/** Fake keys, so the handler gets past its own key check and no further. */
function withKeys(): void {
  for (const k of KEYS) process.env[k] = "not-a-real-key";
}

function withoutKeys(): void {
  for (const k of KEYS) delete process.env[k];
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/audit", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const GOOD = { url: "https://example.com", action: "contact" };

describe("POST /api/audit: the refusals", () => {
  beforeEach(() => {
    resetGate();
    withoutKeys();
  });

  afterEach(() => {
    withoutKeys();
  });

  it("answers a body that is not JSON with a sentence, not a parse error", async () => {
    const res = await audit(post("/api/audit", "this is not json"));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Expected a JSON body." });
  });

  it("names the shape it wants when a field is missing", async () => {
    const res = await audit(post("/api/audit", { url: "https://example.com" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Send { url, action }." });
  });

  it("refuses an action it does not have a task for", async () => {
    const res = await audit(post("/api/audit", { ...GOOD, action: "hack" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Send { url, action }." });
  });

  /**
   * The reason travels from lib/url.ts to the visitor unchanged. A run against
   * localhost would audit whatever else is on the machine running this, so the
   * refusal is a security boundary and not a validation nicety.
   */
  it("passes on why a target was rejected, in the words that decided it", async () => {
    const res = await audit(post("/api/audit", { ...GOOD, url: "http://localhost:3000" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Private and loopback addresses are not allowed." });
  });

  it("refuses a scheme that is not http or https", async () => {
    const res = await audit(post("/api/audit", { ...GOOD, url: "file:///etc/passwd" }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Only http and https/);
  });

  /**
   * A clone with no keys should say which key, once, in a sentence. The alternative
   * we shipped before this check existed was a browser launch that failed deep in
   * the agent loop and surfaced as an audit that mysteriously produced no verdict.
   */
  it("says which key is missing rather than failing inside a run", async () => {
    const res = await audit(post("/api/audit", GOOD));
    assert.equal(res.status, 503);
    const { error } = await res.json();
    assert.match(error, /SOLARI_API_KEY or GROQ_API_KEY/);
    assert.match(error, /\.env\.local/);
  });

  /**
   * Order matters here and is the point of the test. The key check sits before the
   * gate, so a keyless instance answers 503 without spending the visitor's one run
   * a minute on a request that was never going to start a browser. Read off the
   * budget rather than by sending a second request, because a request that gets past
   * the gate opens a browser, and this suite does not touch the network.
   */
  it("checks its keys before it charges anybody a cooldown", async () => {
    const res = await audit(post("/api/audit", GOOD, { "x-forwarded-for": "203.0.113.9" }));
    assert.equal(res.status, 503);
    assert.deepEqual(budget(), { used: 0, cap: 10 });
    assert.deepEqual(mayStart("203.0.113.9"), { ok: true });
  });

  it("answers 429 with the gate's own sentence while a run is in flight", async () => {
    withKeys();
    const held = beginRun("mtng1w8r-xobh91");
    const res = await audit(post("/api/audit", GOOD));
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /An audit is already running/);
    held.abort();
    endRun("mtng1w8r-xobh91");
  });
});

describe("POST /api/audit/stop", () => {
  beforeEach(() => {
    resetGate();
  });

  it("answers a body that is not JSON with a sentence", async () => {
    const res = await stop(post("/api/audit/stop", "{"));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Expected a JSON body." });
  });

  it("names the shape it wants", async () => {
    const res = await stop(post("/api/audit/stop", { run: "mtng1w8r-xobh91" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Send { runId }." });
  });

  it("reaches the run and reports that it did", async () => {
    const runner = beginRun("mtng1w8r-xobh91");
    const res = await stop(post("/api/audit/stop", { runId: "mtng1w8r-xobh91" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stopped: true });
    assert.equal(runner.signal.aborted, true);
    endRun("mtng1w8r-xobh91");
  });

  /**
   * 200 and false, not 404. A stop pressed as the run ends is the ordinary case,
   * and the page needs the false to stop waiting rather than an error to render.
   */
  it("reports a miss as an outcome, not as an error", async () => {
    const res = await stop(post("/api/audit/stop", { runId: "mtmyt58r-1ju1nx" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stopped: false });
  });
});

describe("GET /api/replay", () => {
  afterEach(() => {
    withoutKeys();
  });

  function get(query: string): Request {
    return new Request(`http://localhost:3000/api/replay${query}`);
  }

  it("asks for a session when none was passed", async () => {
    const res = await replay(get(""));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /\?session=/);
  });

  it("refuses a session id that is not shaped like one", async () => {
    for (const bad of ["?session=short", "?session=has%20a%20space%20in%20it", `?session=${"x".repeat(301)}`]) {
      const res = await replay(get(bad));
      assert.equal(res.status, 400, bad);
    }
  });

  /**
   * A well shaped session with no key stops here rather than constructing a client
   * that would throw somewhere less legible.
   */
  it("says the key is missing before it builds a client", async () => {
    withoutKeys();
    const res = await replay(get("?session=browser-1.solari.dev:9f8e7d6c-1234-4321-abcd-0123456789ab:acct:1757000000.tok"));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "Server is missing SOLARI_API_KEY." });
  });
});
