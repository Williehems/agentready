import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { beginRun, endRun, mayStart, chargeStart, budget, resetGate, stopRun, isRunning } from "../lib/runs";

/**
 * The gate in front of a spending endpoint.
 *
 * A run opens a metered browser and spends model tokens, so these are not
 * ergonomics: each of these refusals is money that would otherwise leave on a
 * stranger's request. Times are passed in rather than slept through, so the suite
 * stays instant and the clock is never the flaky part.
 */
describe("mayStart: what this instance is willing to pay for", () => {
  beforeEach(() => {
    resetGate();
  });

  it("lets the first visitor of the day through", () => {
    assert.deepEqual(mayStart("1.2.3.4"), { ok: true });
  });

  it("refuses a second run while one is in flight, and says why", () => {
    const r = beginRun("mtng1w8r-xobh91");
    const gate = mayStart("5.6.7.8");
    assert.equal(gate.ok, false);
    assert.match(gate.ok === false ? gate.why : "", /already running/);
    r.abort();
    endRun("mtng1w8r-xobh91");
    assert.deepEqual(mayStart("5.6.7.8"), { ok: true });
  });

  it("holds one visitor to a cooldown without holding up the next one", () => {
    const t = Date.parse("2026-09-04T10:00:00Z");
    chargeStart("1.1.1.1", t);
    const again = mayStart("1.1.1.1", t + 20_000);
    assert.equal(again.ok, false);
    assert.match(again.ok === false ? again.why : "", /Another in 40 seconds/);
    assert.deepEqual(mayStart("2.2.2.2", t + 20_000), { ok: true });
    assert.deepEqual(mayStart("1.1.1.1", t + 61_000), { ok: true });
  });

  /**
   * The number is ten because the free allowance is 200,000 tokens a day and a
   * ten-step run costs about 20,000. Past that the model starts refusing mid-run
   * and the letter it produces is a fact about our billing, not about the site,
   * which is the one kind of wrong answer this product must never give.
   */
  it("stops at the daily cap rather than handing out grades about our own billing", () => {
    const t = Date.parse("2026-09-04T09:00:00Z");
    for (let i = 0; i < 10; i++) chargeStart(`v${i}`, t);
    assert.deepEqual(budget(t), { used: 10, cap: 10 });
    const gate = mayStart("fresh", t);
    assert.equal(gate.ok, false);
    assert.match(gate.ok === false ? gate.why : "", /run its 10 audits for today/);
    assert.match(gate.ok === false ? gate.why : "", /Clone the repository and use your own keys/);
  });

  it("forgives the cap and the cooldowns when the date rolls over", () => {
    const t = Date.parse("2026-09-04T23:59:00Z");
    for (let i = 0; i < 10; i++) chargeStart(`v${i}`, t);
    assert.equal(mayStart("v0", t).ok, false);
    const tomorrow = Date.parse("2026-09-05T00:01:00Z");
    assert.deepEqual(mayStart("v0", tomorrow), { ok: true });
    // A minute apart, either side of midnight: yesterday's ten are not today's.
    chargeStart("v0", tomorrow);
    assert.deepEqual(budget(tomorrow), { used: 1, cap: 10 });
  });

  it("counts a visitor by the first hop, so one proxied client is one visitor", () => {
    const t = Date.parse("2026-09-04T12:00:00Z");
    const first = "203.0.113.7";
    chargeStart(first, t);
    assert.equal(mayStart(first, t + 1000).ok, false);
    assert.equal(mayStart("198.51.100.9", t + 1000).ok, true);
  });
});

describe("stopRun: a stop has to reach the run", () => {
  beforeEach(() => {
    resetGate();
  });

  it("aborts the handle the run is holding", () => {
    const runner = beginRun("mtn07gt9-t98sjn");
    assert.equal(isRunning("mtn07gt9-t98sjn"), true);
    assert.equal(runner.signal.aborted, false);
    assert.equal(stopRun("mtn07gt9-t98sjn"), true);
    assert.equal(runner.signal.aborted, true);
    endRun("mtn07gt9-t98sjn");
    assert.equal(isRunning("mtn07gt9-t98sjn"), false);
  });

  /**
   * The ordinary outcome of a stop pressed a moment after the run ended. The caller
   * needs the false: it decides whether the tab gives up on the stream itself.
   */
  it("reports false for a run that has already finished", () => {
    assert.equal(stopRun("mtmyt58r-1ju1nx"), false);
  });
});
