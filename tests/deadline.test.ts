import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Deadline, TimeoutError, withTimeout } from "../lib/deadline";

/**
 * These guard the fix for a run that wedged for over ten minutes with no error.
 * The property that matters is the one the bug violated: a call that never
 * settles must still end.
 */

const never = <T>() => new Promise<T>(() => {});
const soon = <T>(value: T, ms: number) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("withTimeout", () => {
  it("rejects when the work never settles", async () => {
    await assert.rejects(() => withTimeout(never<string>(), 20, "the page"), TimeoutError);
  });

  it("names what ran out of time, in seconds", () => {
    // Asserted on the error rather than by waiting it out: the wording is the
    // point, and a test that burns two real seconds to read it is a bad trade.
    assert.equal(
      new TimeoutError("the screenshot", 15_000).message,
      "the screenshot did not finish within 15s",
    );
  });

  it("passes a value through untouched when it arrives in time", async () => {
    assert.equal(await withTimeout(soon("snapshot", 5), 500, "the page"), "snapshot");
  });

  it("passes the original rejection through rather than masking it as a timeout", async () => {
    await assert.rejects(
      () => withTimeout(Promise.reject(new Error("CDP socket closed")), 500, "the page"),
      /CDP socket closed/,
    );
  });

  it("does not crash the process when abandoned work rejects later", async () => {
    // The real failure mode: the loop moves on, then the call it gave up on
    // rejects into an empty stack. Unhandled, that takes the server down.
    const late = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("too late")), 30);
    });
    await assert.rejects(() => withTimeout(late, 5, "the page"), TimeoutError);
    await soon(null, 60);
  });
});

describe("Deadline", () => {
  it("is not expired while budget remains", () => {
    const clock = new Deadline(5000);
    assert.equal(clock.expired, false);
    assert.ok(clock.remainingMs > 4000);
  });

  it("expires once the budget is spent", async () => {
    const clock = new Deadline(10);
    await soon(null, 30);
    assert.equal(clock.expired, true);
    assert.equal(clock.remainingMs, 0);
  });

  it("caps a call's own timeout by what is left of the run", async () => {
    const clock = new Deadline(60);
    assert.equal(clock.cap(15_000) <= 60, true);
    await soon(null, 80);
    // Never zero: a zero timeout would read as "no limit" to most callers.
    assert.equal(clock.cap(15_000), 1);
  });

  it("leaves a call's own timeout alone when it is the shorter one", () => {
    const clock = new Deadline(240_000);
    assert.equal(clock.cap(15_000), 15_000);
  });

  it("reports how long the run has taken", async () => {
    const clock = new Deadline(5000);
    await soon(null, 1100);
    assert.equal(clock.spentSeconds, 1);
  });
});
