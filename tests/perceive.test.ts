import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAriaSnapshot, renderState } from "../lib/perceive";
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

  it("drops disabled controls, which a visitor cannot use either", () => {
    const els = parseAriaSnapshot(
      `- button "Buy now" [disabled] [ref=e1]\n- button "Contact sales" [ref=e2]`,
    );
    assert.deepEqual(
      els.map((e) => e.name),
      ["Contact sales"],
    );
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
      parseAriaSnapshot(PAGE_WITH_MODAL).map((e) => e.name),
      ["Your Name", "Confirm Booking", "Close"],
    );
  });

  it("numbers the modal's controls from one, so the model can address them", () => {
    const els = parseAriaSnapshot(PAGE_WITH_MODAL);
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
      parseAriaSnapshot(stacked).map((e) => e.name),
      ["Yes", "No"],
    );
  });

  it("ignores a modal with nothing to operate rather than reporting a blank page", () => {
    const notice = `- button "Book Now" [ref=e1]
- dialog "Please wait" [ref=e2]:
  - paragraph [ref=e3]: Loading your slot`;
    assert.deepEqual(
      parseAriaSnapshot(notice).map((e) => e.name),
      ["Book Now"],
    );
  });

  it("keeps the whole page when no modal is open", () => {
    const plain = `- button "Book this ritual" [ref=e1]\n- button "Book Now" [ref=e2]`;
    assert.equal(parseAriaSnapshot(plain).length, 2);
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

  it("keeps a link's destination visible so a dead end is obvious to the model too", () => {
    const state = renderState(
      perception({
        elements: [{ index: 1, role: "link", name: "Chat", href: "https://wa.me/234801" }],
      }),
      6,
    );
    assert.match(state, /1\. \[link\] Chat {2}-> https:\/\/wa\.me\/234801/);
  });

  it("says the tree was empty rather than printing nothing at all", () => {
    assert.match(renderState(perception(), 3), /the accessibility tree is empty/);
  });
});
