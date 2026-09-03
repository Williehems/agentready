import type {
  ActionKind,
  BlockerHit,
  Grade,
  Milestone,
  Perception,
  Verdict,
} from "./types";
import { ACTIONS, handoffLabel, isDeadEndHref } from "./actions";

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

const AUTH_SIGNS = ["sign in to continue", "log in to continue", "please log in", "login required", "members only"];

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
function lastPage(p: Perception): string {
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
 * What the agent was looking at, reduced to something comparable.
 *
 * The URL alone is not it. A booking flow inside one modal advances through four
 * screens without the address ever changing, and judging that by URL calls a
 * working flow a stuck loop: seen live on a real spa site, where the element
 * count went 37 to 51 while the URL stood still. So a loop is the page not
 * changing, and this is what "not changing" means.
 *
 * What the fields hold counts as part of it. Filling in a form is progress even
 * though it moves nothing else on the page, and a run that types a name, a phone
 * number and a note would otherwise look identical at every step and earn a loop
 * blocker for working correctly. Retyping the same value into the same field
 * still leaves this string unchanged, which is the case the blocker is for.
 */
function fingerprint(p: Perception): string {
  return [
    p.url,
    p.title,
    p.elements.length,
    p.elements.map((e) => `${e.role}:${e.name}:${e.value ?? ""}`).join("|"),
  ].join("~");
}

export function grade(t: Transcript): Verdict {
  const text = textOf(t);
  const blockers: BlockerHit[] = [];
  const milestones: Milestone[] = [];
  const spec = ACTIONS[t.action];

  const firstPerception = t.perceptions[0];
  const everGated = t.perceptions.some((p) => p.jsGated);
  const alwaysGated = t.perceptions.length > 0 && t.perceptions.every((p) => p.jsGated);

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
  const verifySign = lastPerception ? VERIFY_SIGNS.find((s) => lastPage(lastPerception).includes(s)) : undefined;
  if (verifySign && !t.declaredDone) {
    blockers.push({
      blocker: "verification-gate",
      detail: `The flow stopped to ask for a code from an inbox or a phone ("${verifySign}"). An agent has neither, so the action ends here however good the rest of the site is.`,
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

  if (AUTH_SIGNS.some((s) => text.includes(s)) && !t.declaredDone) {
    blockers.push({
      blocker: "auth-gate",
      detail: "An account was required before the action could be reached.",
    });
  }

  if (t.failures.length >= 2 && !t.declaredDone) {
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
  if (!t.declaredDone && !t.abandoned && t.perceptions.length >= 4) {
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
    (t.action === "integrate" && /```|curl |api key|npm install|pip install/.test(text)) ||
    (t.action === "contact" && /@|contact/.test(text) && !cta.deadEndOnly && !handoff) ||
    (t.action === "book" && /\b(mon|tue|wed|thu|fri|sat|sun)\w*\b|\bam\b|\bpm\b|available/.test(text))
  ) {
    milestones.push("found-key-info");
  }
  if (cta.found && !cta.deadEndOnly) milestones.push("found-cta");
  if (t.declaredDone) milestones.push("completed-action");

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

  return {
    grade: letter,
    score,
    milestones,
    blockers,
    steps: t.stepCount,
    summary: summarise(letter, t, milestones, blockers, spec.label, inconclusive),
    ...(inconclusive ? { inconclusive: true as const } : {}),
  };
}

function summarise(
  letter: Grade,
  t: Transcript,
  milestones: Milestone[],
  blockers: BlockerHit[],
  actionLabel: string,
  inconclusive = false,
): string {
  const task = actionLabel.toLowerCase();
  // Said first, because it changes how every number after it should be read.
  const cutShort = t.abandoned
    ? ` The run stopped early for a reason outside the site (${t.abandoned}), so this is a floor, not a ceiling.`
    : "";

  if (inconclusive) {
    return `No verdict: the run never reached the site (${t.abandoned}), so there is nothing to grade. Nothing here is a finding about ${task}.`;
  }
  if (milestones.includes("completed-action")) {
    return `An AI agent completed "${task}" in ${t.stepCount} steps.${
      blockers.length ? ` It worked, but it had to get past ${blockers.length} obstacle(s) on the way.` : ""
    }${cutShort}`;
  }
  const primary = blockers[0];
  if (primary) {
    const where = milestones.includes("found-cta")
      ? "It found the right button and still could not finish"
      : milestones.includes("understood-offering")
        ? "It understood what you sell but never reached the action"
        : "It could not even read what you sell";
    return `An AI agent failed to ${task}. ${where}. Primary blocker: ${primary.blocker}.${cutShort}`;
  }
  return `An AI agent failed to ${task} within ${t.stepCount} steps, without hitting a specific blocker. Grade ${letter}.${cutShort}`;
}
