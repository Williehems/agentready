import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { act, frontPage, personaEmail, priceOnFrontPage, usable, withOurEmail } from "../lib/agent";
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

/**
 * Which page to ask about a price when the flow never passed one, and when the run
 * has already been there and need not ask twice.
 */
describe("frontPage: the page a site puts its prices on", () => {
  it("finds the front page from anywhere inside the site", () => {
    for (const from of [
      "https://plausible.io/register",
      "https://plausible.io/docs/integrate#step-2",
      "https://plausible.io/a/b/c/",
    ]) {
      assert.deepEqual(frontPage(from), { home: "https://plausible.io/", alreadyThere: false }, from);
    }
  });

  it("knows when the run already started there, so nothing is spent", () => {
    assert.deepEqual(frontPage("https://plausible.io/"), {
      home: "https://plausible.io/",
      alreadyThere: true,
    });
    assert.equal(frontPage("https://plausible.io").alreadyThere, true);
    assert.equal(frontPage("https://plausible.io/#pricing").alreadyThere, true);
  });

  it("treats a query string as somewhere else, because that is how a landing page is addressed", () => {
    assert.equal(frontPage("https://plausible.io/?ref=hn").alreadyThere, false);
  });

  it("keeps the port and the scheme, which are part of which site this is", () => {
    assert.equal(frontPage("http://localhost:3007/checkout").home, "http://localhost:3007/");
  });

  it("says nothing rather than guessing when the URL will not parse", () => {
    assert.deepEqual(frontPage("not a url"), { alreadyThere: false });
  });
});

/**
 * Watching a front page for a price instead of glancing at one.
 *
 * The bug this pins: plausible.io renders its prices after load, and one glance a
 * fixed moment later answered true on one run and false on the next, minutes apart.
 * A false here is charged to the site as a blocker, so it has to mean we watched.
 */
describe("priceOnFrontPage: giving the page time to render its prices", () => {
  const fakePage = (reads: string[]) => {
    let n = 0;
    const page = {
      goto: async () => {},
      evaluate: async () => reads[Math.min(n++, reads.length - 1)],
      waitForTimeout: async () => {},
    };
    return { page: page as unknown as Parameters<typeof priceOnFrontPage>[0], seen: () => n };
  };

  it("answers as soon as the price appears, not on the first glance", async () => {
    const f = fakePage(["Loading...", "Simple pricing", "10k pageviews €9 /month"]);
    assert.equal(await priceOnFrontPage(f.page, "https://plausible.io/", 60, 5), true);
    assert.equal(f.seen(), 3, "kept looking until the slider rendered");
  });

  it("says no only after watching for the whole window", async () => {
    const f = fakePage(["Book a table. Call us to hear our rates."]);
    assert.equal(await priceOnFrontPage(f.page, "https://example.com/", 60, 5), false);
    assert.ok(f.seen() > 1, `looked more than once, ${f.seen()} times`);
  });

  it("says nothing at all when the page will not answer", async () => {
    for (const broken of [
      { goto: async () => Promise.reject(new Error("net::ERR_ABORTED")) },
      { evaluate: async () => Promise.reject(new Error("Execution context destroyed")) },
    ]) {
      const page = {
        goto: async () => {},
        evaluate: async () => "€9",
        waitForTimeout: async () => {},
        ...broken,
      } as unknown as Parameters<typeof priceOnFrontPage>[0];
      assert.equal(await priceOnFrontPage(page, "https://example.com/", 60, 5), undefined);
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

/** The same locator, plus the one question asked of a control that would not move. */
interface HangLocator extends FakeLocator {
  evaluate?(fn: (node: Element) => string): Promise<string>;
}

/**
 * A control the browser never finishes reaching for.
 *
 * Measured on resend.com/docs/api-reference/api-keys/create-api-key, where the docs
 * nav is painted over a link in the page body: a click asking for 8s was still
 * pending 30s later and a trial click asking for 5s was still pending at 25s, while
 * that same tab answered `evaluate` in 280ms and a second tab opened and navigated
 * in under a second. Playwright's deadline never fired, so ours has to. It happened
 * three times in one run and cost 90s of a 240s budget to say nothing.
 *
 * The page-side answer was measured with the same `elementFromPoint` call the code
 * uses, on that link, and named the nav anchor sitting on top of it. What these
 * pin is the half that runs on our side: that the clock goes off at all, and that
 * what the transcript and the model are handed is the site's defect rather than a
 * note about our patience.
 */
describe("act: an operation the browser never finishes", () => {
  const state: Perception = {
    url: "https://resend.com/docs/api-reference/api-keys/create-api-key",
    title: "Create API key",
    text: "Fetch the complete documentation index at: /docs/llms.txt",
    jsGated: false,
    hasPrice: false,
    elements: [
      { index: 1, role: "link", name: "/docs/llms.txt", ref: "e5", href: "/docs/llms.txt" },
    ],
  };

  /** A page whose every operation hangs, answering `answer` when asked why. */
  const hangingPage = (answer?: string) => {
    const locator: HangLocator = {
      first: () => locator,
      click: () => new Promise<void>(() => {}),
      fill: () => new Promise<void>(() => {}),
      selectOption: async () => [],
    };
    if (answer !== undefined) locator.evaluate = async () => answer;
    const page = {
      locator: () => locator,
      getByRole: () => locator,
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      mouse: { wheel: async () => {} },
    };
    return page as unknown as Parameters<typeof act>[0];
  };

  /** Reach act()'s own deadline without spending ten real seconds getting there. */
  const raced = async (
    page: Parameters<typeof act>[0],
    d: Parameters<typeof act>[2],
  ): Promise<string | undefined> => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const running = act(page, state, d);
      mock.timers.tick(11_000);
      return await running;
    } finally {
      mock.timers.reset();
    }
  };

  it("names what is painted over the link rather than waiting out our whole ceiling", async () => {
    const why = await raced(
      hangingPage('<a> "API Keys" is painted over it, so a click there never reaches it'),
      { action: "click", target: 1, reasoning: "Open the documentation index" },
    );
    assert.equal(
      why,
      'link "/docs/llms.txt" did not accept a click within 10s: <a> "API Keys" is painted over it, so a click there never reaches it',
    );
  });

  it("says as much when the page reports nothing on top of it", async () => {
    const why = await raced(hangingPage(""), { action: "click", target: 1, reasoning: "" });
    assert.match(why ?? "", /within 10s, and nothing is covering it, so the browser never finished/);
  });

  it("offers no explanation it does not have", async () => {
    const why = await raced(hangingPage(undefined), { action: "click", target: 1, reasoning: "" });
    assert.equal(why, 'link "/docs/llms.txt" did not accept a click within 10s');
  });

  it("bounds a type the same way, since it is the same wait", async () => {
    const why = await raced(hangingPage(""), {
      action: "type",
      target: 1,
      value: "hello",
      reasoning: "",
    });
    assert.match(why ?? "", /did not accept a type within 10s/);
  });
});


