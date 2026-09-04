import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Allowance,
  dailyHoldMs,
  dailyState,
  durationMs,
  forgetDailyRefusal,
  holdMs,
  parseDailyRefusal,
  reserveTokens,
  transportFault,
} from "../lib/groq";

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

/**
 * The allowance that is nowhere in the headers.
 *
 * Captured from this key on 2026-09-04, verbatim, which is the only reason any of
 * this is shaped the way it is: the same response that carried this body had
 * headers reading limit-tokens 8000, remaining-tokens 5668, limit-requests 1000,
 * remaining-requests 997. Every visible bucket had room. The empty one is named
 * only in the prose.
 */
const TPD_REFUSAL =
  "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199919, Requested 2394. Please try again in 16m39.216s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing";

/** A minute refusal, for contrast: this one is a pause, not a day. */
const TPM_REFUSAL =
  "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` on tokens per minute (TPM): Limit 8000, Used 7492, Requested 2394. Please try again in 12.239999999s.";

describe("parseDailyRefusal: the bucket Groq only mentions in prose", () => {
  it("reads the numbers out of the refusal it actually sent", () => {
    const d = parseDailyRefusal(TPD_REFUSAL, 1000);
    assert.equal(d?.bucket, "tokens per day (TPD)");
    assert.equal(d?.limit, 200_000);
    assert.equal(d?.used, 199_919);
    assert.equal(d?.requested, 2394);
    assert.equal(d?.at, 1000);
  });

  it("reads the compound duration whole, not up to the first full stop", () => {
    // "16m39.216s." has a full stop inside it. Stopping at that one reads sixteen
    // minutes flat and throws away 39 seconds of the wait.
    assert.equal(parseDailyRefusal(TPD_REFUSAL)?.waitMs, 999_216);
  });

  it("says nothing about a refusal that was only about this minute", () => {
    // A minute is a pause the header governor already handles. Remembering it as a
    // day would refuse runs that would have gone through twelve seconds later.
    assert.equal(parseDailyRefusal(TPM_REFUSAL), undefined);
  });

  it("recognises the request-per-day bucket too", () => {
    const d = parseDailyRefusal(
      "on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 1m26.4s.",
    );
    assert.equal(d?.bucket, "requests per day (RPD)");
    assert.equal(d?.waitMs, 86_400);
  });

  it("is not fooled by a body that is not a rate limit at all", () => {
    assert.equal(parseDailyRefusal('{"error":{"message":"model_not_found"}}'), undefined);
  });
});

describe("dailyHoldMs: how long the day bucket stays empty", () => {
  const spent = parseDailyRefusal(TPD_REFUSAL, 10_000);
  if (!spent) throw new Error("the refusal above must parse for these to mean anything");

  it("asks for the whole wait the moment it is refused", () => {
    assert.equal(dailyHoldMs(spent, 10_000), 999_216);
  });

  it("counts the refill that happened while nobody was asking", () => {
    // A refusal ten minutes old has been refilling for ten minutes. Reading it as
    // a fresh wait would hold every run for a bucket that is already half back.
    assert.equal(dailyHoldMs(spent, 10_000 + 600_000), 399_216);
  });

  it("clears once the wait is behind it, and never goes negative", () => {
    assert.equal(dailyHoldMs(spent, 10_000 + 999_216), 0);
    assert.equal(dailyHoldMs(spent, 10_000 + 5_000_000), 0);
  });

  it("asks for nothing when Groq has never refused us", () => {
    forgetDailyRefusal();
    assert.equal(dailyState(), undefined, "silence is not a balance, but it is not a refusal either");
    assert.equal(dailyHoldMs(), 0);
  });
});

