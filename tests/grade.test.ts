import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grade, type Transcript } from "../lib/grade";
import type { ActionKind, Blocker, Perception, PerceivedElement } from "../lib/types";

/** Enough prose to clear the understood-offering threshold (400 chars). */
const PROSE = "Send money to anyone in Nigeria in seconds. ".repeat(12);

function el(
  index: number,
  role: string,
  name: string,
  href?: string,
): PerceivedElement {
  return href ? { index, role, name, href } : { index, role, name };
}

function page(over: Partial<Perception> = {}): Perception {
  return {
    url: "https://example.com/",
    title: "Example",
    elements: [],
    text: PROSE,
    jsGated: false,
    hasPrice: false,
    ...over,
  };
}

function transcript(over: Partial<Transcript> = {}): Transcript {
  return {
    action: "signup" as ActionKind,
    startUrl: "https://example.com/",
    perceptions: [page()],
    declaredDone: false,
    gaveUp: false,
    failures: [],
    stepCount: 1,
    stealth: true,
    ...over,
  };
}

function blockers(t: Transcript): Blocker[] {
  return grade(t).blockers.map((b) => b.blocker);
}

describe("grade: the happy path", () => {
  const clean = transcript({
    action: "signup",
    perceptions: [
      page({ hasPrice: true, elements: [el(1, "link", "Sign up free", "/signup")] }),
      page({ url: "https://example.com/signup", hasPrice: true, elements: [el(1, "button", "Create account")] }),
    ],
    declaredDone: true,
    stepCount: 4,
  });

  it("awards every milestone and an A when the agent finished", () => {
    const v = grade(clean);
    assert.deepEqual(v.milestones.sort(), [
      "completed-action",
      "found-cta",
      "found-key-info",
      "understood-offering",
    ]);
    assert.equal(v.score, 100);
    assert.equal(v.grade, "A");
    assert.deepEqual(v.blockers, []);
  });

  it("reports the step count it was given, not a count of its own", () => {
    assert.equal(grade(clean).steps, 4);
  });

  it("says so in the summary, in words a site owner can repeat", () => {
    assert.match(grade(clean).summary, /completed "sign up"/i);
    assert.match(grade(clean).summary, /4 steps/);
  });
});

describe("grade: hard blockers cap the result", () => {
  it("flags js-gate when the accessibility tree is empty throughout", () => {
    const t = transcript({
      perceptions: [page({ jsGated: true, text: "" }), page({ jsGated: true, text: "" })],
    });
    assert.ok(blockers(t).includes("js-gate"));
  });

  it("flags js-gate on a single empty perception, since that is all we saw", () => {
    const t = transcript({ perceptions: [page({ jsGated: true, text: "" })] });
    assert.ok(blockers(t).includes("js-gate"));
  });

  it("does not flag js-gate when the tree filled in after a wait", () => {
    const t = transcript({ perceptions: [page({ jsGated: true, text: "" }), page()] });
    assert.ok(!blockers(t).includes("js-gate"));
  });

  it("caps an otherwise perfect run at 45 when a hard blocker was hit on the way", () => {
    const t = transcript({
      action: "signup",
      perceptions: [
        page({ hasPrice: true, text: `${PROSE} please complete the captcha`, elements: [el(1, "link", "Sign up", "/signup")] }),
      ],
      declaredDone: true,
    });
    const v = grade(t);
    assert.equal(v.milestones.length, 4, "every milestone was still reached");
    assert.equal(v.score, 45, "the cap, not the sum of 100");
    assert.equal(v.grade, "D");
  });

  it("caps rather than floors, so a bad run is not lifted to 45", () => {
    const t = transcript({
      perceptions: [page({ jsGated: true, text: "" }), page({ jsGated: true, text: "" })],
      declaredDone: true,
    });
    const v = grade(t);
    assert.equal(v.score, 40, "completion alone, with nothing else earned");
    assert.ok(v.milestones.includes("completed-action"), "the milestone is still recorded");
  });

  it("prefers the captcha finding over the bot-wall finding, not both", () => {
    const t = transcript({ perceptions: [page({ text: `${PROSE} please complete the captcha` })] });
    const b = blockers(t);
    assert.ok(b.includes("captcha"));
    assert.ok(!b.includes("bot-wall"), "captcha already explains the interstitial");
  });

  it("softens the bot-wall claim when stealth was unavailable", () => {
    const text = `${PROSE} checking your browser`;
    const withStealth = grade(transcript({ perceptions: [page({ text })], stealth: true }));
    const without = grade(transcript({ perceptions: [page({ text })], stealth: false }));
    assert.match(withStealth.blockers.find((b) => b.blocker === "bot-wall")!.detail, /stealth browser/);
    assert.match(without.blockers.find((b) => b.blocker === "bot-wall")!.detail, /may fare better/);
  });
});

describe("grade: dead-end CTAs", () => {
  it("flags a contact route that only hands off to WhatsApp", () => {
    const t = transcript({
      action: "contact",
      perceptions: [page({ elements: [el(1, "link", "Contact us on WhatsApp", "https://wa.me/2348012345678")] })],
    });
    const v = grade(t);
    assert.ok(v.blockers.some((b) => b.blocker === "dead-end-cta"));
    assert.ok(!v.milestones.includes("found-cta"), "a link an agent cannot follow is not a usable CTA");
    assert.ok(v.score <= 45);
  });

  it("does not flag it when a real route exists alongside the handoff", () => {
    const t = transcript({
      action: "contact",
      perceptions: [
        page({
          elements: [
            el(1, "link", "Contact us on WhatsApp", "https://wa.me/234801"),
            el(2, "link", "Contact form", "/contact"),
          ],
        }),
      ],
    });
    const v = grade(t);
    assert.ok(!v.blockers.some((b) => b.blocker === "dead-end-cta"));
    assert.ok(v.milestones.includes("found-cta"));
  });

  it("flags a site whose every link is a handoff, even with no matching CTA text", () => {
    const t = transcript({
      action: "book",
      perceptions: [
        page({
          elements: [
            el(1, "link", "Chat", "https://wa.me/1"),
            el(2, "link", "Call", "tel:+2348012345678"),
            el(3, "link", "Email", "mailto:hi@example.com"),
          ],
        }),
      ],
    });
    assert.ok(blockers(t).includes("dead-end-cta"));
  });

  it("needs at least three links before calling a site all dead ends", () => {
    const t = transcript({
      action: "book",
      perceptions: [page({ elements: [el(1, "link", "Chat", "https://wa.me/1")] })],
    });
    assert.ok(!blockers(t).includes("dead-end-cta"));
  });
});

describe("grade: the soft findings", () => {
  it("flags a missing machine-readable price for purchase and signup only", () => {
    for (const action of ["purchase", "signup"] as ActionKind[]) {
      assert.ok(blockers(transcript({ action })).includes("no-structured-price"), action);
    }
    for (const action of ["integrate", "book", "contact"] as ActionKind[]) {
      assert.ok(!blockers(transcript({ action })).includes("no-structured-price"), action);
    }
  });

  it("flags an auth gate only when the run did not finish anyway", () => {
    const perceptions = [page({ text: `${PROSE} please log in` })];
    assert.ok(blockers(transcript({ perceptions })).includes("auth-gate"));
    assert.ok(!blockers(transcript({ perceptions, declaredDone: true })).includes("auth-gate"));
  });

  it("flags a form stall from two or more failed interactions", () => {
    assert.ok(!blockers(transcript({ failures: ["one"] })).includes("form-stall"));
    const stalled = grade(transcript({ failures: ["timeout on #email", "detached node"] }));
    const hit = stalled.blockers.find((b) => b.blocker === "form-stall")!;
    assert.match(hit.detail, /timeout on #email/);
  });

  it("flags a loop when four perceptions running share one URL", () => {
    const stuck = Array.from({ length: 4 }, () => page({ url: "https://example.com/pricing" }));
    assert.ok(blockers(transcript({ perceptions: stuck, stepCount: 4 })).includes("loop"));

    const moving = [...stuck.slice(0, 3), page({ url: "https://example.com/checkout" })];
    assert.ok(!blockers(transcript({ perceptions: moving, stepCount: 4 })).includes("loop"));
  });

  it("does not call a modal flow a loop just because the URL never changes", () => {
    // A booking flow inside one modal: four screens, one address. Calling this a
    // loop is how a working site gets graded as a broken one.
    const flow = [
      page({ elements: [el(1, "button", "Book Now")] }),
      page({ elements: [el(1, "button", "01 Body Massage"), el(2, "button", "02 Facial")] }),
      page({ elements: [el(1, "button", "Continue")] }),
      page({ elements: [el(1, "textbox", "Preferred Date"), el(2, "button", "Confirm")] }),
    ];
    assert.ok(!blockers(transcript({ perceptions: flow, stepCount: 4 })).includes("loop"));
  });

  it("does not call it a loop when our own actuator stopped landing clicks", () => {
    // Seen live: three consecutive hung clicks left four identical perceptions of
    // a booking form that was working fine. The page could not change because we
    // never touched it, so charging the site with going in circles is our error
    // dressed up as its finding.
    const stuck = Array.from({ length: 4 }, () => page({ url: "https://example.com/book" }));
    const ours = { perceptions: stuck, stepCount: 4, abandoned: "the browser stopped answering" };
    assert.ok(!blockers(transcript(ours)).includes("loop"));
    assert.ok(blockers(transcript({ ...ours, abandoned: undefined })).includes("loop"));
  });

  it("flags nav-error when nothing was ever perceived", () => {
    const v = grade(transcript({ perceptions: [], stepCount: 0 }));
    assert.ok(v.blockers.some((b) => b.blocker === "nav-error"));
    assert.equal(v.grade, "F");
    assert.deepEqual(v.milestones, []);
  });
});

describe("grade: milestones and letters", () => {
  it("withholds understood-offering when there is barely any text", () => {
    const v = grade(transcript({ perceptions: [page({ text: "Coming soon." })] }));
    assert.ok(!v.milestones.includes("understood-offering"));
  });

  it("counts code samples as the key info an integrate task needs", () => {
    const t = transcript({
      action: "integrate",
      perceptions: [page({ text: `${PROSE} npm install acme-sdk` })],
    });
    assert.ok(grade(t).milestones.includes("found-key-info"));
  });

  it("counts opening hours as the key info a booking task needs", () => {
    const t = transcript({
      action: "book",
      perceptions: [page({ text: `${PROSE} open Monday to Friday, 9am to 6pm` })],
    });
    assert.ok(grade(t).milestones.includes("found-key-info"));
  });

  it("caps an unfinished run at 55 once the agent gave up", () => {
    const t = transcript({
      action: "integrate",
      perceptions: [
        page({ text: `${PROSE} curl https://api.example.com`, elements: [el(1, "link", "API docs", "/docs")] }),
        page({ url: "https://example.com/docs", text: `${PROSE} api key` }),
      ],
      gaveUp: true,
      stepCount: 6,
    });
    const v = grade(t);
    assert.equal(v.score, 55);
    assert.equal(v.grade, "C");
  });

  it("puts the letter boundaries where the thresholds say", () => {
    // understood(15) + key info(20) + cta(25) = 60, no completion: a C.
    const t = transcript({
      action: "purchase",
      perceptions: [page({ hasPrice: true, elements: [el(1, "link", "Buy now", "/checkout")] })],
    });
    const v = grade(t);
    assert.equal(v.score, 60);
    assert.equal(v.grade, "C");
    assert.deepEqual(v.blockers, [], "nothing specific stopped it, it simply did not finish");
    assert.match(v.summary, /without hitting a specific blocker/);
  });

  it("says how far the agent got when a blocker stopped it at the last step", () => {
    const t = transcript({
      action: "signup",
      perceptions: [page({ elements: [el(1, "link", "Sign up", "/signup")] })],
    });
    const v = grade(t);
    assert.match(v.summary, /found the right button and still could not finish/);
    assert.match(v.summary, /no-structured-price/);
  });

  it("explains how far the agent got when it never reached the action", () => {
    const v = grade(transcript({ perceptions: [page({ jsGated: true, text: "" })] }));
    assert.match(v.summary, /could not even read what you sell/);
  });
});

describe("grade: a run cut short by our own side", () => {
  /** A page that has earned understood(15) + key info(20) + cta(25) = 60. */
  const reached = () =>
    page({ hasPrice: true, elements: [el(1, "link", "Buy now", "/checkout")] });

  it("does not cap the score the way giving up does", () => {
    const t = transcript({
      action: "purchase",
      perceptions: [reached()],
      stepCount: 5,
      abandoned: "Groq rate limit reached",
    });
    const v = grade(t);
    // 60, not the 55 that gaveUp would have forced. Our quota is not the site's
    // failing, and docking a site for it is a wrong answer with a number on it.
    assert.equal(v.score, 60);
    assert.equal(v.grade, "C");
  });

  it("says in the summary that the grade is a floor, and why", () => {
    const v = grade(
      transcript({
        action: "purchase",
        perceptions: [reached()],
        stepCount: 5,
        abandoned: "Groq rate limit reached",
      }),
    );
    assert.match(v.summary, /stopped early for a reason outside the site/);
    assert.match(v.summary, /Groq rate limit reached/);
    assert.match(v.summary, /floor, not a ceiling/);
  });

  it("adds no blocker of its own", () => {
    const clean = blockers(transcript({ action: "purchase", perceptions: [reached()] }));
    const cut = blockers(
      transcript({ action: "purchase", perceptions: [reached()], abandoned: "our timeout" }),
    );
    assert.deepEqual(cut, clean);
  });

  it("stays quiet about it on a run that finished normally", () => {
    const v = grade(transcript({ action: "purchase", perceptions: [reached()] }));
    assert.ok(!v.summary.includes("outside the site"));
  });
});
