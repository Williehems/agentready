import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capped,
  fingerprint,
  looksCoded,
  marks,
  modalIsOpen,
  parseAriaSnapshot,
  prose,
  renderState,
  resembles,
} from "../lib/perceive";
import type { Perception } from "../lib/types";

/**
 * The two fixtures below are verbatim output from
 * `page.ariaSnapshot({ mode: "ai" })` on patchright-core 1.59.3, captured
 * through a live Solari session. They are the contract: if the SDK changes the
 * outline format, these fail and the perception layer gets fixed before a run
 * silently starts reporting that every site is a blank wall.
 */

const EXAMPLE_COM = `- generic [ref=e2]:
  - heading "Example Domain" [level=1] [ref=e3]
  - paragraph [ref=e4]: This domain is for use in documentation examples without needing permission. Avoid use in operations.
  - paragraph [ref=e5]:
    - link "Learn more" [ref=e6] [cursor=pointer]:
      - /url: https://iana.org/domains/example`;

const HN_LOGIN = `- generic [ref=f5e1]:
  - text: Login
  - generic [ref=f5e2]:
    - table [ref=f5e3]:
      - rowgroup [ref=f5e4]:
        - row [ref=f5e5]:
          - cell "username:" [ref=f5e6]
          - cell [ref=f5e7]:
            - textbox [active] [ref=f5e8]
        - row [ref=f5e9]:
          - cell "password:" [ref=f5e10]
          - cell [ref=f5e11]:
            - textbox [ref=f5e12]
    - button "login" [ref=f5e13]
  - link "Forgot your password?" [ref=f5e14] [cursor=pointer]:
    - /url: forgot
  - text: Create Account
  - generic [ref=f5e15]:
    - table [ref=f5e16]:
      - rowgroup [ref=f5e17]:
        - row [ref=f5e18]:
          - cell "username:" [ref=f5e19]
          - cell [ref=f5e20]:
            - textbox [ref=f5e21]
        - row [ref=f5e22]:
          - cell "password:" [ref=f5e23]
          - cell [ref=f5e24]:
            - textbox [ref=f5e25]
    - button "create account" [ref=f5e26]`;

/**
 * The step-2 panel of a real booking modal, verbatim from the same SDK against
 * escape-house-spa.netlify.app. Note what the browser does and does not hand us:
 * the combobox carries a ref, and not one of its seventeen options does. They are
 * not nodes on the page, so pressing one can only ever time out.
 */
const BOOKING_STEP = `- dialog "Book a session" [ref=e315]:
  - generic [ref=e325]:
    - generic [ref=e328]:
      - generic [ref=e329]:
        - generic [ref=e330]: Preferred Date
        - textbox "Preferred Date" [ref=e331]
      - generic [ref=e332]:
        - generic [ref=e333]: Preferred Time
        - combobox "Preferred Time" [ref=e335]:
          - option "Any time" [selected]
          - option "10:00 AM"
          - option "11:00 AM"
          - option "12:00 PM"
    - generic [ref=e337]:
      - button "Back" [ref=e338] [cursor=pointer]
      - button "Continue" [ref=e341] [cursor=pointer]`;

describe("parseAriaSnapshot: a real minimal page", () => {
  const els = parseAriaSnapshot(EXAMPLE_COM);

  it("keeps only what a visitor can operate", () => {
    assert.equal(els.length, 1);
    assert.equal(els[0].role, "link");
    assert.equal(els[0].name, "Learn more");
  });

  it("carries the snapshot handle, which is how the actuator hits the right node", () => {
    assert.equal(els[0].ref, "e6");
  });

  it("attaches the href from the nested /url child", () => {
    assert.equal(els[0].href, "https://iana.org/domains/example");
  });

  it("numbers elements from one, contiguously", () => {
    assert.deepEqual(
      els.map((e) => e.index),
      [1],
    );
  });
});

describe("parseAriaSnapshot: a real form page", () => {
  const els = parseAriaSnapshot(HN_LOGIN);

  it("finds every control, including the four inputs with no accessible name", () => {
    assert.deepEqual(
      els.map((e) => `${e.role} ${e.name}`),
      [
        "textbox username:",
        "textbox password:",
        "button login",
        "link Forgot your password?",
        "textbox username:",
        "textbox password:",
        "button create account",
      ],
    );
  });

  it("keeps both forms' fields rather than collapsing them by label", () => {
    const boxes = els.filter((e) => e.role === "textbox");
    assert.equal(boxes.length, 4, "two forms, two fields each");
    assert.equal(new Set(boxes.map((b) => b.ref)).size, 4, "and four distinct handles");
  });

  it("does not mistake a quoted name ending in a colon for a text tail", () => {
    assert.equal(els[0].name, "username:");
  });

  it("keeps a relative href verbatim, so the grader sees what the page really said", () => {
    assert.equal(els.find((e) => e.role === "link")!.href, "forgot");
  });

  it("does not leak that href onto the sibling that follows it", () => {
    assert.ok(els.slice(4).every((e) => e.href === undefined));
  });
});

describe("parseAriaSnapshot: the awkward cases", () => {
  it("returns nothing for an empty or unparseable snapshot, without throwing", () => {
    assert.deepEqual(parseAriaSnapshot(""), []);
    assert.deepEqual(parseAriaSnapshot("not an outline at all\n\n{}"), []);
  });

  it("keeps a disabled control, marked, rather than reporting a page emptier than it is", () => {
    const els = parseAriaSnapshot(
      `- button "Buy now" [disabled] [ref=e1]\n- button "Contact sales" [ref=e2]`,
    );
    assert.deepEqual(
      els.map((e) => e.name),
      ["Buy now", "Contact sales"],
    );
    assert.equal(els[0].disabled, true, "and says which one cannot be pressed");
    assert.equal(els[1].disabled, undefined, "while a working control carries no mark");
    assert.equal(els[0].ref, "e1", "the snapshot hands over a handle for it either way");
  });

  it("unescapes a quoted name and keeps an embedded colon", () => {
    const els = parseAriaSnapshot(`- button "Say \\"hi\\": now" [ref=e1]`);
    assert.equal(els[0].name, 'Say "hi": now');
  });

  it("collapses a link repeated in the header and the footer", () => {
    const twice = `- link "Pricing" [ref=e1]:\n  - /url: /pricing\n- link "Pricing" [ref=e2]:\n  - /url: /pricing`;
    assert.equal(parseAriaSnapshot(twice).length, 1);
  });

  it("keeps two links that share a label but not a destination", () => {
    const both = `- link "Sign up" [ref=e1]:\n  - /url: /signup\n- link "Sign up" [ref=e2]:\n  - /url: https://wa.me/2348012345678`;
    const els = parseAriaSnapshot(both);
    assert.equal(els.length, 2);
    assert.ok(els.some((e) => e.href!.startsWith("https://wa.me/")), "the dead end must survive");
  });

  it("stops at sixty elements so one prompt can still hold the state", () => {
    const many = Array.from({ length: 90 }, (_, i) => `- button "Act ${i}" [ref=e${i}]`).join("\n");
    const els = parseAriaSnapshot(many);
    assert.equal(els.length, 60);
    assert.equal(els[59].index, 60);
  });
});

/**
 * The plausible.io signup case. Its submit button is visible, 416x42, and carries
 * the disabled attribute until a captcha resolves; the snapshot listed it and we
 * discarded it, so the agent reported no submit button on a page that has one.
 */
describe("parseAriaSnapshot: controls that cannot be operated", () => {
  it("treats aria-disabled the same as the attribute, because the snapshot does", () => {
    const els = parseAriaSnapshot(
      `- button "Attribute" [disabled] [ref=e1]\n- button "Aria" [disabled] [ref=e2]`,
    );
    assert.deepEqual(
      els.map((e) => [e.name, e.disabled]),
      [
        ["Attribute", true],
        ["Aria", true],
      ],
    );
  });

  it("never gives a dead control a slot a working one wanted", () => {
    const dead = Array.from({ length: 40 }, (_, i) => `- button "Dead ${i}" [disabled] [ref=d${i}]`);
    const live = Array.from({ length: 60 }, (_, i) => `- button "Live ${i}" [ref=e${i}]`);
    const els = parseAriaSnapshot([...dead, ...live].join("\n"));
    assert.equal(els.length, 60);
    assert.ok(
      els.every((e) => !e.disabled),
      "a page already full of working controls has no room to spare",
    );
  });

  it("describes a handful when there is room, and not forty", () => {
    const many = Array.from({ length: 40 }, (_, i) => `- button "Dead ${i}" [disabled] [ref=d${i}]`);
    const els = parseAriaSnapshot(many.join("\n"));
    assert.equal(els.length, 8);
    assert.equal(els[0].name, "Dead 0", "kept in the order the page has them");
  });

  it("lets a dead control and a working one of the same name both through", () => {
    const both = `- link "Next" [disabled] [ref=e1]:\n  - /url: /next\n- link "Next" [ref=e2]:\n  - /url: /next`;
    const els = parseAriaSnapshot(both);
    assert.equal(els.length, 2, "the dead one must not swallow the one that works");
    assert.equal(els.filter((e) => !e.disabled).length, 1);
  });
});

/** `- button "Thing 0" [ref=th0]` and so on, indented to sit under a container. */
const many = (role: string, label: string, n: number, indent: number) =>
  Array.from(
    { length: n },
    (_, i) => `${" ".repeat(indent)}- ${role} "${label} ${i}" [ref=${label.slice(0, 2)}${i}]`,
  ).join("\n");

/**
 * The docs.stripe.com/keys shape: furniture first, body last, sidebar outside the
 * article and a strip of page apparatus inside it.
 */
const DOCS = [
  `- banner [ref=b0]:`,
  `  - link "Skip to content" [ref=b1]`,
  `  - button "Search /" [ref=b2]`,
  `  - tablist [ref=b3]:`,
  many("tab", "Product", 6, 4),
  `- generic [ref=g0]:`,
  `  - list [ref=g1]:`,
  many("link", "Sidebar", 30, 4),
  `  - article [ref=a0]:`,
  `    - toolbar "Actions" [ref=a1]:`,
  many("button", "Apparatus", 4, 6),
  many("link", "Content", 50, 4),
].join("\n");

/**
 * The page's own furniture against the thing the furniture points at.
 *
 * Measured on the real docs.stripe.com/keys snapshot, which is where every number
 * here comes from: 1145 nodes, 184 controls, an `article` holding 97 of them, no
 * `main`, no `banner`, and a 32-entry sidebar sitting outside the article as plain
 * list items under `generic`. The furniture comes first in document order, so the
 * sixty slots went 57 to the furniture and 3 to the article. The agent then spent
 * four of that run's ten steps going back to a page whose body it had barely seen.
 *
 * The fixture keeps that shape and inflates the counts past the budget, because a
 * page that fits in sixty slots is a page where none of this does anything.
 */
describe("parseAriaSnapshot: furniture and content", () => {
  const els = parseAriaSnapshot(DOCS);
  const named = (prefix: string) => els.filter((e) => e.name.startsWith(prefix));

  it("spends the budget on the body and holds the furniture to eighteen", () => {
    assert.equal(els.length, 60);
    assert.equal(named("Content").length, 42);
    assert.equal(els.length - named("Content").length, 18);
  });

  it("still shows the furniture first, so the page still reads like itself", () => {
    // Document order is kept. Only the amount changes, and the body starts as soon
    // as the furniture has had its eighteen.
    assert.equal(named("Content")[0].index, 19);
    assert.equal(els[0].name, "Skip to content");
  });

  it("counts a toolbar inside the article as furniture, because that is what it is", () => {
    // Stripe's `toolbar "Actions"` holds "Ask about this page", "Copy for LLM",
    // "View as Markdown" and "Install tools", four slots of apparatus in the middle
    // of the content. Read as content they would come before the article's own
    // links and take the first four of its slots.
    assert.equal(named("Apparatus").length, 0);
    assert.equal(named("Content").length, 42, "and the body keeps the whole 42");
  });

  it("leaves a page whose body fits alone", () => {
    // plausible.io/register, measured: 29 nodes, 7 controls, all inside `main`.
    // Nothing is competing for anything, so nothing should be trimmed.
    const page = [`- main [ref=m0]:`, many("button", "Field", 7, 2)].join("\n");
    assert.equal(parseAriaSnapshot(page).length, 7);
  });

  it("trims real furniture even on a page that never says where its content is", () => {
    // No `main` and no `article`, so the anchor rule has nothing to work with and
    // only the landmarks themselves are furniture. That is the honest reading of a
    // page that did not say: everything outside the nav is its content.
    const page = [`- navigation [ref=n0]:`, many("link", "Menu", 30, 2), many("button", "Body", 40, 0)].join(
      "\n",
    );
    const out = parseAriaSnapshot(page);
    assert.equal(out.filter((e) => e.name.startsWith("Body")).length, 40);
    assert.equal(out.filter((e) => e.name.startsWith("Menu")).length, 20);
  });

  it("hands the reserved slots back when the body turns out not to want them", () => {
    // Fifty repeats of one link collapse to one element, so the room reserved for
    // the body goes unspent. Leaving it empty would describe less of the page than
    // the budget allows and buy nothing for it.
    const page = [
      `- navigation [ref=n0]:`,
      many("link", "Menu", 40, 2),
      `- article [ref=a0]:`,
      Array.from({ length: 50 }, (_, i) => `  - link "Read more" [ref=r${i}]`).join("\n"),
    ].join("\n");
    const out = parseAriaSnapshot(page);
    assert.equal(out.filter((e) => e.name === "Read more").length, 1);
    assert.equal(out.filter((e) => e.name.startsWith("Menu")).length, 40);
  });

  it("treats everything in an open modal as content, furniture rule and all", () => {
    // Behind an open modal the page has already been narrowed to the modal, and a
    // long form inside one sits outside the page's `main`. Classifying it against
    // the whole page would hold most of that form back as furniture and leave the
    // agent unable to fill in the thing it is trapped behind.
    const page = [
      `- main [ref=m0]:`,
      many("link", "Article", 50, 2),
      `- dialog "Checkout" [ref=d0]:`,
      many("textbox", "Field", 25, 2),
    ].join("\n");
    const out = parseAriaSnapshot(page, true);
    assert.equal(out.length, 25);
    assert.equal(out.filter((e) => e.name.startsWith("Field")).length, 25);
  });
});

describe("parseAriaSnapshot: dropdowns", () => {
  const els = parseAriaSnapshot(BOOKING_STEP);

  it("offers the control and not its options", () => {
    assert.deepEqual(
      els.map((e) => `${e.role} ${e.name}`),
      [
        "textbox Preferred Date",
        "combobox Preferred Time",
        "button Back",
        "button Continue",
      ],
    );
  });

  it("folds the choices onto the control, in the order the page listed them", () => {
    const box = els.find((e) => e.role === "combobox")!;
    assert.deepEqual(box.options, ["Any time", "10:00 AM", "11:00 AM", "12:00 PM"]);
    assert.equal(box.ref, "e335", "and keeps the one handle that can be operated");
  });

  it("leaves other elements without an options list", () => {
    assert.ok(els.filter((e) => e.role !== "combobox").every((e) => e.options === undefined));
  });

  it("keeps a listbox's options with the listbox", () => {
    const els = parseAriaSnapshot(
      `- listbox "Size" [ref=e1]:\n  - option "Small"\n  - option "Large"`,
    );
    assert.equal(els.length, 1);
    assert.deepEqual(els[0].options, ["Small", "Large"]);
  });

  it("reaches past an optgroup to find the control", () => {
    const els = parseAriaSnapshot(
      `- combobox "Country" [ref=e1]:\n  - group "Africa":\n    - option "Nigeria"\n    - option "Ghana"`,
    );
    assert.deepEqual(els[0].options, ["Nigeria", "Ghana"]);
  });

  it("still offers an option that belongs to no dropdown, since those are real nodes", () => {
    const els = parseAriaSnapshot(`- option "Standard plan" [ref=e1]\n- option "Pro plan" [ref=e2]`);
    assert.deepEqual(
      els.map((e) => e.name),
      ["Standard plan", "Pro plan"],
    );
  });

  it("shows at most twelve choices, so a country list cannot eat the prompt", () => {
    const many = Array.from({ length: 40 }, (_, i) => `  - option "Item ${i}"`).join("\n");
    const els = parseAriaSnapshot(`- combobox "Pick" [ref=e1]:\n${many}`);
    assert.equal(els[0].options!.length, 12);
    assert.equal(els[0].options![0], "Item 0");
  });
});

describe("parseAriaSnapshot: what a control already holds", () => {
  /**
   * Step 3 of the same live booking modal with two fields typed into, verbatim
   * from `ariaSnapshot({ mode: "ai" })`, de-indented to sit at the root.
   *
   * This is the shape that cost a run. A field with a placeholder does not print
   * its contents inline: the placeholder and the value arrive as indented child
   * lines, and a parser that reads only the inline tail reports every one of
   * these as empty. The model, shown an empty box it had just filled, filled it
   * again on four consecutive steps and earned a loop blocker for it.
   */
  const FILLED_FORM = `- generic [ref=e371]:
  - generic [ref=e372]:
    - generic [ref=e373]: Your Name *
    - textbox "Your Name" [ref=e374]:
      - /placeholder: Full name
      - text: Alex Morgan
  - generic [ref=e375]:
    - generic [ref=e376]: Phone Number
    - textbox "Phone Number" [active] [ref=e377]:
      - /placeholder: +234 800 000 0000
      - text: +1 415 555 0132
- generic [ref=e378]:
  - generic [ref=e379]: Special Requests (optional)
  - textbox "Special Requests (optional)" [ref=e380]:
    - /placeholder: Any allergies, preferences or special requests...
- button "Send booking via WhatsApp" [ref=e381] [cursor=pointer]:
  - generic [ref=e382]:
    - img [ref=e383]
    - text: Send Booking via WhatsApp`;

  const els = parseAriaSnapshot(FILLED_FORM);
  const byName = (name: string) => els.find((e) => e.name === name)!;

  it("reads a value that arrives as a child line, under its placeholder", () => {
    assert.equal(byName("Your Name").value, "Alex Morgan");
    assert.equal(byName("Phone Number").value, "+1 415 555 0132");
  });

  it("leaves an untouched field empty rather than reporting its placeholder", () => {
    assert.equal(byName("Special Requests (optional)").value, undefined);
  });

  it("reads a value that arrives inline, which is what a field with no placeholder does", () => {
    const els = parseAriaSnapshot(`- textbox "Preferred Date" [active] [ref=e331]: 2026-09-07`);
    assert.equal(els[0].value, "2026-09-07");
    assert.equal(els[0].name, "Preferred Date", "and the name is still the name");
  });

  it("does not let one field's contents become the next field's name", () => {
    assert.deepEqual(
      els.map((e) => e.name),
      ["Your Name", "Phone Number", "Special Requests (optional)", "Send booking via WhatsApp"],
    );
  });

  it("keeps a button's own text off it, since a button holds nothing", () => {
    assert.equal(byName("Send booking via WhatsApp").value, undefined);
  });

  it("takes a nameless field's tail as its contents and its name from the label above", () => {
    const els = parseAriaSnapshot(`- text: Coupon code\n- textbox [ref=e9]: SPA10`);
    assert.equal(els[0].name, "Coupon code");
    assert.equal(els[0].value, "SPA10");
  });

  it("unquotes the value Playwright quotes on a number field", () => {
    assert.equal(parseAriaSnapshot(`- spinbutton "Guests" [ref=e7]: "3"`)[0].value, "3");
  });

  it("reports the chosen option as the dropdown's value", () => {
    const els = parseAriaSnapshot(
      `- combobox "Preferred Time" [ref=e335]:\n  - option "Any time"\n  - option "10:00 AM" [selected]`,
    );
    assert.equal(els[0].value, "10:00 AM");
    assert.deepEqual(els[0].options, ["Any time", "10:00 AM"], "and every choice is still offered");
  });

  it("reports an untouched dropdown as holding whatever it defaults to", () => {
    assert.equal(parseAriaSnapshot(BOOKING_STEP).find((e) => e.role === "combobox")!.value, "Any time");
  });

  it("reports a ticked box as checked and an unticked one as holding nothing", () => {
    const els = parseAriaSnapshot(`- checkbox "Terms" [checked] [ref=e1]\n- checkbox "Offers" [ref=e2]`);
    assert.equal(els[0].value, "checked");
    assert.equal(els[1].value, undefined);
  });

  it("keeps a long value short enough not to eat the prompt", () => {
    const els = parseAriaSnapshot(`- textbox "Notes" [ref=e1]: ${"x".repeat(200)}`);
    assert.equal(els[0].value!.length, 60);
  });
});

describe("parseAriaSnapshot: an open modal", () => {
  /**
   * The page behind the booking modal is still in the tree. A real visitor cannot
   * touch it, and neither can an agent: measured live, three clicks on the page's
   * own CTAs behind the backdrop each burned their whole ceiling and ended the run.
   */
  const PAGE_WITH_MODAL = `- generic [ref=e1]:
  - link "Home" [ref=e2]:
    - /url: /
  - button "Book this ritual" [ref=e3] [cursor=pointer]
  - button "Book Now" [ref=e4] [cursor=pointer]
- dialog "Book a session" [ref=e10]:
  - generic [ref=e11]:
    - textbox "Your Name" [ref=e12]
    - button "Confirm Booking" [ref=e13] [cursor=pointer]
    - button "Close" [ref=e14] [cursor=pointer]`;

  it("offers only what is inside the modal", () => {
    assert.deepEqual(
      parseAriaSnapshot(PAGE_WITH_MODAL, true).map((e) => e.name),
      ["Your Name", "Confirm Booking", "Close"],
    );
  });

  /**
   * The one that cost a live run. A closed overlay hidden with `opacity: 0` and
   * `pointer-events: none` keeps its whole subtree in the accessibility tree, so
   * the snapshot alone cannot tell open from closed. Restricting the page to a
   * modal nobody opened sent the agent clicking into a void, 25s a step.
   */
  it("offers the whole page when the dialog is in the tree but not on the screen", () => {
    assert.deepEqual(
      parseAriaSnapshot(PAGE_WITH_MODAL).map((e) => e.name),
      ["Home", "Book this ritual", "Book Now", "Your Name", "Confirm Booking", "Close"],
    );
  });

  it("numbers the modal's controls from one, so the model can address them", () => {
    const els = parseAriaSnapshot(PAGE_WITH_MODAL, true);
    assert.deepEqual(
      els.map((e) => e.index),
      [1, 2, 3],
    );
    assert.equal(els[0].ref, "e12");
  });

  it("takes the topmost modal when two are open", () => {
    const stacked = `${PAGE_WITH_MODAL}
- dialog "Are you sure?" [ref=e20]:
  - button "Yes" [ref=e21]
  - button "No" [ref=e22]`;
    assert.deepEqual(
      parseAriaSnapshot(stacked, true).map((e) => e.name),
      ["Yes", "No"],
    );
  });

  it("ignores a modal with nothing to operate rather than reporting a blank page", () => {
    const notice = `- button "Book Now" [ref=e1]
- dialog "Please wait" [ref=e2]:
  - paragraph [ref=e3]: Loading your slot`;
    assert.deepEqual(
      parseAriaSnapshot(notice, true).map((e) => e.name),
      ["Book Now"],
    );
  });

  it("keeps the whole page when no modal is open", () => {
    const plain = `- button "Book this ritual" [ref=e1]\n- button "Book Now" [ref=e2]`;
    assert.equal(parseAriaSnapshot(plain, true).length, 2);
  });
});

/**
 * Which dialogs count as covering the page.
 *
 * This runs in the browser, so what follows is a stand-in DOM: it answers the six
 * questions the rule asks and nothing else. The live proof is a run against
 * resend.com/docs, whose search palette these numbers are taken from. What this
 * pins is the rule itself, including the three shapes it must NOT fire on, since
 * a false positive here shrinks a working page to a chat bubble.
 */
describe("modalIsOpen: what counts as covering the page", () => {
  type Style = "pointerEvents" | "display" | "visibility" | "opacity" | "position";

  /** The smallest node that can answer those questions. */
  interface N {
    attrs: Record<string, string>;
    style: Partial<Record<Style, string>>;
    size: { width: number; height: number };
    parentElement: N | null;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): { width: number; height: number };
    contains(other: unknown): boolean;
  }

  const node = (over: Partial<Pick<N, "attrs" | "style" | "size" | "parentElement">> = {}): N => {
    const self: N = {
      attrs: over.attrs ?? {},
      style: over.style ?? {},
      size: over.size ?? { width: 100, height: 40 },
      parentElement: over.parentElement ?? null,
      getAttribute: (name) => self.attrs[name] ?? null,
      getBoundingClientRect: () => self.size,
      contains: (other) => {
        for (let n = other as N | null; n; n = n.parentElement) if (n === self) return true;
        return false;
      },
    };
    return self;
  };

  const VIEWPORT = { width: 1280, height: 720 };

  /** Put the stand-in in place, ask the real rule, put the globals back. */
  const ask = (candidates: N[], centre: N | null): boolean => {
    const g = globalThis as { document?: unknown; window?: unknown; getComputedStyle?: unknown };
    const had = { document: g.document, window: g.window, getComputedStyle: g.getComputedStyle };
    Object.assign(globalThis, {
      document: { querySelectorAll: () => candidates, elementFromPoint: () => centre },
      window: { innerWidth: VIEWPORT.width, innerHeight: VIEWPORT.height },
      getComputedStyle: (n: N) => ({
        pointerEvents: "auto",
        display: "block",
        visibility: "visible",
        opacity: "1",
        position: "static",
        ...n.style,
      }),
    });
    try {
      return modalIsOpen();
    } finally {
      Object.assign(globalThis, had);
    }
  };
  /**
   * The measured shape. resend.com/docs, search palette open: a `role="dialog"` of
   * 640x62 in a 1280x720 viewport, so 4% of it and no `aria-modal` anywhere, sitting
   * inside a `role="presentation"` div that is fixed, inset to all four edges, and
   * takes pointer events. The centre of the screen hit-tests to that layer.
   */
  const palette = (layer: Partial<Record<Style, string>>, size = VIEWPORT) => {
    const holder = node({ attrs: { role: "presentation" }, style: layer, size });
    return {
      layer: holder,
      dialog: node({
        attrs: { role: "dialog" },
        size: { width: 640, height: 62 },
        parentElement: holder,
      }),
    };
  };

  it("counts the layer a small dialog is painted into, which is what eats the clicks", () => {
    const p = palette({ position: "fixed" });
    assert.equal(ask([p.dialog], p.layer), true);
  });

  it("does not count an ordinary wrapper that happens to be under the centre", () => {
    const p = palette({ position: "static" });
    assert.equal(ask([p.dialog], p.layer), false);
  });

  it("does not count a positioned layer that leaves most of the page reachable", () => {
    const p = palette({ position: "fixed" }, { width: 1280, height: 360 });
    assert.equal(ask([p.dialog], p.layer), false);
  });

  it("counts a dialog the centre lands inside, whatever its size", () => {
    const dialog = node({ attrs: { role: "dialog" }, size: { width: 400, height: 300 } });
    assert.equal(ask([dialog], node({ parentElement: dialog })), true);
  });

  it("leaves a chat bubble alone: the page behind it is still there to be used", () => {
    const bubble = node({ attrs: { role: "dialog" }, size: { width: 380, height: 520 } });
    assert.equal(ask([bubble], node({ style: { position: "static" } })), false);
  });

  it("still takes a dialog at its word when it declares itself modal", () => {
    const tiny = node({ attrs: { role: "dialog", "aria-modal": "true" }, size: { width: 30, height: 20 } });
    assert.equal(ask([tiny], node()), true);
  });

  it("still counts one that fills most of the viewport on its own", () => {
    const big = node({ attrs: { role: "dialog" }, size: { width: 800, height: 700 } });
    assert.equal(ask([big], node()), true);
  });

  it("ignores an overlay that takes no pointer events, however large", () => {
    const closed = node({
      attrs: { role: "dialog", "aria-modal": "true" },
      style: { pointerEvents: "none" },
      size: VIEWPORT,
    });
    assert.equal(ask([closed], closed), false);
  });

  it("ignores one its wrapper has faded out", () => {
    const faded = node({ style: { opacity: "0" } });
    const inner = node({ attrs: { role: "dialog", "aria-modal": "true" }, size: VIEWPORT, parentElement: faded });
    assert.equal(ask([inner], inner), false);
  });

  it("says no when nothing at all is at the centre", () => {
    const p = palette({ position: "fixed" });
    assert.equal(ask([p.dialog], null), false);
  });
});


/**
 * The prose budget, and what it was being spent on.
 *
 * Taken from docs.stripe.com/keys: 1200 characters of sidebar ahead of the page's
 * own first sentence, inside a 2800 character cap, on the one task whose finishing
 * test is something you have to read the page to have seen.
 */
describe("prose: the page rather than the furniture around it", () => {
  const SIDEBAR =
    "Get started\nPayments\nRevenue\nChangelog\nPagination\nTerraform\nSecurity\nPrivacy";
  const BODY =
    "API keys\nUse API keys to authenticate API requests.\n" +
    "Stripe uses API keys to authenticate requests from your integration and " +
    "determine which Stripe resources it can access. Use the API keys page in the " +
    "Dashboard to create, reveal, expire, and rotate keys.";

  it("takes the sidebar out of the text, wherever the sidebar sits", () => {
    const outside = prose({ body: `${SIDEBAR}\n${BODY}`, content: BODY, chrome: [SIDEBAR] });
    const inside = prose({ body: `${SIDEBAR}\n${BODY}`, content: `${SIDEBAR}\n${BODY}`, chrome: [SIDEBAR] });
    for (const text of [outside, inside]) {
      assert.ok(text.includes("authenticate API requests"));
      assert.ok(!text.includes("Terraform"), "the sidebar survived");
    }
  });

  it("leaves a page that names no root and wraps nothing in a nav exactly as it was", () => {
    assert.equal(prose({ body: BODY, content: "", chrome: [] }), BODY);
  });

  it("prefers the whole body to a content root holding a spinner", () => {
    const text = prose({ body: BODY, content: "Loading", chrome: [] });
    assert.ok(text.includes("authenticate API requests"));
  });

  it("keeps a wall of links, because that is what that page is", () => {
    const links = "Home\nAbout\nBlog\nContact\nCareers\nPress";
    assert.equal(prose({ body: links, content: "", chrome: [links] }), links);
  });

  it("removes a repeated nav every time it appears, not just the first", () => {
    const nav = "Docs\nAPI\nSupport";
    const text = prose({ body: `${nav}\n${BODY}\n${nav}`, content: "", chrome: [nav] });
    assert.ok(!text.includes("Support"));
    assert.ok(text.includes("rotate keys"));
  });

  it("collapses the blank runs that removing a block leaves behind", () => {
    const text = prose({ body: `A\n\nnav here\n\nB`, content: "", chrome: ["nav here"] });
    assert.equal(text, "A\nB");
  });

  it("survives a page that answered with nothing at all", () => {
    assert.equal(prose({ body: "", content: "", chrome: [] }), "");
  });
});

/**
 * The tail of docs.stripe.com/api/authentication, which fills the allowance to the
 * character. The last thing the model read was a copy button's label sliced in half,
 * one line under a curl sample: nothing to learn from, and an invitation to go and
 * click a language tab for the whole one.
 */
describe("capped: where the prose is allowed to stop", () => {
  it("leaves a page that fits alone", () => {
    assert.equal(capped("short enough", 50), "short enough");
  });

  it("ends on the last whole line when the cut is nearly there anyway", () => {
    const text = "curl https://api.stripe.com/v1/charges\n  -u sk_test_REAL\nsk_test_BQoki";
    assert.equal(capped(text, 64, 20), "curl https://api.stripe.com/v1/charges\n  -u sk_test_REAL");
  });

  /**
   * The other way round, and the reason the boundary is bounded. A cut landing
   * early in a long line would drop the whole line, and on this page the long line
   * is the code sample the grader reads its evidence from.
   */
  it("keeps a long line mangled rather than throwing it away whole", () => {
    const text = `intro\n${"curl https://api.stripe.com/v1/charges -u sk_test_REAL".repeat(4)}`;
    const out = capped(text, 60, 20);
    assert.equal(out.length, 60);
    assert.ok(out.includes("curl "), "the sign the grader reads must survive the cut");
  });

  it("does not cut at a break that is nowhere near the end", () => {
    assert.equal(capped(`a\n${"b".repeat(400)}`, 100, 20).length, 100);
  });

  /** The real numbers, since the slack is only meaningful against the allowance. */
  it("gives up at most the slack, whatever the page looks like", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of the page`).join("\n");
    assert.ok(capped(lines).length >= 2800 - 160);
    assert.ok(capped(lines).length <= 2800);
  });
});

describe("renderState", () => {
  function perception(over: Partial<Perception> = {}): Perception {
    return {
      url: "https://example.com/book",
      title: "Book",
      elements: [],
      text: "Choose a time.",
      jsGated: false,
      hasPrice: false,
      ...over,
    };
  }

  it("spells out a dropdown's choices, which is the only way select can name one", () => {
    const state = renderState(
      perception({
        elements: [
          {
            index: 1,
            role: "combobox",
            name: "Preferred Time",
            ref: "e335",
            options: ["Any time", "10:00 AM"],
          },
        ],
      }),
      6,
    );
    assert.match(state, /1\. \[combobox\] Preferred Time {2}choices: Any time, 10:00 AM/);
  });

  /**
   * The line the model reads to know it has already typed something. Without it,
   * a filled field and an empty one are the same three words, and the model fills
   * it again: four consecutive identical steps on a live run.
   */
  it("shows what a field already holds", () => {
    const state = renderState(
      perception({
        elements: [
          { index: 1, role: "textbox", name: "Your Name", ref: "e374", value: "Alex Morgan" },
          { index: 2, role: "textbox", name: "Phone Number", ref: "e377" },
        ],
      }),
      6,
    );
    assert.match(state, /1\. \[textbox\] Your Name {2}= "Alex Morgan"/);
    assert.match(state, /2\. \[textbox\] Phone Number$/m, "and an empty field says nothing");
  });

  it("keeps a link's destination visible so a dead end is obvious to the model too", () => {
    const state = renderState(
      perception({
        elements: [{ index: 1, role: "link", name: "Chat", href: "https://wa.me/234801" }],
      }),
      6,
    );
    assert.match(state, /1\. \[link\] Chat {2}-> https:\/\/wa\.me\/234801/);
  });

  /**
   * So the model can say why it is stuck. Told that the submit exists and is dead,
   * it looks for what is unsatisfied; told nothing, it reports no submit button and
   * the reader blames our eyes rather than the page.
   */
  it("marks a control that cannot be operated, right after its name", () => {
    const state = renderState(
      perception({
        elements: [
          { index: 1, role: "checkbox", name: "I am human", ref: "e7" },
          { index: 2, role: "button", name: "Start my free trial", ref: "e9", disabled: true },
        ],
      }),
      6,
    );
    assert.match(state, /2\. \[button\] Start my free trial {2}\(disabled\)$/m);
    assert.match(state, /1\. \[checkbox\] I am human$/m, "and leaves a working control unmarked");
  });

  it("says the tree was empty rather than printing nothing at all", () => {
    assert.match(renderState(perception(), 3), /the accessibility tree is empty/);
  });
});

/**
 * Two things read this: the grader, which calls four identical perceptions a
 * loop, and the run itself, which compares one step to the next to tell whether
 * the click it just made did anything. So "changed" has to mean changed to a
 * visitor, and nothing else.
 */
describe("fingerprint: what counts as the same page", () => {
  const page = (over: Partial<Perception> = {}): Perception => ({
    url: "https://docs.stripe.com/agents#tools",
    title: "Agent developer tools",
    elements: [
      { index: 1, role: "button", name: "APIs & SDKs", ref: "e12" },
      { index: 2, role: "textbox", name: "Search", ref: "e13" },
    ],
    text: "Build with Stripe.",
    jsGated: false,
    hasPrice: false,
    ...over,
  });

  /** The property the run depends on: refs are minted per snapshot. */
  it("is unmoved by new refs, so an untouched page is not mistaken for a changed one", () => {
    const fresh = page({
      elements: [
        { index: 1, role: "button", name: "APIs & SDKs", ref: "e88" },
        { index: 2, role: "textbox", name: "Search", ref: "e89" },
      ],
    });
    assert.equal(fingerprint(page()), fingerprint(fresh));
  });

  it("is unmoved by prose, so a page whose text rotates on its own is not read as progress", () => {
    assert.equal(fingerprint(page()), fingerprint(page({ text: "Something else entirely." })));
  });

  it("changes when a control goes live, which is the quietest real change there is", () => {
    const off = page({
      elements: [{ index: 1, role: "button", name: "Submit", disabled: true }],
    });
    const on = page({ elements: [{ index: 1, role: "button", name: "Submit" }] });
    assert.notEqual(fingerprint(off), fingerprint(on));
  });

  it("changes when a field holds something, because filling a form is progress", () => {
    const filled = page({
      elements: [
        { index: 1, role: "button", name: "APIs & SDKs", ref: "e12" },
        { index: 2, role: "textbox", name: "Search", ref: "e13", value: "webhooks" },
      ],
    });
    assert.notEqual(fingerprint(page()), fingerprint(filled));
  });

  it("changes when the page offers something it did not before", () => {
    const more = page({
      elements: [
        { index: 1, role: "button", name: "APIs & SDKs", ref: "e12" },
        { index: 2, role: "textbox", name: "Search", ref: "e13" },
        { index: 3, role: "link", name: "Quickstart", ref: "e14" },
      ],
    });
    assert.notEqual(fingerprint(page()), fingerprint(more));
  });

  /**
   * Measured on docs.stripe.com: the nav control at #tools was clicked on three
   * consecutive steps, each landing cleanly, and every perception after the
   * first came back byte-identical. That is what the run now tells the model.
   */
  it("holds still across a click that landed and did nothing", () => {
    assert.equal(fingerprint(page()), fingerprint(page()));
  });
});

/**
 * The looser question, for the run's own memory: is this the same page, allowing
 * for the parts of it that move by themselves?
 *
 * Needed because plenty of pages are never twice the same. Measured on run 6 of
 * docs.stripe.com: across four snapshots of a home page nobody had touched, two of
 * its sixty elements read "jenny.rosen@example.com", then "$ stripe balance
 * retrieve", then "false", then "https://example.com/success". Eight perceptions
 * in that run, eight different fingerprints, four of them the same page. So every
 * guard that asked "did that do anything" answered yes to a click that had
 * navigated nowhere, and no page was ever recorded as visited twice.
 *
 * The overlaps measured on those real element sets, which is where the threshold
 * comes from: 0.93 and 0.87 for the same page, 0.63 and 0.28 for a menu opening,
 * 0.01 and 0.00 for a navigation. These are built at the width they were measured
 * at, sixty marks, because the width is most of the answer: two changing out of
 * sixty is 0.94 shared and two out of four is 0.33.
 */
describe("resembles: the same page, with something ticking on it", () => {
  const wide = (over: Partial<Perception> = {}, sample = "jenny.rosen@example.com"): Perception => ({
    url: "https://docs.stripe.com/",
    title: "Stripe API and developer documentation",
    text: "Get started with payments.",
    jsGated: false,
    hasPrice: false,
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
    ...over,
  });

  it("calls a page with a rotating sample on it the page it was a step ago", () => {
    assert.ok(resembles(wide(), wide({}, "$ stripe balance retrieve")));
  });

  it("survives the sample rotating twice more, which is what a four-step visit costs", () => {
    assert.ok(resembles(wide({}, "false"), wide({}, "https://example.com/success")));
  });

  it("says no to a different URL before it counts anything, since a copy is not the original", () => {
    assert.ok(!resembles(wide(), wide({ url: "https://docs.stripe.com/keys" })));
  });

  /** 0.01 and 0.00 measured. Nothing about a login page resembles the docs. */
  it("says no to a navigation, where almost nothing is shared", () => {
    const login = wide({
      url: "https://docs.stripe.com/",
      title: "Sign in to Stripe",
      elements: [
        { index: 1, role: "textbox", name: "Email", ref: "e1" },
        { index: 2, role: "textbox", name: "Password", ref: "e2" },
        { index: 3, role: "button", name: "Continue", ref: "e3" },
      ],
    });
    assert.ok(!resembles(wide(), login));
  });

  /** 0.63 and 0.28 measured, on stripe.com, where a menu put real controls on screen. */
  it("says no when a menu opens, because that is the page answering", () => {
    const opened = wide();
    opened.elements = [
      ...opened.elements,
      ...Array.from({ length: 30 }, (_, i) => ({
        index: 61 + i,
        role: "link",
        name: `Product ${i + 1}`,
        ref: `m${i}`,
      })),
    ];
    assert.ok(!resembles(wide(), opened));
  });

  it("notices a field being filled, which is the quietest progress there is", () => {
    const typed = wide();
    typed.elements = [
      ...typed.elements.slice(0, 58),
      { index: 59, role: "textbox", name: "Search", ref: "e59", value: "webhooks" },
      { index: 60, role: "button", name: "Copy", ref: "e60" },
    ];
    const empty = wide();
    empty.elements = [
      ...empty.elements.slice(0, 58),
      { index: 59, role: "textbox", name: "Search", ref: "e59" },
      { index: 60, role: "button", name: "Copy", ref: "e60" },
    ];
    // One mark of sixty, so it is inside the threshold and reads as the same page.
    // Correct for the memory that uses it: typing into a box leaves you standing
    // where you were, and the moves already tried from here are still the moves
    // already tried from here.
    assert.ok(resembles(empty, typed));
  });

  it("holds an empty page against an empty page by its title, having nothing else to go on", () => {
    const blank = wide({ elements: [] });
    assert.ok(resembles(blank, wide({ elements: [] })));
    assert.ok(!resembles(blank, wide({ elements: [], title: "Something else" })));
  });

  it("is a threshold, not a rule, so a caller that wants exactness can ask for it", () => {
    assert.ok(!resembles(wide(), wide({}, "false"), 1));
    assert.ok(resembles(wide(), wide(), 1));
  });
});

/**
 * The marks are what both of the above compare. Pinned separately because they are
 * the only place `ref` could leak into a comparison, and a ref is minted per
 * snapshot: one leaking in makes every page a page never seen before.
 */
describe("marks: the page as a list of things that can be told apart", () => {
  const p: Perception = {
    url: "https://example.com/",
    title: "Example",
    text: "Hello.",
    jsGated: false,
    hasPrice: false,
    elements: [
      { index: 1, role: "textbox", name: "Email", ref: "e1", value: "a@b.co" },
      { index: 2, role: "button", name: "Continue", ref: "e2", disabled: true },
    ],
  };

  it("carries role, name, value and whether the control is live", () => {
    assert.deepEqual(marks(p), ["textbox:Email:a@b.co:on", "button:Continue::off"]);
  });

  it("leaves the ref out, since a ref says only which snapshot it came from", () => {
    const again = { ...p, elements: p.elements.map((e, i) => ({ ...e, ref: `z${i}` })) };
    assert.deepEqual(marks(p), marks(again));
  });

  it("is what fingerprint joins, so the two can never drift apart", () => {
    assert.ok(fingerprint(p).endsWith(marks(p).join("|")));
  });
});

describe("looksCoded: a call the reader could copy", () => {
  it("reads the shapes a docs page shows code in", () => {
    for (const text of [
      "curl -X POST https://api.stripe.com/v1/charges",
      "curl https://api.example.com/v1/ping",
      'Authorization: Bearer sk_test_123',
      'import { Resend } from "resend";',
      "const stripe = require('stripe')(key);",
      'await fetch("https://api.example.com")',
      '  -H "Content-Type: application/json"',
    ]) {
      assert.equal(looksCoded(text), true, text);
    }
  });

  it("is not fooled by prose about code", () => {
    // The whole point of measuring this against the untrimmed page is that the
    // answer gets trusted, so a page that only talks about integrating must not
    // pass. Every one of these appeared in the text of a real docs page we walked.
    for (const text of [
      "See the code example in our API reference to get started.",
      "Install the SDK, then import it into your project.",
      "Copy your API key from the Dashboard and curl away.",
      "Our quickstart shows you how to make your first request.",
      "You can fetch the balance once you have authenticated.",
      "npm install stripe",
      "",
    ]) {
      assert.equal(looksCoded(text), false, text);
    }
  });
});
