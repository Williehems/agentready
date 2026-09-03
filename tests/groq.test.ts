import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { durationMs, holdMs, reserveTokens, transportFault, type Allowance } from "../lib/groq";

/**
 * Node's fetch throws `TypeError: fetch failed` for every network-layer fault and
 * hides the reason in `cause`. A live run died with exactly that string and
 * nothing else, against an API that was answering in under a second from the same
 * machine. These lock down that the reason gets recovered, and that an ordinary
 * HTTP or model failure is not mistaken for one.
 */
describe("transportFault", () => {
  function undiciStyle(cause: Error): TypeError {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = cause;
    return err;
  }

  it("recovers the code, which is the only part that says what to do next", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    assert.equal(transportFault(undiciStyle(cause)), "read ECONNRESET (ECONNRESET)");
  });

  it("recovers a DNS miss, which is a different problem from a reset", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.groq.com"), {
      code: "ENOTFOUND",
    });
    assert.match(transportFault(undiciStyle(cause))!, /ENOTFOUND api\.groq\.com/);
  });

  it("still reports something when there is no cause to unwrap", () => {
    assert.equal(transportFault(new TypeError("fetch failed")), "fetch failed");
  });

  it("leaves a server answer alone: retrying it would only be refused again", () => {
    assert.equal(transportFault(new Error("Groq error 400: bad request")), undefined);
    assert.equal(transportFault(new Error("Groq returned no content")), undefined);
  });

  it("does not claim an abort, which is our own clock and not the network", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    assert.equal(transportFault(abort), undefined);
  });
});

/**
 * Groq writes the time to its next refill in a unit of its own choosing, and that
 * number is the difference between pacing a run and being refused mid-audit.
 * Measured on this key: 547ms after spending 73 tokens.
 */
describe("durationMs: reading Groq's clock", () => {
  it("reads each unit it writes", () => {
    assert.equal(durationMs("547ms"), 547);
    assert.equal(durationMs("1.5s"), 1500);
    assert.equal(durationMs("7.66s"), 7660);
    assert.equal(durationMs("2m52.8s"), 172_800);
    assert.equal(durationMs("1h"), 3_600_000);
  });

  it("reports nothing rather than zero when there is nothing to read", () => {
    // Zero would read as "the allowance is ready now", which is the opposite of
    // "the header was missing", and would send a run straight into a 429.
    for (const v of [null, "", "   ", "soon", "ms"]) {
      assert.equal(durationMs(v), undefined, JSON.stringify(v));
    }
  });
});

/**
 * The governor's arithmetic, pure and away from the network.
 *
 * This is what stands between a ten-step audit and the free tier: 8000 tokens a
 * minute, refilling continuously at limit/60s, against roughly 2750 tokens a step.
 * A run that walks into a 429 dies for a reason the audited site did not cause,
 * which is the one kind of wrong answer this product cannot afford.
 */
describe("holdMs: waiting for the allowance instead of being refused", () => {
  const now = 1_700_000_000_000;
  const full: Allowance = { remaining: 8000, limit: 8000, at: now };

  /** Floating point: 800 / (8000/60000) lands a hair off 6000. */
  const about = (actual: number, expected: number) =>
    assert.ok(
      Math.abs(actual - expected) <= 1,
      `expected about ${expected}ms, got ${actual}ms`,
    );

  it("does not wait before it has been told anything", () => {
    // A fresh process knows nothing about the key. Guessing a hold would delay the
    // first call of every run for nothing, and the first answer supplies the truth.
    assert.equal(holdMs(3000, undefined, now), 0);
  });

  it("goes now when the allowance already covers the call", () => {
    assert.equal(holdMs(2750, full, now), 0);
    assert.equal(holdMs(8000, full, now), 0);
  });

  it("waits exactly long enough for the shortfall to refill", () => {
    // 800 tokens short at 8000/60s is 6s. Measured refill rate, not a guess.
    about(holdMs(1000, { remaining: 200, limit: 8000, at: now }, now), 6000);
  });

  it("counts the refill since the reading, which is most of what saves a run", () => {
    // Same 200 tokens read 3s ago is 600 now, so a 1000-token call waits 3s, not 6.
    about(holdMs(1000, { remaining: 200, limit: 8000, at: now - 3000 }, now), 3000);
  });

  it("never has to wait once a minute has passed", () => {
    assert.equal(holdMs(8000, { remaining: 0, limit: 8000, at: now - 60_000 }, now), 0);
    assert.equal(holdMs(8000, { remaining: 0, limit: 8000, at: now - 600_000 }, now), 0);
  });

  it("does not read a clock that runs backwards as a debt", () => {
    // `at` ahead of now would make the refill negative and invent a shortfall.
    assert.equal(holdMs(2750, { ...full, at: now + 5000 }, now), 0);
  });

  it("still names a wait for a call bigger than the whole allowance", () => {
    // Unaffordable at any moment, since the bucket caps at its limit. A finite
    // number keeps the decision with the caller, whose own budget refuses it; an
    // Infinity here would be a sleep that never ends.
    const wait = holdMs(9000, { remaining: 0, limit: 8000, at: now }, now);
    assert.ok(Number.isFinite(wait) && wait > 0, `expected a finite wait, got ${wait}`);
  });
});

describe("reserveTokens: what one call costs before it is made", () => {
  const msg = (content: string) => ({ role: "user" as const, content });

  it("counts every message, at four characters to the token", () => {
    assert.equal(reserveTokens([msg("x".repeat(400))], 600), 700);
    assert.equal(reserveTokens([msg("x".repeat(200)), msg("x".repeat(200))], 600), 700);
  });

  it("holds the floor a small ask is really asking for", () => {
    // Reasoning tokens come out of the same budget, so a 20-token request is a
    // MIN_TOKENS request. Reserving 20 would then overspend the allowance.
    assert.equal(reserveTokens([msg("x".repeat(400))], 20), 612);
  });
});
