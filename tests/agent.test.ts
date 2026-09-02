import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { usable } from "../lib/agent";

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
