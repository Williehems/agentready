import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Solari, SolariError } from "@solarisdk/browser";
import { fetchReplayUrl } from "../lib/solari";

/**
 * The replay lookup, which is the only part of the Solari client worth a unit test:
 * everything else needs a real browser slot, and this one decides what a reader is
 * told about a recording they cannot see.
 */

const SESSION = "ip-10-0-10-9:f291200d-f1f3-4f10-9fd9-4d5161e62c1c:cmtkgry:1788521179382.AFk62I9";

/** A client that exists only to fail, or only to answer, the one call under test. */
function client(behaviour: () => Promise<{ url: string }>): Solari {
  return { sessions: { getReplayUrl: behaviour } } as unknown as Solari;
}

const refusing = (err: unknown) =>
  client(() => Promise.reject(err) as Promise<{ url: string }>);

/** What the SDK throws after retrying: no status, no code, the real fault in cause. */
const envelope = (cause: unknown) =>
  new SolariError(
    `Solari GET /sessions/${SESSION}/replay-url: exhausted 2 attempts`,
    undefined,
    cause,
  );

describe("fetchReplayUrl: what the reader is told about a missing recording", () => {
  it("hands back the url when there is one", async () => {
    const found = await fetchReplayUrl(
      client(() => Promise.resolve({ url: "https://replay.example/abc" })),
      SESSION,
    );
    assert.equal(found.url, "https://replay.example/abc");
    assert.equal(found.reason, undefined);
  });

  it("treats a bare 404 as an upload still in flight", async () => {
    const found = await fetchReplayUrl(refusing(new SolariError("Not Found", 404)), SESSION);
    assert.equal(found.pending, true);
    assert.match(found.reason ?? "", /not finished uploading/);
  });

  /**
   * The same 404 arrives wrapped once the SDK has retried, and the run most likely
   * to hit it is the fastest one: ask a second after release and the recording is
   * not there yet. Read through the envelope or the best grade on the board is the
   * one told its recording is gone.
   */
  it("sees an upload still in flight through the retry envelope", async () => {
    const found = await fetchReplayUrl(
      refusing(envelope(new SolariError("Not Found", 404))),
      SESSION,
    );
    assert.equal(found.pending, true);
    assert.match(found.reason ?? "", /not finished uploading/);
  });

  it("says whose side a repeated server error is on, and keeps asking", async () => {
    const found = await fetchReplayUrl(
      refusing(envelope(new SolariError("Bad Gateway", 502))),
      SESSION,
    );
    assert.equal(found.pending, true);
    assert.match(found.reason ?? "", /answered 502 to every attempt/);
    assert.match(found.reason ?? "", /their side and not a lost recording/);
  });

  it("quotes the wire fault when there was no status at all", async () => {
    const found = await fetchReplayUrl(refusing(envelope(new TypeError("fetch failed"))), SESSION);
    assert.equal(found.pending, true);
    assert.match(found.reason ?? "", /could not be reached \(fetch failed\)/);
  });

  it("names a refusal that will not fix itself, and does not call it pending", async () => {
    const found = await fetchReplayUrl(
      refusing(new SolariError("that session is not ours", 403, undefined, "InvalidSessionId")),
      SESSION,
    );
    assert.equal(found.pending, undefined);
    assert.match(found.reason ?? "", /InvalidSessionId/);
    assert.match(found.reason ?? "", /that session is not ours/);
  });

  it("passes a plain error through in its own words", async () => {
    const found = await fetchReplayUrl(refusing(new Error("socket hang up")), SESSION);
    assert.equal(found.reason, "socket hang up");
  });

  /**
   * The bug this suite was written for. Live on run mtmvbwgn-6pofvk, under the first
   * A this product ever gave, the card read "No replay yet: undefined: Solari GET
   * /sessions/...: exhausted 2 attempts." The envelope carries neither code nor
   * status, so `${err.code ?? err.status}` printed the word at the reader.
   */
  it("never prints the word undefined at the reader", async () => {
    const causes: unknown[] = [
      envelope(new SolariError("Not Found", 404)),
      envelope(new SolariError("Service Unavailable", 503)),
      envelope(new TypeError("fetch failed")),
      envelope(undefined),
      new SolariError("no status, no code"),
      new SolariError("Not Found", 404),
      new Error("socket hang up"),
      "a string nobody wrapped",
    ];

    for (const cause of causes) {
      const { reason } = await fetchReplayUrl(refusing(cause), SESSION);
      assert.ok(reason, `every failure owes the reader a reason: ${String(cause)}`);
      assert.ok(!/undefined/.test(reason ?? ""), reason);
    }
  });
});
