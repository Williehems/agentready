import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  act,
  frontPage,
  type Memory,
  personaEmail,
  priceOnFrontPage,
  recall,
  sameSite,
  taskBlock,
  usable,
  withdrawFailure,
  withOurEmail,
} from "../lib/agent";
import { ACTIONS } from "../lib/actions";
import type { Perception } from "../lib/types";

/**
 * Two failures are all it takes to charge a site with form-stall, so what counts
 * as a failure is worth being exact about. Playwright's click timeout is not the
 * last word: measured on docs.stripe.com, the click on "API keys" timed out at
 * ten seconds and the dashboard opened in a tab of its own, and the site was
 * charged for a link that works.
 */
describe("withdrawFailure: taking back a charge the evidence does not support", () => {
  it("removes the failure it names", () => {
    const failures = ['link "API keys" did not accept a click within 10s'];
    assert.equal(withdrawFailure(failures, failures[0]), true);
    assert.deepEqual(failures, []);
  });

  /** The one that would quietly clear a real finding. */
  it("removes one of two identical failures, since evidence about the second says nothing about the first", () => {
    const same = 'link "API keys" did not accept a click within 10s';
    const failures = [same, same];
    assert.equal(withdrawFailure(failures, same), true);
    assert.deepEqual(failures, [same]);
  });

  it("leaves other failures where they are", () => {
    const failures = ["a stalled", "b stalled", "c stalled"];
    withdrawFailure(failures, "b stalled");
    assert.deepEqual(failures, ["a stalled", "c stalled"]);
  });

  it("says so when there is nothing by that name to take back", () => {
    const failures = ["a stalled"];
    assert.equal(withdrawFailure(failures, "never recorded"), false);
    assert.deepEqual(failures, ["a stalled"]);
  });
});

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
      ["esc", "escape"],
      ["dismiss", "escape"],
      ["close_modal", "escape"],
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

  /**
   * The two neighbours of "escape" that were left out of that map on purpose.
   * With a target, "close" and "cancel" read as a click on a named control, and
   * an alias that can mean two things picks one of them wrong. Refusing costs a
   * retry; guessing costs whatever the wrong reading did to the page.
   */
  it("refuses \"close\" and \"cancel\", which do not mean one thing", () => {
    assert.equal(usable({ action: "close", target: 3 }), undefined);
    assert.equal(usable({ action: "cancel", target: 3, reasoning: "Shut the dialog" }), undefined);
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
  click(opts?: { timeout?: number; force?: boolean }): Promise<void>;
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
    assert.match(failure(why), /button "Start my free trial" is disabled/);
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
    assert.match(failure(why), /is disabled, so a type on it cannot land/);
    assert.deepEqual(f.asked, []);
  });

  it("still operates the working control beside it", async () => {
    const f = fake();
    const why = await act(f.page, state, { action: "click", target: 1, reasoning: "Tick it" });
    assert.equal(why, undefined);
    assert.deepEqual(f.asked, ["locator aria-ref=e7", "click"]);
  });
});

/** The failure text of an outcome, since a substitution is not one. */
const failure = (out: Awaited<ReturnType<typeof act>>): string =>
  typeof out === "string" ? out : "";

/**
 * A control that is a dropdown to a visitor and not one to the browser.
 *
 * Measured on Stripe's registration form, step 8 and step 9 of one run: the country
 * picker refused `selectOption` with "Element is not a <select> element" and then
 * refused `fill` with "Element is not an <input>, <textarea> or [contenteditable]
 * element". Two refusals is form-stall, so the run was graded with a blocker
 * pointing its owner at a form that works, and step 10 clicked the same control and
 * it opened. Nothing was wrong with the site. We reached for the native mechanism
 * and a custom widget does not answer it.
 */
describe("act: a custom widget refusing the mechanism, not the visitor", () => {
  /** A page whose fill and selectOption refuse by kind, the way Playwright does. */
  const wrongKind = (clickWorks = true) => {
    const asked: string[] = [];
    const locator: FakeLocator = {
      first: () => locator,
      click: async () => {
        asked.push("click");
        if (!clickWorks) throw new Error("locator.click: Timeout 8000ms exceeded.");
      },
      fill: async () => {
        throw new Error(
          "locator.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element",
        );
      },
      selectOption: async () => {
        throw new Error("locator.selectOption: Error: Element is not a <select> element");
      },
    };
    const page = {
      locator: () => locator,
      getByRole: () => locator,
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      mouse: { wheel: async () => {} },
    };
    return { asked, page: page as unknown as Parameters<typeof act>[0] };
  };

  const state: Perception = {
    url: "https://dashboard.stripe.com/register",
    title: "Create a Stripe account",
    text: "Country",
    jsGated: false,
    hasPrice: false,
    elements: [{ index: 1, role: "combobox", name: "Select country", ref: "e21" }],
  };

  it("clicks the widget open rather than charging the site for our mechanism", async () => {
    const f = wrongKind();
    const out = await act(f.page, state, {
      action: "select",
      target: 1,
      value: "United States",
      reasoning: "Set the country",
    });
    assert.equal(typeof out, "object", "a substitution, not a failure string");
    assert.match((out as { instead: string }).instead, /clicked open instead; nothing is chosen yet/);
    assert.deepEqual(f.asked, ["click"]);
  });

  it("says nothing was typed when a fill was the thing refused", async () => {
    const out = await act(wrongKind().page, state, {
      action: "type",
      target: 1,
      value: "United States",
      reasoning: "Type the country",
    });
    assert.match((out as { instead: string }).instead, /nothing is typed yet/);
  });

  it("reports a failure when the widget will not open either", async () => {
    const out = await act(wrongKind(false).page, state, {
      action: "select",
      target: 1,
      value: "United States",
      reasoning: "",
    });
    assert.equal(out, 'combobox "Select country" would not accept a select, and a click to open it did not land either');
  });

  it("leaves a refusal about the element's state charged, since that one is the site's", async () => {
    const locator: FakeLocator = {
      first: () => locator,
      click: async () => {},
      fill: async () => {
        throw new Error("locator.fill: Error: Element is not visible");
      },
      selectOption: async () => [],
    };
    const page = {
      locator: () => locator,
      getByRole: () => locator,
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      mouse: { wheel: async () => {} },
    } as unknown as Parameters<typeof act>[0];
    const out = await act(page, state, { action: "type", target: 1, value: "x", reasoning: "" });
    assert.equal(out, 'combobox "Select country" would not accept a type: locator.fill: Error: Element is not visible');
  });
});

/**
 * The lap.
 *
 * Measured on docs.groq.com, an integrate run of ten steps: click "API Keys",
 * type the address, click "Continue with email", click "Docs", and then those same
 * four again. Six of ten steps spent going round twice. Every one of them changed
 * the page, so nothing was inert; no two perceptions in a row matched, so the
 * grader saw no loop. Only the page state repeating can see it.
 */
describe("recall: what the model is told it has already done from here", () => {
  const docs: Perception = {
    url: "https://console.groq.com/docs/overview",
    title: "Overview - GroqDocs",
    text: "Docs API Reference GETTING STARTED Overview Quickstart Models",
    jsGated: false,
    hasPrice: false,
    elements: [
      { index: 1, role: "link", name: "API Keys", ref: "e3", href: "/keys" },
      { index: 2, role: "link", name: "API Reference", ref: "e4", href: "/docs/api" },
    ],
  };
  const login: Perception = {
    ...docs,
    url: "https://console.groq.com/keys",
    title: "API Keys - GroqCloud",
    text: "Create an account or login to access this page",
    elements: [{ index: 1, role: "textbox", name: "Email", ref: "e9" }],
  };
  const fresh = (): Memory => ({ history: [], inert: new Set(), seen: [] });

  it("says nothing at all on a page the run has not stood on", () => {
    const m = fresh();
    assert.equal(recall(m, docs), "");
  });

  it("names the turning already taken when the run comes back round", () => {
    const m = fresh();
    m.seen.push({ page: docs, moves: ['click "API Keys"'] });
    const said = recall(m, docs);
    assert.match(said, /YOU HAVE READ THIS PAGE ALREADY/);
    assert.match(said, /- click "API Keys"/);
    assert.match(said, /look somewhere else\./);
  });

  /**
   * Run 7 on docs.stripe.com, where naming the turnings was not enough. /keys was
   * read on steps 4, 6 and 8: the lap warning fired on every return, named the
   * turnings already taken, and the model answered it by picking an untaken turning
   * off the same page. Four of ten steps on one page it had already read to the end.
   * A list of moves invites another move; a list of pages does not.
   */
  it("names the pages already read, wherever the run is standing", () => {
    const m = fresh();
    m.seen.push({ page: docs, moves: ['click "API Keys"'] });
    m.seen.push({ page: login, moves: ['type "Email"'] });
    const said = recall(m, docs);
    assert.match(said, /PAGES YOU HAVE ALREADY READ IN FULL/);
    assert.match(said, /- https:\/\/console\.groq\.com\/keys/);
    // Not this one. The block below is what speaks for the page underfoot, and
    // listing it here would read as an instruction to leave a page just arrived at.
    assert.ok(!said.includes("- https://console.groq.com/docs/overview"));
  });

  it("says nothing about pages read when only the current one has been", () => {
    const m = fresh();
    m.seen.push({ page: docs, moves: ['click "API Keys"'] });
    assert.ok(!recall(m, docs).includes("ALREADY READ IN FULL"));
  });

  it("keeps each page's turnings to itself", () => {
    const m = fresh();
    m.seen.push({ page: docs, moves: ['click "API Keys"'] });
    m.seen.push({ page: login, moves: ['type "Email"'] });
    assert.ok(!recall(m, login).includes('click "API Keys"'));
    assert.match(recall(m, login), /- type "Email"/);
  });

  /**
   * The carousel, from run 6 on docs.stripe.com. Four snapshots of a home page
   * nobody had touched, and two of its sixty elements read "jenny.rosen@example.com",
   * then "$ stripe balance retrieve", then "false", then "https://example.com/success".
   * An exact key made every one of those a page never seen before, so this block
   * printed on no site with a ticking element on it.
   *
   * Built at the real width, because the width is the whole of why it works: two
   * marks of sixty is 0.94 of the page shared, and two of four is 0.33.
   */
  it("still recognises a page that changed a line of itself while nobody touched it", () => {
    const wide = (sample: string): Perception => ({
      ...docs,
      elements: [
        ...Array.from({ length: 58 }, (_, i) => ({
          index: i + 1,
          role: "link",
          name: `Section ${i + 1}`,
          ref: `e${i}`,
        })),
        { index: 59, role: "code", name: sample, ref: "e59" },
        { index: 60, role: "button", name: "Copy", ref: "e60" },
      ],
    });
    const m = fresh();
    m.seen.push({ page: wide("jenny.rosen@example.com"), moves: ['click "API Keys"'] });
    assert.match(recall(m, wide("$ stripe balance retrieve")), /- click "API Keys"/);
  });

  /**
   * The other side of the same threshold, from the same run: dashboard.stripe.com/login
   * shares 0.01 of its marks with the page that linked to it. A resemblance loose
   * enough to call that a lap would tell the model it had been everywhere.
   */
  it("does not call a page it navigated to the page it left", () => {
    const m = fresh();
    m.seen.push({ page: docs, moves: ['click "API Keys"'] });
    assert.ok(!recall(m, login).includes("READ THIS PAGE ALREADY"));
  });

  it("carries the other two blocks alongside it, since a lap is not the only thing worth knowing", () => {
    const m: Memory = {
      history: ['- click "API Keys" (ok)', '- click "Docs" (ok)'],
      inert: new Set(['click "Search"']),
      seen: [{ page: docs, moves: ['click "API Keys"'] }],
    };
    const said = recall(m, docs);
    assert.match(said, /WHAT YOU HAVE ALREADY TRIED:/);
    assert.match(said, /THESE LEFT THE PAGE EXACTLY AS IT WAS/);
    // In that order, so the most specific thing is the last thing read.
    assert.ok(said.indexOf("ALREADY TRIED") < said.indexOf("EXACTLY AS IT WAS"));
    assert.ok(said.indexOf("EXACTLY AS IT WAS") < said.indexOf("READ THIS PAGE ALREADY"));
  });

  it("shows only the last five moves but every dead end, which is the point of keeping them apart", () => {
    const m = fresh();
    m.history = Array.from({ length: 8 }, (_, i) => `- click "Step ${i + 1}" (ok)`);
    const said = recall(m, docs);
    assert.ok(!said.includes('"Step 3"'));
    assert.match(said, /"Step 4"/);
  });
});

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

  /**
   * Reach act()'s own deadline without spending ten real seconds getting there.
   *
   * Ticked more than once, with the real event loop let through in between: a
   * click that hangs and reports nothing over it is retried without the
   * hit-target check, and that retry starts its own clock only after the first
   * one has gone off. One tick would leave the second wait pending forever.
   */
  const raced = async (
    page: Parameters<typeof act>[0],
    d: Parameters<typeof act>[2],
  ): Promise<Awaited<ReturnType<typeof act>>> => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const running = act(page, state, d);
      let done = false;
      void running.then(
        () => (done = true),
        () => (done = true),
      );
      for (let n = 0; n < 6 && !done; n += 1) {
        mock.timers.tick(11_000);
        await new Promise((r) => setImmediate(r));
      }
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
    assert.match(failure(why), /within 10s, and nothing is covering it, so the browser never finished/);
  });

  it("offers no explanation it does not have", async () => {
    const why = await raced(hangingPage(undefined), { action: "click", target: 1, reasoning: "" });
    assert.equal(why, 'link "/docs/llms.txt" did not accept a click within 10s');
  });

  /*
   * The retry, and the line it must not cross.
   *
   * Measured on docs.stripe.com/api/authentication: five of nine steps died on this
   * wait, and three of them were links that had already worked once in the same
   * run. The page said nothing was on top of them. A click sent without the
   * hit-target check landed, which makes the wait ours and the link fine, so the
   * site is not charged and the transcript says the click was sent.
   */
  it("sends the click without the check when the page says nothing is over it", async () => {
    const forced: string[] = [];
    const locator: HangLocator = {
      first: () => locator,
      click: (opts) => {
        forced.push(opts?.force ? "forced" : "ordinary");
        return opts?.force ? Promise.resolve() : new Promise<void>(() => {});
      },
      fill: () => new Promise<void>(() => {}),
      selectOption: async () => [],
      evaluate: async () => "",
    };
    const page = {
      locator: () => locator,
      getByRole: () => locator,
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      mouse: { wheel: async () => {} },
    } as unknown as Parameters<typeof act>[0];

    const out = await raced(page, { action: "click", target: 1, reasoning: "" });
    assert.deepEqual(forced, ["ordinary", "forced"]);
    assert.ok(typeof out === "object" && out !== null, `expected a substitution, got ${String(out)}`);
    assert.match((out as { instead: string }).instead, /sent without asking/);
  });

  it("never sends it through whatever is painted over the control", async () => {
    const tried: string[] = [];
    const locator: HangLocator = {
      first: () => locator,
      click: (opts) => {
        tried.push(opts?.force ? "forced" : "ordinary");
        return new Promise<void>(() => {});
      },
      fill: () => new Promise<void>(() => {}),
      selectOption: async () => [],
      evaluate: async () => '<div> "Ask Assistant" is painted over it, so a click there never reaches it',
    };
    const page = {
      locator: () => locator,
      getByRole: () => locator,
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      mouse: { wheel: async () => {} },
    } as unknown as Parameters<typeof act>[0];

    const why = await raced(page, { action: "click", target: 1, reasoning: "" });
    assert.deepEqual(tried, ["ordinary"]);
    assert.match(failure(why), /is painted over it/);
  });

  it("bounds a type the same way, since it is the same wait", async () => {
    const why = await raced(hangingPage(""), {
      action: "type",
      target: 1,
      value: "hello",
      reasoning: "",
    });
    assert.match(failure(why), /did not accept a type within 10s/);
  });
});

/**
 * The one move that aims at nothing.
 *
 * Measured on resend.com/docs/api-reference/api-keys/create-api-key: the Mintlify
 * search palette opened at step 1 and the next three clicks were all intercepted
 * by `<div> "Ask AssistantUse the up and down arrow k"`, ten seconds each. The
 * palette listed no close button, so there was nothing in the element list to aim
 * at, and `back` was no help because nothing had navigated.
 */
/**
 * Whether a tab the site opened is still the site.
 *
 * This decides whether the run carries on inside that tab. Measured on
 * docs.stripe.com/api/authentication, where "API keys" opens /keys in a tab of its
 * own: staying behind had the model click the same link four times in nine steps.
 * Following anything at all would instead have walked the audit off to github.com,
 * which is not the site anyone asked about.
 */
describe("sameSite: is that tab still the site we were sent to", () => {
  const run = "https://docs.stripe.com/api/authentication";

  it("follows another page of the same host", () => {
    assert.equal(sameSite("https://docs.stripe.com/keys", run), true);
  });

  it("follows a sibling subdomain, because that is still theirs", () => {
    assert.equal(sameSite("https://dashboard.stripe.com/login?redirect=/apikeys", run), true);
  });

  it("does not follow a link out to somebody else", () => {
    assert.equal(sameSite("https://github.com/stripe/stripe-python", run), false);
  });

  it("does not follow a scheme a browser cannot audit", () => {
    assert.equal(sameSite("mailto:support@stripe.com", run), false);
    assert.equal(sameSite("whatsapp://send?phone=234", run), false);
  });

  it("does not follow a tab that has not landed anywhere yet", () => {
    assert.equal(sameSite("about:blank", run), false);
    assert.equal(sameSite("", run), false);
  });
});

describe("act: the way out of an overlay", () => {
  const state: Perception = {
    url: "https://resend.com/docs/api-reference/api-keys/create-api-key",
    title: "Create API key",
    text: "Ask AssistantUse the up and down arrow keys",
    jsGated: false,
    hasPrice: false,
    elements: [{ index: 1, role: "textbox", name: "Ask Assistant", ref: "e12" }],
  };

  /** A page that records the key it was given and every wait it was asked for. */
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
      waitForTimeout: async () => void asked.push("wait"),
      mouse: { wheel: async () => {} },
      keyboard: { press: async (key: string) => void asked.push(`key ${key}`) },
    };
    return { asked, page: page as unknown as Parameters<typeof act>[0] };
  };

  it("presses Escape and reports no failure, because pressing a key always lands", async () => {
    const f = fake();
    const why = await act(f.page, state, {
      action: "escape",
      reasoning: "The search palette is over the page",
    });
    assert.equal(why, undefined);
    assert.deepEqual(f.asked, ["key Escape", "wait"], "and waits, so the next look sees it closed");
  });

  it("needs no target, so it works on a page whose overlay lists nothing to aim at", async () => {
    const bare: Perception = { ...state, elements: [] };
    const f = fake();
    assert.equal(await act(f.page, bare, { action: "escape", reasoning: "" }), undefined);
    assert.deepEqual(f.asked, ["key Escape", "wait"]);
  });

  it("ignores a target the model sent anyway, since Escape has nothing to aim at", async () => {
    const f = fake();
    const why = await act(f.page, state, { action: "escape", target: 1, reasoning: "" });
    assert.equal(why, undefined);
    assert.equal(
      f.asked.some((a) => a.startsWith("locator") || a.startsWith("getByRole")),
      false,
      "no eight-second click at a control we were not asked to operate",
    );
  });

  it("still refuses a target that names no element, on the verbs that need one", async () => {
    const f = fake();
    assert.equal(await act(f.page, state, { action: "click", target: 9, reasoning: "" }), "no element numbered 9");
  });
});

describe("taskBlock: the task the model is handed on every step", () => {
  it("carries the goal and the test for finishing it, labelled", () => {
    const block = taskBlock(ACTIONS.integrate);
    assert.match(block, /^TASK: You are a developer evaluating this product\./);
    assert.match(block, /\n\nDONE WHEN: you have seen a code example/);
  });

  /**
   * Both halves, every step, which is the whole point of putting it here rather
   * than in the system prompt or in a first-step preamble. The model gets one
   * message and keeps nothing between calls, so a completion test stated at the
   * start of a run is a completion test it does not have when it is standing on
   * the page that satisfies it. That is measurably what happened: two runs
   * reached the page and kept clicking.
   */
  it("holds every action's own test, so no action is handed a generic one", () => {
    for (const spec of Object.values(ACTIONS)) {
      const block = taskBlock(spec);
      assert.ok(block.includes(spec.goal), `${spec.id} lost its goal`);
      assert.ok(block.includes(spec.done), `${spec.id} lost its completion test`);
    }
  });
});


