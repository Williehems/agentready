import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act, personaEmail, usable, withOurEmail } from "../lib/agent";
import type { Perception } from "../lib/types";

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

/** A locator that records what was asked of it and never touches a browser. */
interface FakeLocator {
  first(): FakeLocator;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  selectOption(value: unknown): Promise<string[]>;
}

/**
 * Aiming at a control the page will not accept.
 *
 * The prompt tells the model not to, and sometimes it does anyway. Measured on
 * plausible.io's signup, where the submit stays disabled until a captcha
 * resolves: now that such a control is described rather than hidden, it can also
 * be targeted, and what happens then is worth pinning down.
 */
describe("act: a control that cannot be operated", () => {
  const fake = () => {
    const asked: string[] = [];
    const locator: FakeLocator = {
      first: () => locator,
      click: async () => void asked.push("click"),
      fill: async (value: string) => void asked.push(`fill ${value}`),
      selectOption: async () => (asked.push("select"), []),
    };
    const page = {
      locator: (selector: string) => (asked.push(`locator ${selector}`), locator),
      getByRole: (role: string) => (asked.push(`getByRole ${role}`), locator),
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      mouse: { wheel: async () => {} },
    };
    return { asked, page: page as unknown as Parameters<typeof act>[0] };
  };

  const state: Perception = {
    url: "https://plausible.io/register",
    title: "Plausible Analytics",
    text: "Start my free trial",
    jsGated: false,
    hasPrice: false,
    elements: [
      { index: 1, role: "checkbox", name: "I am human", ref: "e7" },
      { index: 2, role: "button", name: "Start my free trial", ref: "e9", disabled: true },
    ],
  };

  it("names the disabled control instead of waiting out the click", async () => {
    const f = fake();
    const why = await act(f.page, state, {
      action: "click",
      target: 2,
      reasoning: "Submit the form",
    });
    assert.match(why ?? "", /button "Start my free trial" is disabled/);
    assert.deepEqual(f.asked, [], "and never reaches for it, which is the eight seconds saved");
  });

  it("refuses a type into one as readily as a click", async () => {
    const f = fake();
    const why = await act(f.page, state, {
      action: "type",
      target: 2,
      value: "anything",
      reasoning: "Fill it",
    });
    assert.match(why ?? "", /is disabled, so a type on it cannot land/);
    assert.deepEqual(f.asked, []);
  });

  it("still operates the working control beside it", async () => {
    const f = fake();
    const why = await act(f.page, state, { action: "click", target: 1, reasoning: "Tick it" });
    assert.equal(why, undefined);
    assert.deepEqual(f.asked, ["locator aria-ref=e7", "click"]);
  });
});

