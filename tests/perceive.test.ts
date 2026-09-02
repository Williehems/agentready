import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAriaSnapshot } from "../lib/perceive";

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
