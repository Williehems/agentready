import type {
  ActionKind,
  BlockerHit,
  Grade,
  Milestone,
  Perception,
  Verdict,
} from "./types";
import { ACTIONS, handoffLabel, isDeadEndHref } from "./actions";
import { fingerprint } from "./perceive";

/**
 * Grading is deterministic on purpose. The agent loop produces a transcript;
 * this reads it. No second LLM call, because a model asked to grade its own
 * transcript will flatter it, and because a grade that moves between identical
 * runs is worthless as evidence.
 */

export interface Transcript {
  action: ActionKind;
  startUrl: string;
  /** Every perception the agent took, in order. */
  perceptions: Perception[];
  /** Whether the model ended by declaring success. */
  declaredDone: boolean;
  /** Whether the model gave up explicitly. */
  gaveUp: boolean;
  /**
   * Moves that landed, in order, written as `click "Send booking"`.
   *
   * Evidence for the kind of finish a page cannot show on its own: a booking
   * submitted and met with silence is a finished booking by that task's own terms,
   * and the press is the only record there is of it.
   */
  operated?: string[];
  /** Steps that failed to execute, with their error text. */
  failures: string[];
  stepCount: number;
  /** True when a launch fell back off stealth, which weakens bot-wall claims. */
  stealth: boolean;
  /**
   * URLs the site opened in a tab of its own, in the order they appeared.
   *
   * A button is not a link, and a site whose conversion runs through
   * `onclick="sendToWhatsApp()"` has no href for anyone to inspect. Measured on a
   * live booking form: nine steps of a working modal, then the submit opened
   * api.whatsapp.com in a second tab, left the first tab on the home page, and
   * said nothing anywhere about whether the booking had been received. The href
   * test saw nothing to charge and the run came back "no blockers", which is the
   * grader missing the one thing that mattered.
   */
  handoffs?: string[];
  /**
   * Whether the site's front page shows a price as selectable text, or nothing
   * when we could not look.
   *
   * The audit starts wherever the caller points it, and where it starts must not
   * move the grade. Measured twice on plausible.io: from the home page it earned
   * found-key-info and scored C 55, and from /register it was charged
   * no-structured-price and scored D 40. Same site, same published prices in
   * euros, 15 points apart because of a URL we chose. So when the flow never
   * passes a price, the front page is asked directly once the flow is over.
   *
   * Three states, all meaningful. True or false is an answer we obtained.
   * Undefined means the check could not run, and then no price blocker is filed
   * at all: charging a site for what we were unable to see is the one kind of
   * wrong finding this cannot afford.
   */
  priceOnHome?: boolean;
  /**
   * Set when the run ended for a reason of ours, not the site's: our model quota,
   * our timeout, our budget. It never adds a blocker and never caps the score,
   * because the site did not do it. It does say so in the summary, since a grade
   * from a truncated run is a floor and reading it as a ceiling is unfair.
   */
  abandoned?: string;
}

const BOT_WALL_SIGNS = [
  "access denied",
  "are you a robot",
  "are you a human",
  "verify you are human",
  "unusual traffic",
  "automated traffic",
  "blocked",
  "forbidden",
  "cloudflare",
  "checking your browser",
  "just a moment",
  "enable javascript and cookies",
  "request blocked",
  "bot detected",
  "captcha",
];

const CAPTCHA_SIGNS = ["captcha", "recaptcha", "hcaptcha", "turnstile", "i'm not a robot"];

/**
 * The same wall in the words no site uses for anything else: a second-person
 * statement that a message has already been sent to this visitor.
 *
 * Read off every page the run reached rather than only the one it ended on, which
 * is what separates these from the list above. Measured on console.groq.com/keys:
 * "Check your email. An email was sent to alex.morgan.<run>@example.com. Try
 * again" was on screen twice, at step 4 and again at step 8, and because the run
 * wandered back to the docs afterwards the verdict read "without hitting a
 * specific blocker". An agent cannot open that email, so it was the whole story.
 *
 * These stay narrow by being transactional rather than promotional. "Check your
 * inbox" sells a newsletter on a thousand front pages; "an email was sent to" is
 * a site reporting what it just did.
 */
const VERIFY_SENT_SIGNS = [
  "an email was sent to",
  "we sent an email to",
  "we sent you an email",
  "we've sent an email",
  "we have sent an email",
  "we emailed you a link",
  "we sent a sign-in link",
  "we sent a login link",
];

const AUTH_SIGNS = [
  "sign in to continue",
  "log in to continue",
  "please log in",
  "login required",
  "members only",
  // Measured on console.groq.com/keys, the page an agent must reach to obtain an
  // API key: "Create an account or login to access this page". A wall that names
  // itself that plainly was passing through the grader unnoticed.
  "to access this page",
  "login to access",
  "log in to access",
  "sign in to access",
];

/**
 * A wall that asks for something only a human with an inbox or a phone can hand
 * over: a code mailed or texted to an address, entered back into the page.
 *
 * Drawn from the page that prompted this, screenshot 05 of the plausible.io run:
 * "Check your email", "We've sent an email with your code to: ...", a masked
 * four-box code field, "Activate account", "Didn't receive it? Resend code".
 * The rest are the same wall in other companies' wording.
 *
 * Phrases, not words. "code" alone appears in every developer site on earth and
 * "verify" appears in the bot-wall list next door.
 */
const VERIFY_SIGNS = [
  "check your email",
  "check your inbox",
  "with your code",
  "code we sent",
  "code sent to",
  "verification code",
  "confirmation code",
  "activation code",
  "enter the code",
  "resend code",
  "one-time code",
  "one-time password",
  "confirm your email address",
  "verify your email address",
  "we sent a text",
  "sent you a text",
  "activate account",
  "activate your account",
];

/**
 * One page as everything it says: title, prose, and the names of its controls.
 *
 * The controls are in here because the prose is not always there to read. The run
 * that prompted this ended on a page whose heading was "Check your email" and got
 * no verification-gate, so something about that page did not reach the grader as
 * text, while its buttons ("Activate account") and links ("Resend code") came
 * through as elements. A wall is identified as reliably by its controls as by its
 * copy, and reading both costs nothing.
 */
function pageText(p: Perception): string {
  return [p.title, p.text, ...p.elements.map((e) => e.name)].join("\n").toLowerCase();
}

function textOf(t: Transcript): string {
  return t.perceptions.map((p) => `${p.title}\n${p.text}`).join("\n").toLowerCase();
}

/** Did the agent reach a URL or CTA that belongs to the requested action? */
function foundCta(t: Transcript): { found: boolean; deadEndOnly: boolean } {
  const spec = ACTIONS[t.action];
  let sawRealCta = false;
  let sawDeadEnd = false;

  for (const p of t.perceptions) {
    if (spec.urlHints.some((h) => p.url.toLowerCase().includes(h))) sawRealCta = true;
    for (const el of p.elements) {
      const name = el.name.toLowerCase();
      if (!spec.ctaHints.some((h) => name.includes(h))) continue;
      if (isDeadEndHref(el.href)) sawDeadEnd = true;
      else sawRealCta = true;
    }
  }
  return { found: sawRealCta || sawDeadEnd, deadEndOnly: sawDeadEnd && !sawRealCta };
}

/** A site whose every outbound link is a handoff scheme cannot be used by a machine. */
function allLinksAreDeadEnds(t: Transcript): boolean {
  const links = t.perceptions.flatMap((p) => p.elements.filter((e) => e.role === "link" && e.href));
  if (links.length < 3) return false;
  return links.every((l) => isDeadEndHref(l.href));
}

/**
 * The first tab the site opened that a browser agent cannot follow.
 *
 * about:blank is skipped: every popup starts there before its real URL arrives,
 * and a tab still holding it tells us nothing either way.
 */
function deadEndHandoff(t: Transcript): string | undefined {
  return (t.handoffs ?? []).find((u) => u && !u.startsWith("about:") && isDeadEndHref(u));
}

/**
 * The call half of what an `integrate` run is sent to find, the other being
 * KEY_ROUTE_SIGNS below.
 *
 * A call sign has to be something no ordinary sentence contains, because this is
 * the half that decides whether a claim of having finished stands. `sk_test` and
 * `sk_live` were in this list and are not any more: they are key literals, so on
 * docs.stripe.com/keys they credited a code example to a page whose prose is
 * entirely about keys and carries no code at all. Checked against the 25 stored
 * runs, that one entry was the whole of the false crediting. `import ` came out
 * for the same reason at a lower rate, since a marketing page will happily say
 * "import your contacts"; the bracketed and quoted forms below cannot be said
 * except in code.
 */
const CALL_SIGNS = [
  "curl ", "authorization: bearer", "require(", "fetch(", "import {", 'from "',
];

/**
 * Getting the SDK onto the machine, which is not the same as using it.
 *
 * These used to sit in the list above, and the model caught us at it. On
 * docs.stripe.com/api/authentication?lang=python the only code sign in the page
 * text is `pip install`, and asked whether it was finished the model answered
 * "click Python button to view a code example" instead of done. It was right: an
 * install line is not the copyable call the task asks for, and had it said done
 * we would have paid the 40 points for finishing against a dependency command.
 * So an install still counts as the key info an integrate run needs to have
 * found, and it no longer corroborates a claim of having finished. The A on that
 * same page without the query string is unaffected: its sign is `curl `.
 */
const INSTALL_SIGNS = [
  "npm install", "pip install", "pip3 install", "yarn add", "pnpm add",
  "go get ", "composer require", "gem install", "dotnet add package",
];

const KEY_ROUTE_SIGNS = [
  "api key", "secret key", "publishable key", "access token", "bearer token",
  "client secret", "personal access token",
];

/** The payment step, in the words checkout pages use for it. */
const CHECKOUT_SIGNS = [
  "card number", "credit card", "debit card", "cardholder", "cvv", "cvc",
  "expiry", "expiration date", "billing address", "payment method",
  "order summary", "pay now", "place order", "complete purchase",
  "proceed to payment", "secure checkout",
];

const CHECKOUT_URLS = ["checkout", "/cart", "payment", "/order", "/pay"];

/**
 * The key info an `integrate` run came for: any code at all, or a named way to a
 * key. Deliberately wider than what corroborates a finish, since an install line
 * is part of what a developer is looking for even though it does not show the API
 * being called. Read off the lists rather than a hardcoded npm-and-pip pair, so a
 * Go or PHP page is credited for the same thing a Node or Python one already was.
 */
function integrateKeyInfo(text: string): boolean {
  if (text.includes("```")) return true;
  const signs = CALL_SIGNS.concat(INSTALL_SIGNS, KEY_ROUTE_SIGNS);
  return signs.some((s) => text.includes(s));
}

/**
 * A control only a visitor with an account is offered. A fresh browser is never
 * given a way out of a session it does not have, which is what makes this the one
 * cheap proof that a signup worked.
 */
const SIGNED_IN_SIGNS = ["log out", "logout", "sign out", "signout"];

const ACCOUNT_MADE_SIGNS = [
  "account created", "account has been created", "your account is ready",
  "welcome to your dashboard", "you're all set", "you are all set",
  "registration complete", "registration successful",
];

/**
 * A site saying something has reached it. Receipts only: no bare "thank you",
 * which sits in footers on pages where nothing was submitted at all.
 */
const RESPONSE_SIGNS = [
  "we have received", "we've received", "we have your request", "request received",
  "booking received", "message received", "booking confirmed", "appointment confirmed",
  "your booking is", "your appointment is", "we will be in touch", "we'll be in touch",
  "we will get back to you", "we'll get back to you", "successfully booked",
  "reference number", "confirmation number",
];

/** Words that make a control the one that sends a booking rather than one on the way to it. */
const SUBMIT_WORDS = ["submit", "send", "book", "confirm", "request", "reserve", "schedule"];


/**
 * The evidence for the one milestone the agent awards itself, or nothing when the
 * pages it saw never showed it.
 *
 * `done` is the model's own word about its own work, and it carries 40 of the 100
 * points. Every other milestone here is read off what was on screen; this one was
 * not, which left the score only as honest as the model's account of itself. In 24
 * runs the milestone has never been awarded, so no measured pass is being taken
 * away. What is being closed is the hole a model could walk an A through by
 * declaring done on a page that showed nothing of the kind.
 *
 * Generous on purpose, because the opposite mistake is just as bad: each test
 * below is the ordinary end state of its own task in the words real pages use for
 * it. A claim that cannot be corroborated costs the 40 points and is said plainly
 * in the summary, and it is never turned into a finding against the site, because
 * a model misreporting its own run is our failure and not the site's.
 */
export function endStateSeen(t: Transcript): string | undefined {
  const last = t.perceptions[t.perceptions.length - 1];
  if (!last) return undefined;
  const here = pageText(last);
  const everywhere = t.perceptions.map(pageText).join("\n");
  const landed = t.operated ?? [];
  const sign = (hay: string, signs: string[]) => signs.find((s) => hay.includes(s));
  const receipt = sign(here, RESPONSE_SIGNS);

  switch (t.action) {
    case "integrate": {
      // The call, not the install. An `npm install` on the page says a developer
      // could get started; it does not show the API being used, and this is the
      // check that decides whether 40 points for finishing are paid out.
      //
      // Two ways of having seen it, because the trimmed text is not the page. A
      // sign quoted out of `everywhere` is a call the model was shown; `hasCode`
      // is a call the page carried, read off the whole document before the text
      // was trimmed. 28 of the 31 perceptions taken since the sidebar fix are
      // still at the 2800 cap, every one of them on docs.stripe.com, so on those
      // pages the first route answers about a prefix and the second about a page.
      //
      // The second route cannot invent a quote, and it is not given one. A run
      // credited this way says "a code example on the page" instead, because the
      // honest form of that sentence is the one that does not pretend to have the
      // line in hand.
      const code = sign(everywhere, CALL_SIGNS);
      const carried = t.perceptions.some((p) => p.hasCode);
      const key = sign(everywhere, KEY_ROUTE_SIGNS);
      if (!key || !(code || carried)) return undefined;
      return `${
        code ? `a code example ("${code.trim()}")` : "a code example on the page"
      } and a route to a key ("${key}")`;
    }
    case "purchase": {
      const step = sign(here, CHECKOUT_SIGNS);
      if (step) return `the payment step ("${step}")`;
      const url = CHECKOUT_URLS.find((u) => last.url.toLowerCase().includes(u));
      return url ? `the checkout page (${last.url})` : undefined;
    }
    case "signup": {
      // A page holding out for a code from an inbox is a wall, not an account,
      // whatever else it says on it. See VERIFY_SIGNS for the run that prompted it.
      if (VERIFY_SIGNS.some((s) => here.includes(s))) return undefined;
      const out = sign(here, SIGNED_IN_SIGNS);
      if (out) return `a session of its own ("${out}")`;
      const made = sign(here, ACCOUNT_MADE_SIGNS);
      return made ? `the site saying so ("${made}")` : undefined;
    }
    case "book": {
      if (receipt) return `the site's answer ("${receipt}")`;
      // Submitting and being told nothing is a finished booking by this task's own
      // terms, so the press itself is the evidence. Guarded on the run having done
      // some work first, because a "Book now" in the nav clicked at step 1 is the
      // way to a booking form and not a booking.
      const pressed = landed.find(
        (m) => m.startsWith("click ") && SUBMIT_WORDS.some((w) => m.toLowerCase().includes(w)),
      );
      return pressed && landed.length >= 3 ? `a booking pressed through (${pressed})` : undefined;
    }
    case "contact": {
      // The typed message, read off the control that holds it. This is the whole
      // of what the task asks for, since it stops short of sending.
      const filled = last.elements.find((e) => e.role === "textbox" && e.value);
      if (filled) return `a message typed into ${filled.role} "${filled.name}"`;
      return receipt ? `the site's answer ("${receipt}")` : undefined;
    }
  }
}

export function grade(t: Transcript): Verdict {
  const text = textOf(t);
  const blockers: BlockerHit[] = [];
  const milestones: Milestone[] = [];
  const spec = ACTIONS[t.action];

  const firstPerception = t.perceptions[0];
  const everGated = t.perceptions.some((p) => p.jsGated);
  const alwaysGated = t.perceptions.length > 0 && t.perceptions.every((p) => p.jsGated);

  /**
   * Whether the run finished, as opposed to having said it did. Everything that
   * used to read `declaredDone` reads this instead: a claim we cannot see the end
   * state for suppresses no blocker either, since the walls it would hide are
   * exactly the walls a false claim is made in front of.
   */
  const proof = t.declaredDone ? endStateSeen(t) : undefined;
  const finished = t.declaredDone && proof !== undefined;

  // --- blockers ---

  if (alwaysGated || (everGated && t.perceptions.length === 1)) {
    blockers.push({
      blocker: "js-gate",
      detail:
        "The accessibility tree came back empty. A machine visitor reading this page sees nothing to act on.",
    });
  }

  const captchaSign = CAPTCHA_SIGNS.find((s) => text.includes(s));
  if (captchaSign) {
    blockers.push({ blocker: "captcha", detail: `A challenge was presented ("${captchaSign}").` });
  }

  const botSign = BOT_WALL_SIGNS.find((s) => text.includes(s));
  if (botSign && !captchaSign) {
    blockers.push({
      blocker: "bot-wall",
      detail: t.stealth
        ? `The site served an interstitial to a stealth browser ("${botSign}").`
        : `The site served an interstitial ("${botSign}"). Stealth was unavailable for this run, so a real agent may fare better.`,
    });
  }

  const cta = foundCta(t);
  const handoff = deadEndHandoff(t);
  if (cta.deadEndOnly || allLinksAreDeadEnds(t) || handoff) {
    blockers.push({
      blocker: "dead-end-cta",
      detail: handoff
        ? `The site handed the action off to ${handoffLabel(handoff)} in a separate tab. A browser agent cannot follow it, so the action cannot be finished in the browser.`
        : "The only route to the action hands off to WhatsApp, phone, or email. A browser agent cannot follow it, so the visit ends here.",
    });
  }

  // The flow asked for a code out of an inbox. Measured on plausible.io: the run
  // filled the form, submitted it, landed on "Check your email", and was graded
  // D with no-structured-price as the primary blocker, sending the reader off to
  // look at pricing copy when what stopped the agent was an email code.
  //
  // Read off the last page only, not the whole transcript. These phrases are
  // ordinary marketing copy elsewhere ("check your inbox for our newsletter"),
  // and it is the run ending on such a page that is the evidence. Costs recall on
  // a run that wanders one step past the wall, which is the right trade: a
  // finding pointing at the wrong wall is worse than one we did not file.
  //
  // Soft on purpose. Emailing a code is normal and defensible, so it earns no
  // cap; without completed-action the score already tops out at 60. What it
  // changes is the sentence the owner reads.
  const lastPerception = t.perceptions[t.perceptions.length - 1];
  const verifySign = lastPerception ? VERIFY_SIGNS.find((s) => pageText(lastPerception).includes(s)) : undefined;
  // The transactional half, which does not need the run to have ended there. See
  // VERIFY_SENT_SIGNS for the run that went past this wall twice and was graded as
  // having met nothing.
  const pages = t.perceptions.map(pageText);
  const sentSign = VERIFY_SENT_SIGNS.find((s) => pages.some((page) => page.includes(s)));
  if ((verifySign || sentSign) && !finished) {
    blockers.push({
      blocker: "verification-gate",
      detail: `The flow required something only an inbox or a phone can supply ("${verifySign ?? sentSign}"): a code to read back, or a link to open. An agent has neither, so the action ends here however good the rest of the site is.`,
    });
  }

  // Guarded on having looked at all: with no perception the price test is
  // vacuously true, and a run that never loaded the page would be charged for a
  // missing price it was never in a position to see.
  //
  // `priceChecked` is the other half of that guard, one step further out. A flow
  // that never passed a price is not evidence of a site without prices, so the
  // front page is asked after the fact; only a front page that answered turns
  // silence into a finding.
  const priceSeen = t.perceptions.some((p) => p.hasPrice) || t.priceOnHome === true;
  const priceChecked = t.perceptions.some((p) => p.hasPrice) || t.priceOnHome !== undefined;
  if (
    firstPerception &&
    (t.action === "purchase" || t.action === "signup") &&
    priceChecked &&
    !priceSeen
  ) {
    blockers.push({
      blocker: "no-structured-price",
      detail:
        "No price appeared as selectable text. If it only exists inside an image, it does not exist to a machine.",
    });
  }

  if (AUTH_SIGNS.some((s) => text.includes(s)) && !finished) {
    blockers.push({
      blocker: "auth-gate",
      detail: "An account was required before the action could be reached.",
    });
  }

  if (t.failures.length >= 2 && !finished) {
    blockers.push({
      blocker: "form-stall",
      detail: `The agent could not operate ${t.failures.length} elements it selected: ${t.failures
        .slice(0, 2)
        .join("; ")}`,
    });
  }

  // Four consecutive perceptions of an unchanged page, with no success, is a
  // stuck loop. Unchanged means the whole page state, not just the address.
  //
  // Not claimed on a run we cut short ourselves. When our own actuator stops
  // landing clicks the page cannot change, and reading that back as the site
  // going in circles blames it for our failure. Seen live: three hung clicks in
  // a row produced four identical perceptions of a working booking form.
  if (!finished && !t.abandoned && t.perceptions.length >= 4) {
    const tail = t.perceptions.slice(-4).map(fingerprint);
    if (new Set(tail).size === 1) {
      blockers.push({
        blocker: "loop",
        detail: "The agent kept acting without the page ever changing.",
      });
    }
  }

  // Nothing was ever perceived. Either the site never answered, which is its
  // finding, or we never got a browser to look with, which is ours: a run that
  // never reached the site is reported as no verdict rather than an F.
  const neverArrived = !firstPerception;
  if (neverArrived && !t.abandoned) {
    blockers.push({ blocker: "nav-error", detail: "The page never loaded." });
  }

  // --- milestones ---

  // Understood the offering: enough prose to say what this is.
  if (firstPerception && !alwaysGated && text.replace(/\s+/g, " ").length > 400) {
    milestones.push("understood-offering");
  }
  // Found the key info this action depends on. The price half reads `priceSeen`
  // rather than the perceptions alone, so that a site which publishes its prices
  // is credited for them whether or not the URL we picked happened to pass one.
  if (
    priceSeen ||
    (t.action === "integrate" && (integrateKeyInfo(text) || t.perceptions.some((p) => p.hasCode))) ||
    (t.action === "contact" && /@|contact/.test(text) && !cta.deadEndOnly && !handoff) ||
    (t.action === "book" && /\b(mon|tue|wed|thu|fri|sat|sun)\w*\b|\bam\b|\bpm\b|available/.test(text))
  ) {
    milestones.push("found-key-info");
  }
  if (cta.found && !cta.deadEndOnly) milestones.push("found-cta");
  if (finished) milestones.push("completed-action");

  // --- score ---

  const weights: Record<Milestone, number> = {
    "understood-offering": 15,
    "found-key-info": 20,
    "found-cta": 25,
    "completed-action": 40,
  };
  let score = milestones.reduce((s, m) => s + weights[m], 0);

  // Hard blockers cap the grade regardless of what else was reached: a site a
  // machine cannot enter has not earned a pass on presentation.
  const hard = new Set(["js-gate", "bot-wall", "captcha", "dead-end-cta"]);
  const hardHit = blockers.filter((b) => hard.has(b.blocker));
  if (hardHit.length) score = Math.min(score, 45);
  if (t.gaveUp) score = Math.min(score, 55);

  const letter: Grade =
    score >= 88 ? "A" : score >= 72 ? "B" : score >= 55 ? "C" : score >= 35 ? "D" : "F";

  const inconclusive = neverArrived && Boolean(t.abandoned);

  // Arrived, then we stopped it. The milestones above were observed and they
  // stand; the letter does not, because `completed-action` is worth 40 of the
  // 100 points and this run was never allowed to try for them. Measured: our
  // free-tier daily token allowance ran out at step 3 of a 14-step budget on
  // docs.stripe.com and the verdict came back C 60, which is a grade about our
  // billing wearing the site's name.
  //
  // Only when the run neither finished nor quit of its own accord: a run that
  // declared done had its chance and a run that gave up made a choice, and
  // withholding the letter from either would hide a real finding.
  const cutShort =
    !inconclusive && t.abandoned && !t.declaredDone && !t.gaveUp ? t.abandoned : undefined;

  return {
    grade: letter,
    score,
    milestones,
    blockers,
    steps: t.stepCount,
    summary: summarise(
      letter,
      t,
      milestones,
      blockers,
      spec.label,
      inconclusive,
      Boolean(cutShort),
      t.declaredDone && !finished,
    ),
    ...(inconclusive ? { inconclusive: true as const } : {}),
    ...(cutShort ? { cutShort } : {}),
  };
}

/** What would have counted as finishing, said in one clause a site owner can check. */
const END_STATE_WANTED: Record<ActionKind, string> = {
  signup: "no account, and no page saying one had been created",
  purchase: "no checkout or payment step",
  integrate: "not both a code example calling the API and a stated route to an API key",
  book: "no booking submitted, and no answer from the site",
  contact: "no contact form holding a typed message",
};

/**
 * "1 step", not "1 steps".
 *
 * The best result this product can report is a site an agent finishes with on its
 * first move, and that is the one sentence the old template got wrong. Seen on
 * docs.stripe.com/api/authentication: "An AI agent completed "integrate the api"
 * in 1 steps." A grade nobody trusts the grammar of is a grade nobody quotes.
 */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function summarise(
  letter: Grade,
  t: Transcript,
  milestones: Milestone[],
  blockers: BlockerHit[],
  actionLabel: string,
  inconclusive = false,
  cutShort = false,
  unsupported = false,
): string {
  const task = actionLabel.toLowerCase();

  /**
   * Said whenever it applies, and never as a finding against the site. The agent
   * reporting a finish nobody can see is our failure to report honestly, and the
   * reader is owed the reason those 40 points are missing.
   */
  const disputed = unsupported
    ? ` The agent reported finishing and what it saw does not bear that out: ${END_STATE_WANTED[t.action]}. Graded as unfinished.`
    : "";

  if (inconclusive) {
    return `No verdict: the run never reached the site (${t.abandoned}), so there is nothing to grade. Nothing here is a finding about ${task}.`;
  }
  // Before the branches that read as findings, because a run our side stopped is
  // not a finding. Every other abandonment either never arrived, and is caught
  // above, or ended on the agent's own terms, and keeps its letter.
  if (cutShort) {
    const got = milestones.length
      ? `It got as far as ${milestones.length} of 4 checkpoints in ${count(t.stepCount, "step")}`
      : `It reached no checkpoint in ${count(t.stepCount, "step")}`;
    return `No grade: our side stopped this run before it could finish (${t.abandoned}). ${got}, and whether it could have completed "${task}" was never put to the test.`;
  }
  if (milestones.includes("completed-action")) {
    return `An AI agent completed "${task}" in ${count(t.stepCount, "step")}.${
      blockers.length ? ` It worked, but it had to get past ${count(blockers.length, "obstacle")} on the way.` : ""
    }`;
  }
  const primary = blockers[0];
  if (primary) {
    const where = milestones.includes("found-cta")
      ? "It found the right button and still could not finish"
      : milestones.includes("understood-offering")
        ? "It understood what you sell but never reached the action"
        : "It could not even read what you sell";
    return `An AI agent failed to ${task}. ${where}. Primary blocker: ${primary.blocker}.${disputed}`;
  }
  return `An AI agent failed to ${task} within ${count(t.stepCount, "step")}, without hitting a specific blocker. Grade ${letter}.${disputed}`;
}
