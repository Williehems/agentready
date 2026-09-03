import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beginRun, endRun, isRunning, stopRun } from "../lib/runs";

/**
 * The registry is what makes the stop button true rather than cosmetic: the run
 * and the stop arrive on two different requests, and if they cannot find each
 * other the cloud browser keeps running and keeps costing after the page has
 * stopped watching. So what is tested here is the meeting, and the two ways it
 * can miss.
 */

describe("beginRun: a run leaves a handle behind", () => {
  it("hands back a signal that has not been pulled yet", () => {
    const controller = beginRun("run-a");
    assert.equal(controller.signal.aborted, false);
    assert.equal(isRunning("run-a"), true);
    endRun("run-a");
  });

  it("gives each run its own handle, so one stop cannot take another run with it", () => {
    const a = beginRun("run-b");
    const b = beginRun("run-c");
    stopRun("run-b");
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, false);
    endRun("run-b");
    endRun("run-c");
  });
});

describe("stopRun: reaching the run itself", () => {
  it("aborts the signal the run is watching", () => {
    const controller = beginRun("run-d");
    assert.equal(stopRun("run-d"), true);
    assert.equal(controller.signal.aborted, true);
    endRun("run-d");
  });

  /**
   * The ordinary miss: stop pressed as the verdict was already arriving. Not an
   * error, but the page has to be told, because there is no teardown coming to
   * watch and it would sit there waiting for one.
   */
  it("says so when there is no run by that name", () => {
    assert.equal(stopRun("never-existed"), false);
  });

  it("says so once the run has finished and been forgotten", () => {
    beginRun("run-e");
    endRun("run-e");
    assert.equal(isRunning("run-e"), false);
    assert.equal(stopRun("run-e"), false);
  });

  it("is safe to press twice, since a second press is a stop that already landed", () => {
    const controller = beginRun("run-f");
    assert.equal(stopRun("run-f"), true);
    assert.equal(stopRun("run-f"), true);
    assert.equal(controller.signal.aborted, true);
    endRun("run-f");
  });
});

describe("endRun: forgetting", () => {
  it("does not abort what it forgets, because the run is already tearing itself down", () => {
    const controller = beginRun("run-g");
    endRun("run-g");
    assert.equal(controller.signal.aborted, false);
  });

  it("forgets a run that was stopped, so nothing accumulates across runs", () => {
    beginRun("run-h");
    stopRun("run-h");
    endRun("run-h");
    assert.equal(isRunning("run-h"), false);
  });
});
