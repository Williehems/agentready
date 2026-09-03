import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { personaEmail, usable, withOurEmail } from "../lib/agent";

describe("usable: reading the model's answer", () => {
  it("takes a well-formed decision as it stands", () => {
    assert.deepEqual(usable({ action: "click", target: 6, reasoning: "Send it" }), {
      action: "click",
      target: 6,
      reasoning: "Send it",
    });
  });

  /**
   * The one that cost a live run. The form was filled, the submit was on screen,
   * and the model wrote out every field it had been shown including the ones its
   * action did not use. A schema of optional strings rejects null, so a perfectly
   * good click became "the model did not return a usable action" and the run ended
   * at step 8 with a browser session thrown away.
   */
  it("reads a field the model explicitly left empty as one it did not set", () => {
    const d = usable({ action: "click", target: 8, value: null, reasoning: "Send the booking" });
    assert.equal(d?.action, "click");
    assert.equal(d?.target, 8);
    assert.equal(d?.value, undefined);
  });

  it("treats an empty string the same way, since neither is something to type", () => {
    assert.equal(usable({ action: "click", target: 3, value: "" })?.value, undefined);
  });

  it("keeps a value of \"0\", which is something to type", () => {
    assert.equal(usable({ action: "type", target: 3, value: "0" })?.value, "0");
  });

  it("maps a neighbouring verb onto the one action it can mean", () => {
    for (const [said, meant] of [
      ["submit", "click"],
      ["press", "click"],
      ["fill", "type"],
      ["fill_in", "type"],
      ["enter", "type"],
      ["choose", "select"],
      ["go back", "back"],
      ["Scroll-Down", "scroll"],
      ["finished", "done"],
      ["giveup", "give_up"],
    ] as const) {
      assert.equal(usable({ action: said, target: 1 })?.action, meant, said);
    }
  });

  it("passes our own verbs through untouched, whatever case they arrive in", () => {
    assert.equal(usable({ action: "GIVE_UP" })?.action, "give_up");
    assert.equal(usable({ action: " done " })?.action, "done");
  });

  it("defaults the reasoning rather than refusing an answer that omitted it", () => {
    assert.equal(usable({ action: "scroll" })?.reasoning, "");
  });

  it("accepts an element number sent as a string, which is how a model often writes it", () => {
    assert.equal(usable({ action: "click", target: "4" })?.target, "4");
  });

  it("refuses a verb it cannot read, rather than picking one", () => {
    assert.equal(usable({ action: "hover", target: 1 }), undefined);
    assert.equal(usable({ action: "" }), undefined);
    assert.equal(usable({ reasoning: "I am thinking about it" }), undefined);
  });

  it("refuses anything that is not an object at all", () => {
    for (const raw of [null, undefined, "click", 7, [{ action: "click" }]]) {
      assert.equal(usable(raw), undefined, JSON.stringify(raw) ?? "undefined");
    }
  });
});

describe("withOurEmail: the run owns its address", () => {
  const runId = "mtlefgqt-1vbofh";
  const ours = personaEmail(runId);

  it("gives every run its own address", () => {
    assert.notEqual(personaEmail("aaa-111"), personaEmail("bbb-222"));
    assert.match(ours, /^[^\s@]+@example\.com$/);
  });

  it("replaces whatever address the model typed", () => {
    // Both measured on live plausible.io runs: the address it defaults to, and the
    // one it invents after the site says that one is taken.
    for (const typed of ["alex.morgan.test@example.com", "alex.morgan2.test@example.com", "  x@y.co  "]) {
      const d = withOurEmail({ action: "type", target: 3, value: typed, reasoning: "" }, runId);
      assert.equal(d.value, ours, typed);
    }
  });

  it("leaves it alone when it is already ours", () => {
    const d = { action: "type" as const, target: 3, value: ours, reasoning: "" };
    assert.equal(withOurEmail(d, runId), d);
  });

  it("touches nothing that is not an email being typed", () => {
    const untouched = [
      { action: "type" as const, target: 1, value: "Alex Morgan", reasoning: "" },
      { action: "type" as const, target: 2, value: "+1 415 555 0132", reasoning: "" },
      { action: "type" as const, target: 4, value: "2026-09-10", reasoning: "" },
      { action: "select" as const, target: 5, value: "someone@example.com", reasoning: "" },
      { action: "click" as const, target: 6, reasoning: "" },
    ];
    for (const d of untouched) {
      assert.equal(withOurEmail(d, runId), d, JSON.stringify(d));
    }
  });
});
