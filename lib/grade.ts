import type {
  ActionKind,
  BlockerHit,
  Grade,
  Milestone,
  Perception,
  Verdict,
} from "./types";
import { ACTIONS, isDeadEndHref } from "./actions";

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
  if (cta.deadEndOnly || allLinksAreDeadEnds(t)) {
    blockers.push({
      blocker: "dead-end-cta",
      detail:
        "The only route to the action hands off to WhatsApp, phone, or email. A browser agent cannot follow it, so the visit ends here.",
    });
  }

  if ((t.action === "purchase" || t.action === "signup") && !t.perceptions.some((p) => p.hasPrice)) {
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

  // Same URL for four consecutive perceptions with no success is a stuck loop.
  if (!t.declaredDone && t.perceptions.length >= 4) {
    const tail = t.perceptions.slice(-4).map((p) => p.url);
    if (new Set(tail).size === 1) {
      blockers.push({
        blocker: "loop",
        detail: "The agent kept acting without the page ever changing.",
      });
    }
  }

  if (!firstPerception) {
    blockers.push({ blocker: "nav-error", detail: "The page never loaded." });
  }

  // --- milestones ---

  // Understood the offering: enough prose to say what this is.
  if (firstPerception && !alwaysGated && text.replace(/\s+/g, " ").length > 400) {
    milestones.push("understood-offering");
  }
  // Found the key info this action depends on.
  if (
    t.perceptions.some((p) => p.hasPrice) ||
    (t.action === "integrate" && /```|curl |api key|npm install|pip install/.test(text)) ||
    (t.action === "contact" && /@|contact/.test(text) && !cta.deadEndOnly) ||
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

  return {
    grade: letter,
    score,
    milestones,
    blockers,
    steps: t.stepCount,
    summary: summarise(letter, t, milestones, blockers, spec.label),
  };
}

function summarise(
  letter: Grade,
  t: Transcript,
  milestones: Milestone[],
  blockers: BlockerHit[],
  actionLabel: string,
): string {
  const task = actionLabel.toLowerCase();
  if (milestones.includes("completed-action")) {
    return `An AI agent completed "${task}" in ${t.stepCount} steps.${
      blockers.length ? ` It worked, but it had to get past ${blockers.length} obstacle(s) on the way.` : ""
    }`;
  }
  const primary = blockers[0];
  if (primary) {
    const where = milestones.includes("found-cta")
      ? "It found the right button and still could not finish"
      : milestones.includes("understood-offering")
        ? "It understood what you sell but never reached the action"
        : "It could not even read what you sell";
    return `An AI agent failed to ${task}. ${where}. Primary blocker: ${primary.blocker}.`;
  }
  return `An AI agent failed to ${task} within ${t.stepCount} steps, without hitting a specific blocker. Grade ${letter}.`;
}
