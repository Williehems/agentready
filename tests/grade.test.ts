import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { endStateSeen, grade, type Transcript } from "../lib/grade";
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
    // What a run starting at the front page produces: it looked there, and there
    // was no price. Absent instead means the front page was never checked, which
    // grade() treats as no answer rather than as no price.
    priceOnHome: false,
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
      // The end state, which is what earns completed-action rather than the model's
      // word for it. A fresh browser is never offered a way out of a session.
      page({
        url: "https://example.com/app",
        title: "Dashboard",
        elements: [el(1, "button", "Log out")],
      }),
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

  /**
   * The fastest pass this product can report, and the sentence it used to mangle.
   * Live on docs.stripe.com/api/authentication the card read "An AI agent
   * completed "integrate the api" in 1 steps.", which is the best result on the
   * board written so nobody would quote it.
   */
  it("counts a single step as one step", () => {
    const v = grade({ ...clean, stepCount: 1 });
    assert.match(v.summary, /in 1 step\./);
    assert.ok(!/1 steps/.test(v.summary), v.summary);
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
        page({
          hasPrice: true,
          text: `${PROSE} please complete the captcha`,
          elements: [el(1, "link", "Sign up", "/signup"), el(2, "button", "Log out")],
        }),
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
      action: "book",
      perceptions: [page({ jsGated: true, text: "" }), page({ jsGated: true, text: "" })],
      declaredDone: true,
      // Submitted and answered with silence, which this task counts as finished.
      operated: ['type "Name"', 'click "10:30am"', 'click "Send booking"'],
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

describe("grade: a handoff to another app", () => {
  /**
   * The run this is for. A working booking modal, nine steps of real progress, and
   * a submit that ran `onclick="sendToWhatsApp()"`: WhatsApp opened in a second
   * tab, the first tab went back to the home page, and nothing anywhere said the
   * booking had been received. There is no href on a button, so the link tests saw
   * nothing to charge and the verdict came back "without hitting a specific
   * blocker" on a site an agent cannot book with.
   */
  const spa = (over: Partial<Transcript> = {}) =>
    transcript({
      action: "book",
      perceptions: [
        page({
          text: `${PROSE} open Monday to Friday, 9am to 6pm`,
          elements: [el(1, "button", "Book Now"), el(2, "link", "Our story", "/story")],
        }),
      ],
      handoffs: ["https://api.whatsapp.com/send/?phone=2348099224450&text=Hi+Escape+House"],
      ...over,
    });

  it("flags the tab a button opened, which no href test can see", () => {
    assert.ok(blockers(spa()).includes("dead-end-cta"));
  });

  it("names the app in words the site owner will recognise as their own button", () => {
    const hit = grade(spa()).blockers.find((b) => b.blocker === "dead-end-cta")!;
    assert.match(hit.detail, /handed the action off to WhatsApp in a separate tab/);
    assert.doesNotMatch(hit.detail, /api\.whatsapp\.com/, "the URL is not the name of the thing");
  });

  it("caps the grade like any other hard blocker, and says one thing rather than two", () => {
    const v = grade(spa());
    assert.equal(v.blockers.filter((b) => b.blocker === "dead-end-cta").length, 1);
    assert.ok(v.milestones.includes("found-cta"), "the CTA was found and it worked for nine steps");
    assert.equal(v.score, 45, "capped, not the 60 those milestones add up to");
    assert.equal(v.grade, "D");
  });

  it("ignores a tab that opened on nothing, which is where every popup starts", () => {
    assert.ok(!blockers(spa({ handoffs: ["about:blank"] })).includes("dead-end-cta"));
  });

  it("says nothing about a new tab an agent could have followed", () => {
    const docs = spa({ handoffs: ["https://docs.stripe.com/api"] });
    assert.deepEqual(blockers(docs), [], "opening docs in a new tab is not a dead end");
  });

  it("withholds a working contact route from a site that only opens WhatsApp", () => {
    const t = spa({ action: "contact", perceptions: [page({ text: `${PROSE} contact us` })] });
    assert.ok(!grade(t).milestones.includes("found-key-info"));
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

  /**
   * Where the audit was pointed must not move the grade.
   *
   * Measured twice on plausible.io: from the home page it earned found-key-info and
   * scored C 55, from /register it was charged no-structured-price and scored D 40.
   * Same site, same published prices in euros, 15 points apart on a URL we chose.
   */
  describe("a price the flow never passed", () => {
    const offPath = { startUrl: "https://example.com/register" };

    it("charges nothing when the front page could not be read", () => {
      // Undefined is "we could not look", and a site is never charged for that.
      const t = transcript({ ...offPath, priceOnHome: undefined });
      assert.ok(!blockers(t).includes("no-structured-price"));
    });

    it("charges the site once the front page has answered without one", () => {
      const t = transcript({ ...offPath, priceOnHome: false });
      assert.ok(blockers(t).includes("no-structured-price"));
    });

    it("credits a price found on the front page as key info the site published", () => {
      const t = transcript({ ...offPath, priceOnHome: true });
      const v = grade(t);
      assert.ok(!v.blockers.some((b) => b.blocker === "no-structured-price"));
      assert.ok(v.milestones.includes("found-key-info"));
    });

    it("closes the gap between the two start URLs", () => {
      // The 15 points that made the same site a C and a D.
      const fromHome = grade(transcript({ perceptions: [page({ hasPrice: true })] }));
      const fromForm = grade(transcript({ ...offPath, priceOnHome: true }));
      assert.equal(fromForm.score, fromHome.score);
      assert.equal(fromForm.grade, fromHome.grade);
    });
  });

  it("flags an auth gate only when the run did not finish anyway", () => {
    const wall = page({ text: `${PROSE} please log in` });
    assert.ok(blockers(transcript({ perceptions: [wall] })).includes("auth-gate"));
    const through = transcript({
      perceptions: [wall, page({ url: "https://example.com/app", elements: [el(1, "button", "Log out")] })],
      declaredDone: true,
    });
    assert.ok(!blockers(through).includes("auth-gate"));
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

  it("does not call filling in a form a loop, and still catches retyping one field", () => {
    // A form filled one field at a time: same URL, same elements, same count, and
    // real progress on every step. Judging that by anything but the contents calls
    // a working checkout a stuck loop.
    const form = (name?: string, phone?: string, notes?: string) =>
      page({
        url: "https://example.com/book",
        elements: [
          { index: 1, role: "textbox", name: "Your Name", ...(name ? { value: name } : {}) },
          { index: 2, role: "textbox", name: "Phone Number", ...(phone ? { value: phone } : {}) },
          { index: 3, role: "textbox", name: "Notes", ...(notes ? { value: notes } : {}) },
          el(4, "button", "Send booking"),
        ],
      });

    const filling = [
      form(),
      form("Alex Morgan"),
      form("Alex Morgan", "+1 415 555 0132"),
      form("Alex Morgan", "+1 415 555 0132", "no nuts"),
    ];
    assert.ok(!blockers(transcript({ perceptions: filling, stepCount: 4 })).includes("loop"));

    // And the run this came from: the same name into the same box, four times.
    const retyping = Array.from({ length: 4 }, () => form("Alex Morgan"));
    assert.ok(blockers(transcript({ perceptions: retyping, stepCount: 4 })).includes("loop"));
  });

  it("counts a submit coming to life as the page changing", () => {
    // The other half of the prompt rule that tells the agent to wait out a
    // challenge which clears itself. Nothing about that page moves except the one
    // thing that matters, so without the disabled state in the fingerprint the
    // patience we asked for is graded as going in circles.
    const form = (live: boolean) =>
      page({
        url: "https://plausible.io/register",
        elements: [
          { index: 1, role: "textbox", name: "Email", value: "alex@example.com" },
          { index: 2, role: "button", name: "Start my free trial", ...(live ? {} : { disabled: true }) },
        ],
      });

    const waiting = [form(false), form(false), form(false), form(true)];
    assert.ok(!blockers(transcript({ perceptions: waiting, stepCount: 4 })).includes("loop"));

    // And a submit that stays dead for all four is still the loop it always was.
    const dead = Array.from({ length: 4 }, () => form(false));
    assert.ok(blockers(transcript({ perceptions: dead, stepCount: 4 })).includes("loop"));
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

describe("grade: a wall that wants a code from an inbox", () => {
  // Verbatim from the plausible.io run, screenshot 05: the page the agent gave up
  // on after filling and submitting the signup form.
  const codeWall = page({
    url: "https://plausible.io/register",
    title: "Plausible Analytics",
    text: `${PROSE}\nCheck your email\nWe've sent an email with your code to: alex.morgan.test@example.com\nActivate account\nDidn't receive it? Resend code or change email`,
    elements: [el(1, "textbox", "Activation code"), el(2, "button", "Activate account")],
  });
  const reached = transcript({
    action: "signup",
    perceptions: [page({ elements: [el(1, "link", "Sign up", "/register")] }), codeWall],
    gaveUp: true,
    stepCount: 9,
  });

  it("names the code wall rather than the pricing copy", () => {
    const v = grade(reached);
    // The run this was written from reported no-structured-price first, which sent
    // the reader to look at prices when an email code was what stopped the agent.
    assert.equal(v.blockers[0]?.blocker, "verification-gate");
    assert.ok(v.blockers.some((b) => b.blocker === "no-structured-price"));
    assert.match(v.summary, /verification-gate/);
    assert.match(v.blockers[0]!.detail, /check your email/);
  });

  it("does not cap the score, because emailing a code is defensible", () => {
    const priced = transcript({
      ...reached,
      perceptions: [
        page({ hasPrice: true, elements: [el(1, "link", "Sign up", "/register")] }),
        { ...codeWall, hasPrice: true },
      ],
    });
    const v = grade(priced);
    assert.deepEqual(v.blockers.map((b) => b.blocker), ["verification-gate"]);
    // 55 is the give-up cap, which this run earned by giving up. Not the 45 a hard
    // blocker would have forced, and the same run that keeps trying lands on its
    // full 15 + 20 + 25 for everything but the completion.
    assert.equal(v.score, 55);
    assert.equal(grade({ ...priced, gaveUp: false }).score, 60);
    assert.equal(grade({ ...priced, gaveUp: false }).grade, "C");
  });

  it("reads promotional copy on an earlier page as the newsletter pitch it is", () => {
    // The guard the last-page rule exists for. "Check your inbox" sells a mailing
    // list on a thousand front pages, and a page the agent walked straight past is
    // not the reason a later step failed.
    const newsletter = page({
      url: "https://example.com/",
      text: `${PROSE}\nSubscribe for product news. Check your inbox to confirm.`,
    });
    const passedThrough = transcript({
      perceptions: [newsletter, page({ url: "https://example.com/pricing", hasPrice: true })],
      stepCount: 3,
    });
    assert.ok(!blockers(passedThrough).includes("verification-gate"));
  });

  it("still names a wall the run walked past, when the page said it had sent one", () => {
    // Measured on console.groq.com/keys: "Check your email. An email was sent to
    // alex.morgan.<run>@example.com. Try again" was on screen at step 4 and again
    // at step 8, the run then went back to the docs, and the verdict read "without
    // hitting a specific blocker". A site reporting what it has just sent is not
    // selling a newsletter, so this half is read off every page.
    const sent = page({
      url: "https://console.groq.com/keys",
      title: "API Keys - GroqCloud",
      text: `${PROSE}\nCheck your email\nAn email was sent to alex.morgan.mtm87ve9-pw9ujo@example.com.`,
      elements: [el(1, "button", "Try again")],
    });
    const wandered = transcript({
      action: "integrate",
      perceptions: [sent, page({ url: "https://console.groq.com/docs/overview" })],
      stepCount: 10,
    });
    const v = grade(wandered);
    assert.equal(v.blockers[0]?.blocker, "verification-gate");
    assert.match(v.blockers[0]!.detail, /an email was sent to/);
  });

  it("says nothing when the agent got through it anyway", () => {
    // Through means a page that only a visitor with an account is shown. The wall
    // is still in the transcript, and a run that ended on it is charged for it; a
    // run that came out the other side is not.
    const through = transcript({
      action: "signup",
      perceptions: [
        page({ text: `${PROSE}\nAn email was sent to alex.morgan@example.com.` }),
        page({ url: "https://example.com/app", elements: [el(1, "button", "Log out")] }),
      ],
      declaredDone: true,
    });
    assert.ok(!blockers(through).includes("verification-gate"));
  });

  /**
   * The wall in front of the wall, in the words Groq's console uses: "Create an
   * account or login to access this page". The list it was tested against wanted
   * "log in to continue", so an API key an agent cannot obtain without an account
   * was graded as no obstacle at all.
   */
  it("names a page that gates itself, however it phrases the demand", () => {
    for (const copy of [
      "Create an account or login to access this page",
      "Please log in to access this page",
      "Sign in to access your dashboard",
    ]) {
      const gated = transcript({
        action: "integrate",
        perceptions: [page({ url: "https://console.groq.com/keys", text: `${PROSE}\n${copy}` })],
        stepCount: 4,
      });
      assert.ok(blockers(gated).includes("auth-gate"), copy);
    }
  });

  it("reads the controls too, for a page whose prose did not reach us", () => {
    // The live run this was written from ended on exactly this page and was graded
    // without a verification-gate, so the copy was not what the grader saw. The
    // buttons and links were.
    const noProse = page({
      url: "https://plausible.io/activate",
      title: "Plausible Analytics",
      text: "",
      elements: [el(1, "textbox", ""), el(2, "button", "Activate account"), el(3, "link", "Resend code", "#")],
    });
    const v = grade(transcript({ perceptions: [page(), noProse], gaveUp: true, stepCount: 9 }));
    assert.equal(v.blockers[0]?.blocker, "verification-gate");
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
    assert.match(v.summary, /within 1 step,/, "the failure sentence counts in English too");
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

/**
 * The only milestone the agent awards itself, and now the only one with evidence
 * behind it. Forty of the hundred points used to rest on the model's word about
 * its own run, on the same transcript the grader was built not to trust.
 */
describe("grade: a claim of having finished", () => {
  it("credits an integrate run that saw both halves of what it was sent for", () => {
    const t = transcript({
      action: "integrate",
      perceptions: [
        page({
          url: "https://docs.stripe.com/keys",
          title: "API keys",
          text: `${PROSE}\ncurl https://api.stripe.com/v1/charges\nYour secret key lives in the Dashboard.`,
        }),
      ],
      declaredDone: true,
    });
    const v = grade(t);
    assert.ok(v.milestones.includes("completed-action"));
    assert.equal(v.score, 100);
    assert.equal(v.grade, "A");
  });

  /*
   * Titled "Get started" rather than "API keys" on purpose. The haystack these
   * signs are read from includes the page title, so a page called "API keys" is
   * already telling an agent where the key comes from, and this fixture has to
   * lack that half for real to be measuring the thing it names.
   */
  it("withholds it from one that saw code and never saw where a key comes from", () => {
    const t = transcript({
      action: "integrate",
      perceptions: [
        page({
          url: "https://docs.stripe.com/get-started",
          title: "Get started",
          text: `${PROSE}\nnpm install stripe\nRead on for the concepts.`,
        }),
      ],
      declaredDone: true,
    });
    const v = grade(t);
    assert.ok(!v.milestones.includes("completed-action"));
    assert.match(v.summary, /reported finishing/);
    assert.match(v.summary, /route to an API key/);
  });

  /*
   * Taken off the page this was measured on. docs.stripe.com/keys is prose about
   * keys with no code anywhere on it, and it names sk_test_ and sk_live_ while
   * explaining which is which. Reading a key literal as a code example credited
   * the code half to a page that has none, which is the whole of what stands
   * between a claim and the points it claims.
   */
  it("does not read a key literal as a code example", () => {
    const t = transcript({
      action: "integrate",
      perceptions: [
        page({
          url: "https://docs.stripe.com/keys",
          title: "API keys",
          text: `${PROSE}\nSandbox keys start with sk_test_ and live keys with sk_live_.`,
        }),
      ],
      declaredDone: true,
    });
    assert.ok(!grade(t).milestones.includes("completed-action"));
    assert.match(grade(t).summary, /code example/);
  });

  /*
   * Also taken off a real page, and this time the model caught the grader rather
   * than the other way round. On docs.stripe.com/api/authentication?lang=python
   * the only code sign in the text is `pip install`, and asked whether it was
   * finished the model answered "click Python button to view a code example". It
   * was right: installing the SDK is not calling the API, and an install line used
   * to be worth the same 40 points as a cURL sample. The install still counts as
   * the key info the run came for, which is the other half of this test.
   */
  it("does not read an install line as the call that finishes an integrate run", () => {
    const t = transcript({
      action: "integrate",
      perceptions: [
        page({
          url: "https://docs.stripe.com/api/authentication?lang=python",
          title: "Authentication",
          text: `${PROSE}\npip install stripe\nAuthenticate with your secret key.`,
        }),
      ],
      declaredDone: true,
    });
    const v = grade(t);
    assert.ok(!v.milestones.includes("completed-action"));
    assert.ok(v.milestones.includes("found-key-info"), "an install is still what a developer came for");
    assert.match(v.summary, /code example calling the API/);
  });

  it("credits the same page once it shows a real call", () => {
    const t = transcript({
      action: "integrate",
      perceptions: [
        page({
          url: "https://docs.stripe.com/api/authentication",
          title: "Authentication",
          text: `${PROSE}\ncurl https://api.stripe.com/v1/charges\nAuthenticate with your secret key.`,
        }),
      ],
      declaredDone: true,
    });
    assert.ok(grade(t).milestones.includes("completed-action"), "the run this product's first A came from");
  });

  /*
   * The other half of the same question: what happens when the page showed a call
   * and we did not pass it on. `text` here is what a perception carries, and it is
   * trimmed to MAX_TEXT before it ever reaches the model or this function. Measured
   * across the runs recorded since the sidebar fix: 28 of 31 perceptions are still
   * at that cap, all of them on docs.stripe.com, which makes every judgement about
   * those pages a judgement about a prefix. `hasCode` is read off the untrimmed
   * document so the answer to "did this site show a developer a call" stops
   * depending on how many characters our prompt budget could afford.
   */
  it("credits a call the page carried but our trimming cut off", () => {
    const t = transcript({
      action: "integrate",
      perceptions: [
        page({
          url: "https://docs.stripe.com/api/authentication",
          title: "Authentication",
          // No call sign anywhere in the prose the model was shown.
          text: `${PROSE}\nAuthenticate with your secret key.`,
          hasCode: true,
        }),
      ],
      declaredDone: true,
    });
    const v = grade(t);
    assert.ok(v.milestones.includes("completed-action"));
    // The proof string is what a refusal quotes, so it is read off directly here:
    // it has to name the page rather than quote a sign, because there was no sign
    // in the text to quote.
    assert.match(endStateSeen(t)!, /a code example on the page/);
    assert.equal(v.grade, "A");
  });

  it("still needs the key half, so a page of code alone does not finish the run", () => {
    const t = transcript({
      action: "integrate",
      perceptions: [
        page({
          url: "https://docs.stripe.com/get-started",
          title: "Get started",
          text: `${PROSE}\nRead on for the concepts.`,
          hasCode: true,
        }),
      ],
      declaredDone: true,
    });
    const v = grade(t);
    assert.ok(!v.milestones.includes("completed-action"));
    assert.match(v.summary, /route to an API key/);
  });

  it("credits the key info an integrate run came for from the untrimmed page too", () => {
    // Nothing in the trimmed text: no call, no install, no named route to a key.
    // Before hasCode existed this page was worth 35, and the 20 points it was
    // missing were ours to give, not the site's to earn back.
    const cut = page({ text: PROSE, hasCode: true });
    assert.ok(grade(transcript({ action: "integrate", perceptions: [cut] })).milestones.includes("found-key-info"));
  });

  it("leaves a run recorded before hasCode existed exactly where it was", () => {
    // The 33 stored runs and both shipped examples carry no hasCode at all, and
    // absent must keep meaning "we did not measure" rather than "there was none".
    const t = transcript({
      action: "integrate",
      perceptions: [
        page({
          url: "https://docs.stripe.com/api/authentication",
          title: "Authentication",
          text: `${PROSE}\nAuthenticate with your secret key.`,
        }),
      ],
      declaredDone: true,
    });
    const v = grade(t);
    assert.ok(!v.milestones.includes("completed-action"), "no call in the text, and none reported off the page");
    assert.match(v.summary, /code example calling the API/);
  });

  it("takes the payment step as the end of a purchase, by its fields or by its URL", () => {
    const fields = transcript({
      action: "purchase",
      perceptions: [page({ hasPrice: true, text: `${PROSE} Card number` })],
      declaredDone: true,
    });
    assert.ok(grade(fields).milestones.includes("completed-action"));

    const byUrl = transcript({
      action: "purchase",
      perceptions: [page({ url: "https://example.com/checkout", hasPrice: true })],
      declaredDone: true,
    });
    assert.ok(grade(byUrl).milestones.includes("completed-action"), "iframed card fields never reach the tree");

    const shelf = transcript({
      action: "purchase",
      perceptions: [page({ url: "https://example.com/product/mug", hasPrice: true })],
      declaredDone: true,
    });
    assert.ok(!grade(shelf).milestones.includes("completed-action"), "a product page is not a checkout");
  });

  /**
   * The wall the `signup` task was rewritten to stop calling a success: a page
   * asking for a code out of an inbox, however cheerfully it words it.
   */
  it("refuses a signup that ended holding out for a code, whatever else the page says", () => {
    const t = transcript({
      action: "signup",
      perceptions: [
        page({ elements: [el(1, "link", "Sign up", "/signup")], hasPrice: true }),
        page({
          url: "https://example.com/verify",
          title: "Check your email",
          text: `${PROSE} You're all set. Enter the code we sent.`,
          elements: [el(1, "button", "Activate account")],
        }),
      ],
      declaredDone: true,
    });
    const v = grade(t);
    assert.ok(!v.milestones.includes("completed-action"));
    assert.equal(v.blockers[0]?.blocker, "verification-gate", "and the wall is charged, not suppressed");
    assert.equal(v.score, 60);
  });

  it("takes a booking as submitted when the press landed after real work", () => {
    const form = () =>
      page({
        url: "https://example.com/book",
        text: `${PROSE} Available Mon to Fri, 9am to 5pm`,
        elements: [el(1, "button", "Send booking")],
      });
    const submitted = transcript({
      action: "book",
      perceptions: [form(), form()],
      declaredDone: true,
      operated: ['click "Book a table"', 'type "Ada Lovelace"', 'click "Send booking"'],
    });
    assert.ok(grade(submitted).milestones.includes("completed-action"), "silence is an answer here");

    const glanced = transcript({
      action: "book",
      perceptions: [form()],
      declaredDone: true,
      operated: ['click "Book now"'],
    });
    assert.ok(!grade(glanced).milestones.includes("completed-action"), "the way to a form is not a booking");
  });

  it("takes the site's own receipt as the end of a booking however it got there", () => {
    const t = transcript({
      action: "book",
      perceptions: [page({ text: `${PROSE} Thanks. We have received your request and we will be in touch.` })],
      declaredDone: true,
    });
    assert.ok(grade(t).milestones.includes("completed-action"));
  });

  it("reads a composed message off the control that holds it", () => {
    const withMessage = (value?: string) =>
      transcript({
        action: "contact",
        perceptions: [
          page({
            url: "https://example.com/contact",
            elements: [
              { index: 1, role: "textbox", name: "Your message", ...(value ? { value } : {}) },
              el(2, "button", "Send"),
            ],
          }),
        ],
        declaredDone: true,
      });
    assert.ok(grade(withMessage("I would like a quote for 40 units.")).milestones.includes("completed-action"));
    assert.ok(!grade(withMessage()).milestones.includes("completed-action"), "an empty box is not a message");
  });

  /**
   * What an unsupported claim costs, and what it must not cost. The model
   * misreporting its own run is our failure, so it produces no finding against the
   * site: everything the run really did reach is still credited, and the sentence
   * the owner reads says which end state was missing.
   */
  it("keeps what was reached, files no blocker, and says which end state was missing", () => {
    const t = transcript({
      action: "signup",
      perceptions: [page({ hasPrice: true, elements: [el(1, "link", "Sign up free", "/signup")] })],
      declaredDone: true,
      stepCount: 6,
    });
    const v = grade(t);
    assert.deepEqual(v.milestones.sort(), ["found-cta", "found-key-info", "understood-offering"]);
    assert.deepEqual(v.blockers, [], "a model's bad report is not the site's finding");
    assert.equal(v.score, 60);
    assert.equal(v.grade, "C");
    assert.match(v.summary, /no account, and no page saying one had been created/);
    assert.match(v.summary, /Graded as unfinished/);
  });

  it("says nothing of the kind when no claim was made", () => {
    const v = grade(transcript({ perceptions: [page({ hasPrice: true })] }));
    assert.ok(!v.summary.includes("reported finishing"));
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

  it("says in the summary that our side stopped it, and why", () => {
    const v = grade(
      transcript({
        action: "purchase",
        perceptions: [reached()],
        stepCount: 5,
        abandoned: "Groq rate limit reached",
      }),
    );
    assert.match(v.summary, /^No grade: our side stopped this run/);
    assert.match(v.summary, /Groq rate limit reached/);
    assert.match(v.summary, /never put to the test/);
  });

  it("withholds the letter, because the points for finishing were never winnable", () => {
    // Measured on run 8 of docs.stripe.com: our free-tier daily token allowance
    // ran out at step 3 of a 14-step budget and the card published C 60, a grade
    // about our billing wearing Stripe's name.
    const v = grade(
      transcript({
        action: "integrate",
        perceptions: [reached()],
        stepCount: 3,
        abandoned: "Groq rate limit reached: the wait it asked for (152s) is longer than this run can spare",
      }),
    );
    assert.equal(v.cutShort, "Groq rate limit reached: the wait it asked for (152s) is longer than this run can spare");
    assert.equal(v.inconclusive, undefined, "it did reach the site, so there is something to report");
    assert.ok(v.milestones.length > 0, "what it saw before we stopped it still counts");
  });

  it("keeps the letter when the agent itself gave up", () => {
    // A choice the agent made is a finding. Only our own interruptions are not.
    const v = grade(
      transcript({
        action: "purchase",
        perceptions: [reached()],
        stepCount: 5,
        gaveUp: true,
        abandoned: "Groq rate limit reached",
      }),
    );
    assert.equal(v.cutShort, undefined);
    assert.equal(v.grade, "C");
  });

  it("says nothing about being cut short on a run that finished normally", () => {
    const v = grade(transcript({ action: "purchase", perceptions: [reached()] }));
    assert.equal(v.cutShort, undefined);
    assert.ok(!v.summary.includes("No grade"));
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
    assert.ok(!v.summary.includes("our side stopped"));
  });
});

describe("grade: a run that never reached the site", () => {
  it("returns no verdict rather than an F when our side never got a browser", () => {
    // Seen live: Solari answered 503 twice, the run died before the first
    // perception, and the site was handed F/0 with "the page never loaded".
    const v = grade(
      transcript({
        perceptions: [],
        stepCount: 0,
        abandoned: "Solari answered 503 to every attempt",
      }),
    );
    assert.equal(v.inconclusive, true);
    assert.deepEqual(v.blockers, [], "nothing observed, so nothing to charge");
    assert.match(v.summary, /^No verdict/);
    assert.match(v.summary, /503/);
  });

  it("still blames the site when the site itself never answered", () => {
    const v = grade(transcript({ perceptions: [], stepCount: 0 }));
    assert.equal(v.inconclusive, undefined);
    assert.ok(v.blockers.some((b) => b.blocker === "nav-error"));
    assert.equal(v.grade, "F");
  });
});
