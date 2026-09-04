import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ACTIONS, type ActionSpec, handoffLabel, isDeadEndHref } from "./actions";
import { Deadline, TimeoutError, withTimeout } from "./deadline";
import { groqJson, type ChatOptions } from "./groq";
import { type AgentPage, fingerprint, looksPriced, perceive, renderState } from "./perceive";
import { grade, type Transcript } from "./grade";
import { closeClient, launchBrowser, releaseSession } from "./solari";
import type { ActionKind, Perception, RunEvent, StepAction } from "./types";

export const MAX_STEPS = 10;

/**
 * Ceilings. Nothing remote is awaited without one.
 *
 * The run budget is the load-bearing one: individual timeouts stop one wedged
 * call, but ten merely-slow steps can still hold a request open for a quarter of
 * an hour, and an audit that never ends is indistinguishable from a broken one.
 * Past this the run stops and grades what it has, which is honest: four minutes
 * of an agent trying and not booking is itself the answer.
 */
const RUN_BUDGET_MS = 240_000;
const PERCEIVE_MS = 15_000;
const SHOT_MS = 15_000;
const ACT_MS = 25_000;
const DECIDE_MS = 45_000;
/** Handing the slot back. Long enough to be real, short enough to still report. */
const RELEASE_MS = 30_000;
/**
 * How many actions in a row may blow past their own ceiling before we stop.
 *
 * An action that ignores the 8s timeout Playwright was given is not the element
 * refusing, it is the browser no longer answering, and once that starts it does
 * not stop. Measured on a live run: five consecutive 25s hangs burned every
 * remaining step and then produced form-stall and loop against a site whose form
 * was fine. Two could be a heavy page. Three is the browser.
 */
const STALL_LIMIT = 3;
/**
 * How long to let a tab the site just opened settle on its real address.
 *
 * A popup is on about:blank at the moment the event fires. Measured on the run
 * that proved the handoff finding: the sweep straight after the click that opened
 * the tab still read about:blank, and WhatsApp only showed up one step later,
 * which filed the finding under a step that had nothing to do with it. Paid once
 * per tab and only while it is still blank.
 */
const POPUP_SETTLE_MS = 250;
const POPUP_SETTLE_TRIES = 6;

const DecisionSchema = z.object({
  action: z.enum(["click", "type", "select", "scroll", "back", "done", "give_up"]),
  target: z.union([z.number(), z.string()]).optional(),
  value: z.string().optional(),
  reasoning: z.string().default(""),
});

type Decision = z.infer<typeof DecisionSchema>;

/**
 * Verbs a model reaches for instead of ours, and which of ours it meant.
 *
 * Not guesswork: each of these has exactly one reading against the action list in
 * the prompt. Rejecting them ends the whole run over a synonym.
 */
const VERBS: Record<string, Decision["action"]> = {
  press: "click", tap: "click", submit: "click", clic: "click",
  fill: "type", fill_in: "type", input: "type", enter: "type", write: "type", set: "type",
  choose: "select", pick: "select", select_option: "select", dropdown: "select",
  scroll_down: "scroll", scrolldown: "scroll",
  go_back: "back", goback: "back", navigate_back: "back",
  finish: "done", finished: "done", complete: "done", completed: "done",
  giveup: "give_up", abort: "give_up", quit: "give_up",
};

/**
 * The address this run signs up with.
 *
 * example.com is reserved and cannot receive mail, which is deliberate: we do not
 * want a real inbox filling with confirmations, and we are not here to create live
 * accounts on other people's systems. Where that stops the run is itself the
 * finding, and the grader names it verification-gate.
 */
export function personaEmail(runId: string): string {
  return `alex.morgan.${runId}@example.com`;
}

/** Loose on purpose: enough to tell an address from a name or a phone number. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Any address the model types becomes this run's own address.
 *
 * Set rather than requested, because the address is our fixture and a run must not
 * be able to spoil the next one. Measured on plausible.io: the second visit typed
 * the same address as the first, took "Email is already taken" from our own
 * previous run, improvised "alex.morgan2.test@example.com", and earned the site a
 * loop blocker for a signup that works. Asking the model nicely in the prompt is
 * not a guarantee; this is.
 *
 * Applied to every email-shaped value, not just ones resembling the persona: any
 * other address is either already consumed by an earlier run or belongs to a
 * stranger. It also makes a "confirm your email" field agree with the first one by
 * construction instead of by the model's memory.
 */
export function withOurEmail(d: Decision, runId: string): Decision {
  if (d.action !== "type" || !d.value) return d;
  const typed = d.value.trim();
  if (!EMAIL_RE.test(typed)) return d;
  const ours = personaEmail(runId);
  return typed === ours ? d : { ...d, value: ours };
}

/**
 * The model's answer as a decision, or nothing when it cannot be read as one.
 *
 * Two things go wrong often enough to cost runs, and both are the right decision
 * written differently. A model fills in every field it was shown and puts
 * `"value": null` on the ones its action does not use, which a schema of optional
 * strings rejects outright. And it reaches for a neighbouring verb: "submit" for a
 * click, "fill" for a type. Measured live: a run died at step 8 with the booking
 * form filled in and the submit button on screen.
 */
export function usable(raw: unknown): Decision | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const clean: Record<string, unknown> = {};
  // A field the model explicitly left empty is a field it did not set, and the
  // schema reads absent and null very differently.
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v !== null && v !== "") clean[k] = v;
  }
  if (typeof clean.action === "string") {
    const verb = clean.action.trim().toLowerCase().replace(/[\s-]+/g, "_");
    clean.action = VERBS[verb] ?? verb;
  }
  const parsed = DecisionSchema.safeParse(clean);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A decision, or the reason there is no decision.
 *
 * These are kept apart because conflating them puts a lie in the product. When
 * our own model quota runs out mid-run, recording that as the agent giving up
 * blames the site for our billing: it caps the score at 55 and prints "gave up"
 * next to a site that was doing nothing wrong. Seen live on a free Groq key,
 * which meters tokens per minute and cannot serve ten decisions in one.
 */
type Outcome =
  | { kind: "decided"; decision: Decision }
  | { kind: "unavailable"; why: string };

/**
 * How much page prose to send the model. Full text on the opening move, because
 * that is where the model works out what the site is; a slice after that,
 * because by then it needs the controls, and the free tier meters tokens per
 * minute across the whole burst.
 */
const TEXT_FIRST = 2400;
const TEXT_LATER = 1100;

/**
 * Built per run, not once at import, for two reasons.
 *
 * The date: a module-level string freezes whatever day the server booted on, and
 * an agent that thinks it is still last October fills every booking form with a
 * date in the past. Seen on the first live run: "Preferred Date" filled with
 * 2024-10-15.
 *
 * The email: a fixed one registers itself on the first run and then blocks every
 * run after it. Measured on plausible.io, second visit: four clicks on "Start my
 * free trial" against "Email is already taken", give_up at step 9, and a loop
 * blocker charged to a site whose signup works fine. The address our own last run
 * consumed is not a finding about theirs.
 */
function systemPrompt(runId: string): string {
  const today = new Date();
  const stamp = today.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  // Local parts, not toISOString: at 00:30 in a positive-offset zone the UTC date
  // is still yesterday, and the prompt would name two different days.
  const iso = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");

  // The (disabled) rule spells out that a challenge can clear on its own, because
  // the model read one as a wall. Measured on plausible.io/register, where Friendly
  // Captcha resolves with no interaction: one run reached submit at step 4, and the
  // next gave up at step 3 because the button "is disabled due to unsolved Friendly
  // Captcha, which cannot be completed automatically". That give_up put a captcha
  // hard blocker and a 45-point cap on a site whose signup works, which is our model
  // quitting rather than the site refusing. Once, not repeatedly: a spent step is
  // cheaper than a wrong finding, but waiting is not a strategy either.
  return `You are an AI agent operating a real web browser on behalf of a person.
You are not a crawler and not a tester: you are trying to actually get something done.

Today is ${stamp}. In numbers, today is ${iso}.

You will be given the page state as a numbered list of interactive elements plus the
visible text. Choose exactly ONE next action.

Respond with JSON only, in this shape:
{"action":"click"|"type"|"select"|"scroll"|"back"|"done"|"give_up","target":<element number>,"value":"<text>","reasoning":"<one short first-person sentence>"}

Rules:
- Address elements only by their number from the list. Never invent a number.
- "type" fills one field. Follow it with a separate "click" on the submit control.
- An element listed with "choices:" is a dropdown. Use "select" with "value" set to
  one of those choices exactly as written. Clicking a dropdown or its options does
  nothing: "select" is the only way to set one.
- An element listed with = "something" already holds that value. It is filled in.
  Move on to the next empty field or to the submit control; do not fill it again.
- An element marked (disabled) is on the page but cannot be clicked or filled, so do
  not try. It is a symptom: something above it is unsatisfied, usually an empty
  required field, an unticked box, or a challenge still resolving. Deal with that
  first.
- A disabled submit is rarely the end of the road. Most challenges need no
  interaction at all and clear themselves within seconds, so a challenge with no
  control of its own in the list is something to wait out, not a wall. Fill every
  empty field first. Then, if it is still disabled and there is nothing left to
  fill, "scroll" once to see the page as it stands now: the state you are sent is
  read fresh after every action. Only a control still disabled after that, on a form
  with every field filled, means this site cannot be used: then give_up and say
  which control was disabled.
- Use realistic placeholder details when a form needs them: name "Alex Morgan",
  email "${personaEmail(runId)}", phone "+1 415 555 0132", company "Morgan Labs".
  Whatever address you type is replaced with that one, so a form that says an email
  is already taken is not talking about a name you can fix by inventing another.
- A date field wants a date a few days from today, never one in the past. Match the
  format the field asks for, and default to YYYY-MM-DD when it does not say.
- NEVER enter real payment card details. If a page demands card details to continue,
  that is as far as this task goes: answer "done".
- "done" means the DONE WHEN test in your task is met. Nothing else is done. There is
  not always a button to press: on a task whose object is to find something, done is
  the moment you have seen it, and one more click after that is a step wasted.
- "give_up" means this site cannot be used for this task. Explain why in reasoning.
  Prefer give_up over clicking things at random.
- A wall is give_up, not done. Being asked for a code from an inbox, or for an account
  you do not have, is the site stopping you, and calling that a success hides the one
  thing worth reporting. Say which wall it was.
- give_up is for a site you cannot use, not for a step you cannot find. A form only
  shows you where you are now, so a field you passed earlier is not missing. If the
  control that finishes the task is in the list, use it.
- If the element list is empty, the page is unreadable to you: give_up.
- Do not repeat an action that already failed or already left the page unchanged.`;
}

interface RunOptions {
  url: string;
  action: ActionKind;
  runId: string;
  maxSteps?: number;
  onEvent: (e: RunEvent) => void | Promise<void>;
  /**
   * Ends the run early, at the first point where it was about to spend more time.
   * A stop is not a finding, so it is recorded the way the time limit is: the run
   * is graded on what it reached and the site is not charged for the rest.
   */
  signal?: AbortSignal;
}

/**
 * How a run that a person ended is written down.
 *
 * Phrased as a fact about the run rather than a fault of the page, because the
 * grader reads `abandoned` and declines to blame a site for a run of ours that
 * did not finish.
 */
export const STOPPED_BY_YOU = "you stopped the run";

/**
 * Take back one recorded failure, the most recent one that matches.
 *
 * Exactly one, and matched by what it says rather than by where it sits. Two
 * clicks that time out on the same site produce the same sentence word for word,
 * and evidence that the second one landed says nothing about the first: removing
 * both would clear a real finding, and grading counts these, so the count is the
 * thing that has to stay honest.
 */
export function withdrawFailure(failures: string[], charge: string): boolean {
  const at = failures.lastIndexOf(charge);
  if (at < 0) return false;
  failures.splice(at, 1);
  return true;
}

/**
 * What a decision cost, and any pause the free-tier governor imposed to afford it.
 *
 * Passed down rather than logged inside the client, because the run is the thing
 * that knows how to make a pause visible: a held call looks exactly like a stalled
 * one in a replay, and the difference is our own account, not the audited site.
 */
type Meter = Pick<ChatOptions, "onUsage" | "onWait">;

/**
 * What the run remembers between decisions: what it has done, what turned out to
 * do nothing, and what it did the last time it stood where it is standing now.
 *
 * The second half is the expensive one. A click can land perfectly and still
 * leave the page exactly as it was, and "click X (ok)" reads to the model as
 * progress. Measured on docs.stripe.com: the same nav control was clicked on
 * three consecutive steps, each reported ok, and the run ran out of steps with
 * the answer two clicks away. So a step that moved nothing is written down as
 * having moved nothing, and named again as something not to choose.
 *
 * `seen` is the same problem at a wider radius, and neither of the other two can
 * see it. Measured on docs.groq.com: click "API Keys", type the address, click
 * "Continue with email", click "Docs", and then those same four again, six of ten
 * steps spent going round twice. Every one of those steps changed the page, so
 * nothing was inert, and no two perceptions in a row matched, so the grader saw no
 * loop. What repeated was the lap. Keyed by page state rather than by URL, because
 * the login form before and after it was submitted is not the same page.
 *
 * This changes what the agent spends its steps on and nothing about what the
 * site is charged with: the loop blocker still comes from the grader reading
 * four identical perceptions, not from anything recorded here.
 */
export interface Memory {
  history: string[];
  /** Actions, phrased as the prompt names them, that left the page unchanged. */
  inert: Set<string>;
  /** Page state, to the moves already made from it. */
  seen: Map<string, string[]>;
}

/**
 * Everything the run remembers, as the model reads it.
 *
 * Pulled out of the prompt for one reason: this is the half of the loop fix that
 * can be checked without a browser, and what it says is the whole mechanism. If
 * these lines stop appearing the agent goes back to spending six steps of ten
 * going round twice, and nothing else in the run would notice.
 */
export function recall(memory: Memory, p: Perception): string {
  const recent = memory.history.length
    ? `\n\nWHAT YOU HAVE ALREADY TRIED:\n${memory.history.slice(-5).join("\n")}`
    : "";
  // Kept separate from the history above, and not truncated to the last five,
  // because a dead end found early is exactly the one worth still knowing about
  // late: the loop this exists to break was three attempts at one control.
  const inert = memory.inert.size
    ? `\n\nTHESE LEFT THE PAGE EXACTLY AS IT WAS. DO NOT CHOOSE THEM AGAIN:\n${Array.from(
        memory.inert,
      )
        .slice(-6)
        .map((k) => `- ${k}`)
        .join("\n")}`
    : "";
  // Says what was tried from here and stops there. Coming back to a page is often
  // the right move; it is taking the same turning off it that costs the run the
  // budget, and the model is better placed than this code to know which of the
  // remaining ones is worth a step.
  const before = memory.seen.get(fingerprint(p));
  const again = before?.length
    ? `\n\nYOU HAVE BEEN ON THIS EXACT PAGE BEFORE. FROM HERE YOU ALREADY TRIED:\n${before
        .map((m) => `- ${m}`)
        .join("\n")}\nRepeating any of those brings you back here. Choose something else.`
    : "";
  return `${recent}${inert}${again}`;
}

/**
 * The task as the model receives it: what to do, and how to know it is finished.
 *
 * Both halves every step, not just the first. The model has no memory between
 * calls beyond what is in the message, so a completion test stated once at the
 * top of a run is a completion test the model does not have when it is standing
 * on the page that satisfies it. See ActionSpec.done for the two runs that
 * reached exactly that page and kept clicking.
 */
export function taskBlock(spec: ActionSpec): string {
  return `TASK: ${spec.goal}\n\nDONE WHEN: ${spec.done}`;
}

async function decide(
  p: Perception,
  task: string,
  stepsLeft: number,
  memory: Memory,
  timeoutMs: number,
  isFirst: boolean,
  runId: string,
  meter: Meter = {},
  signal?: AbortSignal,
): Promise<Outcome> {
  const state = renderState(p, stepsLeft, isFirst ? TEXT_FIRST : TEXT_LATER);

  try {
    const raw = await groqJson<unknown>(
      [
        { role: "system", content: systemPrompt(runId) },
        { role: "user", content: `${task}\n\n${state}${recall(memory, p)}` },
      ],
      { maxTokens: 600, temperature: 0.1, timeoutMs, ...meter, signal },
    );
    const parsed = usable(raw);
    if (parsed) return { kind: "decided", decision: withOurEmail(parsed, runId) };
    // A malformed answer is the model's failure, not the site's, but it is also
    // the model looking at this page: one retry-free give_up keeps the run honest
    // without pretending the site caused it. What it actually said is carried
    // along, because a run that dies here and keeps no record of why cannot be
    // fixed: the first time this happened it took a whole audit with it.
    return {
      kind: "unavailable",
      why: `the model did not return a usable action for this page: ${JSON.stringify(raw).slice(0, 160)}`,
    };
  } catch (err) {
    return { kind: "unavailable", why: err instanceof Error ? err.message : String(err) };
  }
}

/** Resolve a model-chosen element number to something Playwright can operate. */
function resolveTarget(p: Perception, target: Decision["target"]) {
  const n = typeof target === "string" ? Number.parseInt(target, 10) : target;
  if (!n || Number.isNaN(n)) return undefined;
  return p.elements.find((e) => e.index === n);
}

/** Minimal slice of the Playwright page the actuator needs. */
interface ActPage extends AgentPage {
  locator(selector: string): Locatorish;
  getByRole(role: string, opts: { name: string; exact?: boolean }): Locatorish;
  goBack(opts?: { timeout?: number }): Promise<unknown>;
  waitForLoadState(state: "domcontentloaded" | "load", opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  mouse: { wheel(dx: number, dy: number): Promise<void> };
  screenshot(opts: { type: "jpeg"; quality: number }): Promise<Buffer>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { timeout?: number; waitUntil?: "domcontentloaded" }): Promise<unknown>;
  context(): Contextish;
}

/** A tab, as far as watching where a click sent the visitor needs to care. */
interface Tabbish {
  url(): string;
}

/**
 * The browser context, for one purpose: knowing when the site opened a tab of its
 * own. A button running `onclick="sendToWhatsApp()"` has no href for anyone to
 * inspect, so the only way to see where it went is to watch what it opened.
 */
interface Contextish {
  on(event: "page", handler: (p: Tabbish) => void): void;
}


interface Locatorish {
  first(): Locatorish;
  click(opts?: { timeout?: number }): Promise<void>;
  fill(value: string, opts?: { timeout?: number }): Promise<void>;
  selectOption(
    value: string | { label: string },
    opts?: { timeout?: number },
  ): Promise<string[]>;
  /** Optional: only ever used to explain a hang, never to carry out a decision. */
  evaluate?<R>(fn: (node: Element) => R): Promise<R>;
}

/**
 * How long an operation gets, and why act() holds a clock over the one Playwright
 * is already holding.
 *
 * Because their timeout is not always a bound. Measured on
 * resend.com/docs/api-reference/api-keys/create-api-key, on a link the docs nav
 * paints over: a click asking for 8s and a trial click asking for 5s were both
 * still pending 30s and 25s later, while that same tab answered `evaluate` in
 * 280ms and a second tab opened and navigated in under a second. Neither the page
 * nor the connection was stuck; their deadline simply never fired. `force: true`,
 * which skips the actionability wait altogether, dispatched in 2.5s, which places
 * the hang in the hit-target check, before anything is sent to the page.
 *
 * Three of those in a row ended a live run at step 6 having spent 90s of a 240s
 * budget on one link, and all the transcript could say was "the action did not
 * finish within 25s", which is a fact about us rather than about the site.
 *
 * Ours sits above theirs on purpose: on a page where their clock does work, it
 * still wins the race and keeps its own more specific message.
 */
const CLICK_MS = 8_000;
const FILL_MS = 8_000;
const SELECT_MS = 5_000;
const OUR_MARGIN = 2_000;

/**
 * What the page has on top of this element, in its own words.
 *
 * Asked only once an operation on it has hung, to turn our timeout into the site's
 * finding. A control something else is painted over is a real defect and not a
 * quirk of automation: a visitor with a mouse cannot press it either, and an owner
 * can fix it. The rule here is the one Playwright's hit-target check uses, a hit on
 * the element itself or on anything inside it, so the answer explains their wait
 * rather than describing something else.
 *
 * Undefined when the question could not be put at all, which stays silence: a
 * probe that did not answer is not evidence about the site.
 */
async function whatIntercepts(locator: Locatorish): Promise<string | undefined> {
  if (!locator.evaluate) return undefined;
  try {
    return await withTimeout(
      locator.evaluate((node: Element) => {
        const r = node.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return "it has no size on the page";
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
          return "its centre is outside the viewport";
        }
        const top = document.elementFromPoint(x, y);
        if (!top) return "nothing at all is at its centre";
        if (top === node || node.contains(top)) return "";
        const label = (top.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        const what = `<${top.tagName.toLowerCase()}>${label ? ` "${label}"` : ""}`;
        return `${what} is painted over it, so a click there never reaches it`;
      }),
      4_000,
      "the element",
    );
  } catch {
    return undefined;
  }
}


/**
 * A step that did something other than what it was asked, and did it on purpose.
 *
 * Not a failure, and it must not be counted as one. But it cannot be silence
 * either: the model asked for a value to be set, the value was not set, and a
 * history line reading "(ok)" would have it believe the field is filled and go
 * looking for the submit.
 */
export interface Substituted {
  /** What was done instead, and what is still owed, in the words the model reads. */
  instead: string;
}

/**
 * Playwright refusing an element for its kind rather than for its state.
 *
 * `selectOption` answers "Element is not a <select> element" and `fill` answers
 * "Element is not an <input>, <textarea> or [contenteditable] element". Both mean
 * we reached for the wrong mechanism, not that the page is broken. Their other
 * refusals ("not attached", "not visible", "not enabled") are about state, are the
 * site's to answer for, and are not followed by a tag name, which is what keeps
 * this narrow.
 */
const WRONG_KIND = /element is not an? </i;

/**
 * Execute one decision. Returns an error string when the element would not budge,
 * or a Substituted when it took a different route to the same intent.
 */
export async function act(
  page: ActPage,
  p: Perception,
  d: Decision,
): Promise<string | Substituted | undefined> {
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(900);
  };

  if (d.action === "scroll") {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(600);
    return undefined;
  }
  if (d.action === "back") {
    await page.goBack({ timeout: 8000 }).catch(() => {});
    await settle();
    return undefined;
  }

  const el = resolveTarget(p, d.target);
  if (!el) return `no element numbered ${String(d.target)}`;

  // Refused here rather than at the locator, now that the list describes controls
  // that cannot be operated. Being able to name the button that is stopping the
  // form means the model can also aim at it, and Playwright answers that by
  // waiting out its whole ceiling for an element that was never going to become
  // clickable: eight seconds of a four-minute budget, then a wall of retry logs
  // in the failure text. Said plainly and immediately instead, so the transcript
  // records the disabled control as the reason rather than as a timeout.
  if (el.disabled) {
    return `${el.role} "${el.name}" is disabled, so a ${d.action} on it cannot land`;
  }

  // Prefer the snapshot handle: it points at the one node we showed the model.
  // Falling back to role and name re-guesses, and on a page with three "Sign up"
  // links the guess is wrong a third of the time.
  const locator = el.ref
    ? page.locator(`aria-ref=${el.ref}`).first()
    : page.getByRole(el.role, { name: el.name, exact: false }).first();

  /** Their clock, and ours over it. See CLICK_MS for what happens without ours. */
  const bounded = <T,>(work: Promise<T>, theirs: number) =>
    withTimeout(work, theirs + OUR_MARGIN, `the ${d.action}`);

  try {
    if (d.action === "type") {
      if (!d.value) return "type was chosen with nothing to type";
      await bounded(locator.fill(d.value, { timeout: FILL_MS }), FILL_MS);
    } else if (d.action === "select") {
      if (!d.value) return "select was chosen with no choice named";
      // By label first, because the label is what the model was shown. Then by
      // value, for the selects whose visible text and underlying value differ.
      // Both are short: a dropdown that answers at all answers in milliseconds.
      try {
        await bounded(locator.selectOption({ label: d.value }, { timeout: SELECT_MS }), SELECT_MS);
      } catch {
        await bounded(locator.selectOption(d.value, { timeout: SELECT_MS }), SELECT_MS);
      }
    } else {
      await bounded(locator.click({ timeout: CLICK_MS }), CLICK_MS);
      await settle();
    }
  } catch (err) {
    // Our own clock going off says nothing yet about the site, so ask the page why
    // before writing it down. "Something is painted over the link" is a finding an
    // owner can act on; "the action did not finish" is a line about our patience.
    if (err instanceof TimeoutError) {
      const clause = await whatIntercepts(locator);
      const secs = Math.round(err.ms / 1000);
      const tail =
        clause === undefined
          ? ""
          : clause
            ? `: ${clause}`
            : ", and nothing is covering it, so the browser never finished the attempt";
      return `${el.role} "${el.name}" did not accept a ${d.action} within ${secs}s${tail}`;
    }
    const why = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 120);

    // The control is a custom widget, not the native one we reached for. That is
    // ordinary modern UI and no defect at all: a visitor clicks it and picks from
    // what opens, and so can an agent. Measured on Stripe's registration form,
    // where the country picker refused both selectOption and fill inside one run
    // and the two refusals tripped form-stall, pointing the owner at a form that
    // works.
    //
    // So click it open and say so. One extra step, spent on the choices the page
    // actually offers rather than on a guess at which option node to press: an
    // option that is not where we assumed would cost a click's whole timeout and
    // invent the second false failure in place of the first.
    if (WRONG_KIND.test(why) && (d.action === "select" || d.action === "type")) {
      try {
        await bounded(locator.click({ timeout: CLICK_MS }), CLICK_MS);
        await settle();
        return {
          instead:
            d.action === "select"
              ? "not a dropdown the browser can set, so it was clicked open instead; nothing is chosen yet"
              : "not a text field the browser can fill, so it was clicked instead; nothing is typed yet",
        };
      } catch {
        return `${el.role} "${el.name}" would not accept a ${d.action}, and a click to open it did not land either`;
      }
    }
    return `${el.role} "${el.name}" would not accept a ${d.action}: ${why}`;
  }
  return undefined;
}

/** How long to spend on the front page once the flow is over. One nav, no more. */
const PRICE_CHECK_MS = 12_000;
/**
 * How long to keep watching that page after it opens, and how often to look.
 *
 * Because a published price is often not in the markup. plausible.io serves its
 * pricing through a slider that renders after load: the same front page answered
 * true on run mtlke0h0 and false on run mtlkppbb, minutes apart, and `curl` on it
 * finds no currency symbol anywhere in the HTML. A single glance a fixed moment
 * after DOMContentLoaded is a coin toss, and this finding is charged to the site,
 * so it has to be the answer to "we watched and nothing came" rather than to "we
 * looked before it arrived".
 */
const PRICE_SETTLE_MS = 6_000;
const PRICE_POLL_MS = 700;

/**
 * The site's front page as seen from the URL we were handed, and whether the run
 * already began there.
 *
 * A query string counts as somewhere else even on "/", since that is how a landing
 * page or a filtered view is addressed.
 */
export function frontPage(startUrl: string): { home?: string; alreadyThere: boolean } {
  try {
    const u = new URL(startUrl);
    return { home: `${u.origin}/`, alreadyThere: u.pathname === "/" && !u.search };
  } catch {
    return { alreadyThere: false };
  }
}

/**
 * Does the site's front page publish a price a machine can read?
 *
 * Asked only when the flow never passed one, and asked after the flow has ended so
 * it cannot disturb it. Costs one navigation on a browser already paid for and no
 * model tokens at all, which is why it is worth doing rather than living with a
 * finding that depends on the URL we were handed.
 *
 * Undefined when the page could not be read. The caller turns that into silence
 * rather than a finding, so an unreachable front page is never scored as a site
 * without prices.
 */
export async function priceOnFrontPage(
  page: ActPage,
  home: string,
  settleMs = PRICE_SETTLE_MS,
  pollMs = PRICE_POLL_MS,
): Promise<boolean | undefined> {
  try {
    await page.goto(home, { timeout: PRICE_CHECK_MS, waitUntil: "domcontentloaded" });
    const until = Date.now() + settleMs;
    for (;;) {
      // evaluate takes no timeout of its own, and a wedged main thread never answers
      // it. A clock here, or one stuck front page holds the verdict hostage.
      const text = await withTimeout(
        page.evaluate<string>(() => (document.body ? document.body.innerText : "")),
        5_000,
        "the front page",
      );
      if (looksPriced(text)) return true;
      if (Date.now() + pollMs >= until) return false;
      await page.waitForTimeout(pollMs);
    }
  } catch {
    return undefined;
  }
}

/**
 * The same question asked as a stranger, in a browser context of its own.
 *
 * Because the flow changes who the site thinks we are. Measured on plausible.io
 * within the same few minutes: the run that gave up before submitting found
 * "$9 $14 $19" on the front page at DOMContentLoaded, and the two runs that
 * completed the registration found no price there at all. Signing up leaves a
 * session cookie, and the front page then serves the signed-in app instead of the
 * pricing. Charging a site for a price our own run hid is the one kind of wrong
 * finding this cannot afford, so the question is put in a clean jar: no cookies, no
 * storage, nothing this run did.
 *
 * Same session, so no extra minutes and nothing more to pay for. The context is
 * closed either way.
 */
/**
 * The whole stranger check, end to end.
 *
 * Because only the navigation inside it was ever bounded. Measured on the resend.com
 * run: PRICE_CHECK_MS caps the goto at 12s and the watch window is 6s, and the check
 * still took 62 seconds of a run that was already over its budget, so the other 44
 * went to opening the context or the page. A postscript on a finished run must never
 * be able to do that.
 */
const PRICE_TOTAL_MS = 25_000;

async function priceOnStranger(
  browser: NonNullable<Awaited<ReturnType<typeof launchBrowser>>>["browser"],
  home: string,
): Promise<boolean | undefined> {
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    return await withTimeout(
      (async () => {
        context = await browser.newContext();
        return priceOnFrontPage((await context.newPage()) as unknown as ActPage, home);
      })(),
      PRICE_TOTAL_MS,
      "the front page in a clean context",
    );
  } catch {
    return undefined;
  } finally {
    // Bounded too: this runs after the verdict is already owed to the reader.
    if (context) await withTimeout(context.close(), 5_000, "closing the context").catch(() => {});
  }
}

/**
 * The run. Every meaningful moment is pushed through `onEvent` as it happens,
 * because the point of the product is watching the agent struggle in real time,
 * not receiving a report once it is over.
 */
export async function runAudit(opts: RunOptions): Promise<void> {
  const { url, action, runId, onEvent, signal } = opts;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const spec = ACTIONS[action];
  const shotDir = path.join(process.cwd(), "public", "runs", runId);

  const emit = (e: RunEvent) => onEvent(e);
  const now = () => Date.now();
  const clock = new Deadline(RUN_BUDGET_MS);

  await emit({ type: "start", runId, url, action, task: spec.goal, at: now() });

  const perceptions: Perception[] = [];
  const failures: string[] = [];
  const memory: Memory = { history: [], inert: new Set(), seen: new Map() };
  /**
   * The last click, and the page as it stood the moment before it. Read once, on
   * the next perception, which is the earliest anything can know whether it did
   * something. Only clicks and back are tracked: typing is meant to leave the
   * page where it is, and a scroll moves the viewport without moving anything
   * this can see.
   *
   * `charge` is the failure this step recorded, if it recorded one. It is charged
   * now and withdrawn on evidence rather than held back until the evidence
   * arrives, so a run that ends before any arrives reports exactly what it always
   * did: a click nobody can show landed is a click that did not land.
   */
  let pending: { key: string; before: string; line: number; charge?: string } | undefined;

  /**
   * Withdraw a failure from a click that turned out to have worked.
   *
   * Playwright's ten-second click timeout is not the last word. A link that opens
   * a tab, or one whose click visibly moved the page, did accept the click, and
   * two of those are all it takes to charge a site with form-stall for controls
   * that work. The history line is corrected too: a model told its click failed
   * is a model that clicks the same thing again.
   */
  const landed = (proof: string) => {
    if (!pending?.charge) return;
    withdrawFailure(failures, pending.charge);
    memory.history[pending.line] = `- ${pending.key} (ok, ${proof})`;
    pending = { ...pending, charge: undefined };
  };
  let declaredDone = false;
  let gaveUp = false;
  let stepCount = 0;
  /** Consecutive actions that hung past their own ceiling. */
  let stalls = 0;
  /** Set when the run ended for a reason of ours rather than the site's. */
  let abandoned: string | undefined;
  let launched: Awaited<ReturnType<typeof launchBrowser>> | undefined;

  /**
   * Whether someone has asked for this to end.
   *
   * Read wherever the run is about to commit to the next expensive thing, rather
   * than once at the top, because the expensive things are seconds apart: a model
   * call, a click that waits on the network, a whole extra page load at the end.
   */
  const stopped = () => signal?.aborted === true;
  const stopHere = async () => {
    abandoned = STOPPED_BY_YOU;
    await emit({
      type: "status",
      message: stepCount
        ? `Stopped after ${stepCount} steps, grading what the agent reached and releasing the browser`
        : "Stopped before the agent had seen anything, so there is nothing to grade",
      at: now(),
    });
  };

  /**
   * What this run cost the model, and what the key had left when it last answered.
   *
   * Recorded because the free tier is what limits this product, so the number that
   * decides whether an audit can run at all should be in the notes of every run
   * rather than estimated afterwards from step counts. `remaining` and `limit` are
   * as of the last answered call, which is the only reading Groq gives us.
   */
  const spend = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    heldMs: 0,
    remainingTokens: undefined as number | undefined,
    limitTokens: undefined as number | undefined,
  };

  /**
   * A held call and a stalled one look identical in a replay, and the difference is
   * whose fault it is: a hold is our free tier, not the audited site. Said out loud
   * so a viewer waiting fifteen seconds knows nothing is broken, and so a reader of
   * the transcript can tell a slow site from a throttled agent.
   */
  const meter: Meter = {
    onUsage: (u) => {
      spend.calls++;
      spend.promptTokens += u.promptTokens;
      spend.completionTokens += u.completionTokens;
      if (u.remainingTokens !== undefined) spend.remainingTokens = u.remainingTokens;
      if (u.limitTokens !== undefined) spend.limitTokens = u.limitTokens;
    },
    onWait: (ms, why) => {
      spend.heldMs += ms;
      void emit({ type: "status", message: `Our own rate limit: ${why}`, at: now() });
    },
  };

  /**
   * Tabs the site opened for itself, and the URLs they settled on.
   *
   * Kept apart because a popup's URL is not there when it opens: measured, the
   * event fires on about:blank and the real destination arrives a moment later. So
   * the tab is remembered and read again after each step.
   */
  const opened: Tabbish[] = [];
  const handoffs = new Set<string>();
  /** Tabs already given their settling time, so one that never navigates costs it once. */
  const settled = new Set<Tabbish>();
  /** Where a tab is now, or nothing when it closed underneath us. */
  const addressOf = (tab: Tabbish): string | undefined => {
    try {
      return tab.url();
    } catch {
      return undefined;
    }
  };
  /** Re-read the remembered tabs, returning whatever address is new since last time. */
  const sweepTabs = async (): Promise<string[]> => {
    const fresh: string[] = [];
    for (const tab of opened) {
      let at = addressOf(tab);
      if (at?.startsWith("about:") && !settled.has(tab)) {
        settled.add(tab);
        for (let n = 0; n < POPUP_SETTLE_TRIES && at?.startsWith("about:"); n += 1) {
          await new Promise((r) => setTimeout(r, POPUP_SETTLE_MS));
          at = addressOf(tab);
        }
      }
      if (!at || at.startsWith("about:") || handoffs.has(at)) continue;
      handoffs.add(at);
      fresh.push(at);
    }
    return fresh;
  };
  /**
   * Report any tab that has appeared since the last look, and say whether one of
   * them is somewhere an agent cannot follow.
   *
   * The count matters as much as the destination. A click that opens a tab landed,
   * whatever the click promise went on to say about it, and that is the only proof
   * available for a click whose own timeout fired.
   */
  const reportTabs = async (): Promise<{ opened: number; deadEnd?: string }> => {
    let deadEnd: string | undefined;
    let opened = 0;
    for (const at of await sweepTabs()) {
      opened++;
      await emit({
        type: "status",
        message: `The site opened ${handoffLabel(at)} in a tab of its own: ${at.slice(0, 120)}`,
        at: now(),
      });
      deadEnd ??= isDeadEndHref(at) ? at : undefined;
    }
    return { opened, deadEnd };
  };

  try {
    await mkdir(shotDir, { recursive: true });
    // Stopped in the first second or two, while the browser was still being
    // acquired. Nothing has been launched, so nothing needs releasing, and the
    // cheapest correct thing is to never open the session at all.
    if (stopped()) {
      await stopHere();
      return;
    }
    await emit({ type: "status", message: "Acquiring a stealth browser", at: now() });
    launched = await launchBrowser({ stealth: true });
    // The session id goes out now rather than only with the verdict, so a run that
    // dies without finishing still leaves the one string needed to find its
    // recording or hand back its slot.
    await emit({ type: "status", message: `Session ${launched.sessionId}`, at: now() });
    if (!launched.stealth) {
      await emit({
        type: "status",
        message: "Stealth unavailable on this plan, running a plain browser",
        at: now(),
      });
    }

    const page = (await withTimeout(
      launched.browser.newPage(),
      30_000,
      "opening a tab",
    )) as unknown as ActPage;
    await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
    try {
      page.context().on("page", (tab) => opened.push(tab));
    } catch {
      // Nothing to watch with: a handoff goes unobserved rather than ending the run.
    }

    await emit({ type: "status", message: `Opening ${url}`, at: now() });
    try {
      await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
    } catch (err) {
      await emit({
        type: "blocker",
        blocker: "nav-error",
        detail: `The page did not load: ${err instanceof Error ? err.message : String(err)}`,
        at: now(),
      });
    }

    for (let i = 0; i < maxSteps; i++) {
      if (stopped()) {
        await stopHere();
        break;
      }
      if (clock.expired) {
        abandoned = `the run hit its own ${Math.round(RUN_BUDGET_MS / 1000)}s time limit`;
        await emit({
          type: "status",
          message: `Out of time after ${clock.spentSeconds}s and ${stepCount} steps, grading what the agent reached`,
          at: now(),
        });
        break;
      }

      const p = await perceive(page, clock.cap(PERCEIVE_MS));
      perceptions.push(p);
      /** This page, as the memory of what was tried from it is keyed. */
      const here = fingerprint(p);

      // Did the last click do anything? This is the only place that can answer,
      // and the answer goes back into the prompt rather than into the verdict.
      if (pending) {
        if (here === pending.before) {
          // Nothing moved. A click that also reported a failure is left charged:
          // it did nothing and said so, which is one finding, not two, and the
          // FAILED line already tells the model not to choose it again.
          if (!pending.charge) {
            memory.inert.add(pending.key);
            memory.history[pending.line] = `- ${pending.key} (ok, but nothing on the page changed)`;
          }
        } else {
          landed("and the page moved");
        }
        pending = undefined;
      }

      // The screenshot is taken before the action, so each step shows exactly
      // what the agent was looking at when it made that decision.
      let shot: string | undefined;
      try {
        const buf = await withTimeout(
          page.screenshot({ type: "jpeg", quality: 55 }),
          clock.cap(SHOT_MS),
          "the screenshot",
        );
        const file = `${String(i).padStart(2, "0")}.jpg`;
        await writeFile(path.join(shotDir, file), buf);
        shot = `/runs/${runId}/${file}`;
      } catch {
        // A failed screenshot degrades the evidence, it does not end the run.
      }

      if (p.jsGated) {
        await emit({
          type: "blocker",
          blocker: "js-gate",
          detail: "Nothing on this page is addressable: the accessibility tree is empty.",
          at: now(),
        });
      }

      const outcome = await decide(
        p,
        taskBlock(spec),
        maxSteps - i,
        memory,
        clock.cap(DECIDE_MS),
        i === 0,
        runId,
        meter,
        signal,
      );
      // Checked before the answer is read, and before the action it chose is
      // performed. A stop that lands mid-call comes back from the model as a
      // failed call, and what ended this run was the stop, not the abort the HTTP
      // client threw on its way out. Ending here also spares the site a click
      // that no one is left to watch.
      if (stopped()) {
        await stopHere();
        break;
      }
      if (outcome.kind === "unavailable") {
        // Not a step and not a verdict on the site: our side could not think. It
        // stops the run and it is stated plainly, but it does not become evidence
        // against the page.
        abandoned = outcome.why;
        await emit({
          type: "status",
          message: `Stopping after ${stepCount} steps: ${outcome.why}`,
          at: now(),
        });
        break;
      }

      const d = outcome.decision;
      stepCount = i + 1;
      const el = resolveTarget(p, d.target);

      if (d.action === "done" || d.action === "give_up") {
        declaredDone = d.action === "done";
        gaveUp = d.action === "give_up";
        await emit({
          type: "step",
          index: stepCount,
          action: d.action,
          reasoning: d.reasoning,
          ok: true,
          screenshot: shot,
          url: p.url,
          elementCount: p.elements.length,
          at: now(),
        });
        break;
      }

      // Bounded as a whole, not per call: the settle and the scroll inside it take
      // no timeout of their own, and a dead CDP socket makes every one of them
      // wait forever.
      let error: string | undefined;
      /** What was done instead, when act() took another route. Never a failure. */
      let instead: string | undefined;
      let wedged = false;
      try {
        const outcome = await withTimeout(act(page, p, d), clock.cap(ACT_MS), "the action");
        if (typeof outcome === "string") error = outcome;
        else if (outcome) instead = outcome.instead;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        // Our ceiling fired, not Playwright's. The element did not refuse: the
        // browser never answered, which is our problem to report and not the
        // site's to be graded on.
        wedged = err instanceof TimeoutError;
      }
      if (error && !wedged) failures.push(error);
      stalls = wedged ? stalls + 1 : 0;
      const move = `${d.action}${el ? ` "${el.name}"` : ""}`;
      // Written down against the page it was taken from, so a second visit knows
      // which turnings have already been taken. Recorded whatever it did: a move
      // that failed from here is as much a reason not to take it again as one that
      // worked, and one that worked is what makes a lap a lap.
      const fromHere = memory.seen.get(here) ?? [];
      if (!fromHere.includes(move)) memory.seen.set(here, [...fromHere, move]);
      memory.history.push(
        `- ${move}${error ? ` FAILED: ${error}` : instead ? ` (${instead})` : " (ok)"}`,
      );
      // Left for the next perception to judge: whether it did nothing, and whether
      // a click that reported a failure in fact landed. Our own ceiling firing is
      // never the site's to answer for, so a wedged step carries no charge to
      // withdraw. A substitution is watched for the same reason a click is: it was
      // one, and a widget that opened nothing is worth knowing about.
      if (d.action === "click" || d.action === "back" || instead) {
        pending = {
          key: move,
          before: here,
          line: memory.history.length - 1,
          charge: error && !wedged ? error : undefined,
        };
      }

      await emit({
        type: "step",
        index: stepCount,
        action: d.action as StepAction,
        target: el?.name,
        value: d.value,
        reasoning: d.reasoning,
        ok: !error,
        error,
        screenshot: shot,
        url: p.url,
        elementCount: p.elements.length,
        at: now(),
      });

      // Said out loud, because a step that reports ok while the field it names is
      // still empty is the sort of thing a witness has to be able to see.
      if (instead) {
        await emit({
          type: "status",
          message: `${el?.role ?? "That control"} "${el?.name ?? ""}" is ${instead}.`,
          at: now(),
        });
      }

      // Read after the step is reported, so the note about where a click sent the
      // visitor follows the click rather than preceding it.
      const { opened: newTabs, deadEnd: handedOff } = await reportTabs();

      // A click that opened a tab landed, whatever its own promise said about it.
      // Measured on docs.stripe.com: the click on "API keys" timed out at ten
      // seconds and the dashboard opened in a tab of its own, and the site was
      // charged form-stall for a link that works.
      if (newTabs > 0) landed("it opened a tab of its own");

      // The answer, and there is nothing after it. Measured on the run that proved
      // this finding: the submit opened WhatsApp, the first tab fell back to the
      // home page, and the model spent the last two steps and sixty seconds of the
      // budget clicking at a button that had moved. The site cannot be used for
      // this from a browser, which is the verdict, so the run stops on it rather
      // than filling the replay with an agent flailing at a page it already lost.
      if (handedOff) {
        await emit({
          type: "status",
          message: `Stopping after ${stepCount} steps: the action left the browser for ${handoffLabel(handedOff)}, so there is nothing further an agent can do here`,
          at: now(),
        });
        break;
      }

      if (stalls >= STALL_LIMIT) {
        abandoned = `the browser stopped answering: ${stalls} actions in a row hung past their own timeout`;
        await emit({
          type: "status",
          message: `Stopping after ${stepCount} steps: ${abandoned}`,
          at: now(),
        });
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never having looked at the page is ours, not the site's: the browser, the
    // tab, or the run directory failed before the first perception. Recorded as
    // abandoned so the verdict comes back as no verdict instead of an F.
    if (!perceptions.length) abandoned ??= message;
    await emit({ type: "error", message, at: now() });
  } finally {
    // A tab opened by the very last action has had no step after it to notice it,
    // and that action is the submit: the one most likely to hand off.
    await reportTabs().catch(() => {});

    // Where the audit was pointed must not move the grade. Measured twice on
    // plausible.io: from the home page it earned found-key-info and scored C 55,
    // and from /register it was charged no-structured-price and scored D 40. Same
    // site, same published prices, 15 points apart because of a URL we chose.
    //
    // So the front page is asked directly, but only when the flow never passed a
    // price, only once the flow is over, and never on a run whose clock has already
    // run out or that somebody asked to end: either way the load is time no one
    // agreed to spend. A run that started at the front page has its answer already
    // and spends nothing here.
    let priceOnHome: boolean | undefined;
    if (perceptions.length && !perceptions.some((p) => p.hasPrice)) {
      const { home, alreadyThere } = frontPage(url);
      if (alreadyThere) {
        // Already looked, and found nothing. That is an answer, not a gap.
        priceOnHome = false;
      } else if (home && launched && !clock.expired && !stopped()) {
        await emit({
          type: "status",
          message: `The flow never passed a price, so checking the front page for one: ${home}`,
          at: now(),
        });
        priceOnHome = await priceOnStranger(launched.browser, home);
        if (priceOnHome === undefined) {
          await emit({
            type: "status",
            message: "The front page did not answer, so no price finding is filed either way",
            at: now(),
          });
        }
      }
    }

    // Order matters: release the session first, because the recording is only
    // uploaded once released, and close the client last, because nothing else
    // can talk to Solari afterwards and the process will not exit without it.
    // What does NOT happen here is waiting for the replay: measured, that takes
    // minutes, and the verdict is the payoff. The session id goes out instead
    // and the client asks for the recording when it is ready.
    let sessionId: string | undefined;
    if (launched) {
      await emit({ type: "status", message: "Releasing the browser", at: now() });
      // Timed like everything else. This block owes the caller a verdict, and a
      // release that never returns would swallow it along with the whole run.
      const releaseError = await withTimeout(
        releaseSession(launched.browser),
        RELEASE_MS,
        "releasing the browser",
      ).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      if (releaseError) {
        await emit({
          type: "status",
          message: `The browser did not confirm release, so there may be no recording: ${releaseError}`,
          at: now(),
        });
      }
      sessionId = launched.sessionId;
      await withTimeout(closeClient(launched.solari), RELEASE_MS, "closing the client").catch(
        () => {},
      );
    }

    const transcript: Transcript = {
      action,
      startUrl: url,
      perceptions,
      declaredDone,
      gaveUp,
      failures,
      stepCount,
      stealth: launched?.stealth ?? false,
      abandoned,
      priceOnHome,
      handoffs: Array.from(handoffs),
    };
    const verdict = grade(transcript);
    if (sessionId) verdict.sessionId = sessionId;

    // Kept beside the screenshots, because three separate post-mortems this week
    // stalled on not having it. A screenshot shows what a person would have seen;
    // the grader reads the perception, and when the two disagree the perception is
    // the only place the answer is. Best effort: a run that cannot write its notes
    // still owes the caller its verdict.
    //
    // `spend` sits outside the transcript rather than in it, so that grading cannot
    // reach what our account cost. What we paid to look at a site must never move
    // that site's grade.
    await writeFile(
      path.join(shotDir, "transcript.json"),
      JSON.stringify({ runId, url, action, spend, transcript, verdict }, null, 2),
    ).catch(() => {});

    for (const b of verdict.blockers) {
      await emit({ type: "blocker", blocker: b.blocker, detail: b.detail, at: now() });
    }
    for (const m of verdict.milestones) {
      await emit({ type: "milestone", milestone: m, at: now() });
    }
    await emit({ type: "verdict", verdict, at: now() });
  }
}
