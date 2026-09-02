import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transportFault } from "../lib/groq";

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
