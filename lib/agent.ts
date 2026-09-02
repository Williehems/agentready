import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ACTIONS, handoffLabel, isDeadEndHref } from "./actions";
import { Deadline, TimeoutError, withTimeout } from "./deadline";
import { groqJson } from "./groq";
import { type AgentPage, perceive, renderState } from "./perceive";
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
 * Built per run, not once at import, for one reason: the date. A module-level
 * string freezes whatever day the server booted on, and an agent that thinks it
 * is still last October fills every booking form with a date in the past. Seen
 * on the first live run: "Preferred Date" filled with 2024-10-15.
 */
function systemPrompt(): string {
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
- Use realistic placeholder details when a form needs them: name "Alex Morgan",
  email "alex.morgan.test@example.com", phone "+1 415 555 0132", company "Morgan Labs".
- A date field wants a date a few days from today, never one in the past. Match the
  format the field asks for, and default to YYYY-MM-DD when it does not say.
- NEVER enter real payment card details. If a page demands card details to continue,
  that is as far as this task goes: answer "done".
- "done" means the task is complete, OR you have reached the furthest point a visitor
  can reach without paying and without a pre-existing account credential.
- "give_up" means this site cannot be used for this task. Explain why in reasoning.
  Prefer give_up over clicking things at random.
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
}

async function decide(
  p: Perception,
  goal: string,
  stepsLeft: number,
  history: string[],
  timeoutMs: number,
  isFirst: boolean,
): Promise<Outcome> {
  const recent = history.length
    ? `\n\nWHAT YOU HAVE ALREADY TRIED:\n${history.slice(-5).join("\n")}`
    : "";
  const state = renderState(p, stepsLeft, isFirst ? TEXT_FIRST : TEXT_LATER);

  try {
    const raw = await groqJson<unknown>(
      [
        { role: "system", content: systemPrompt() },
        { role: "user", content: `TASK: ${goal}\n\n${state}${recent}` },
      ],
      { maxTokens: 600, temperature: 0.1, timeoutMs },
    );
    const parsed = usable(raw);
    if (parsed) return { kind: "decided", decision: parsed };
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
}

/** Execute one decision. Returns an error string when the element would not budge. */
async function act(page: ActPage, p: Perception, d: Decision): Promise<string | undefined> {
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

  // Prefer the snapshot handle: it points at the one node we showed the model.
  // Falling back to role and name re-guesses, and on a page with three "Sign up"
  // links the guess is wrong a third of the time.
  const locator = el.ref
    ? page.locator(`aria-ref=${el.ref}`).first()
    : page.getByRole(el.role, { name: el.name, exact: false }).first();

  try {
    if (d.action === "type") {
      if (!d.value) return "type was chosen with nothing to type";
      await locator.fill(d.value, { timeout: 8000 });
    } else if (d.action === "select") {
      if (!d.value) return "select was chosen with no choice named";
      // By label first, because the label is what the model was shown. Then by
      // value, for the selects whose visible text and underlying value differ.
      // Both are short: a dropdown that answers at all answers in milliseconds.
      try {
        await locator.selectOption({ label: d.value }, { timeout: 5000 });
      } catch {
        await locator.selectOption(d.value, { timeout: 5000 });
      }
    } else {
      await locator.click({ timeout: 8000 });
      await settle();
    }
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 120);
    return `${el.role} "${el.name}" would not accept a ${d.action}: ${why}`;
  }
  return undefined;
}

/**
 * The run. Every meaningful moment is pushed through `onEvent` as it happens,
 * because the point of the product is watching the agent struggle in real time,
 * not receiving a report once it is over.
 */
export async function runAudit(opts: RunOptions): Promise<void> {
  const { url, action, runId, onEvent } = opts;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const spec = ACTIONS[action];
  const shotDir = path.join(process.cwd(), "public", "runs", runId);

  const emit = (e: RunEvent) => onEvent(e);
  const now = () => Date.now();
  const clock = new Deadline(RUN_BUDGET_MS);

  await emit({ type: "start", runId, url, action, task: spec.goal, at: now() });

  const perceptions: Perception[] = [];
  const failures: string[] = [];
  const history: string[] = [];
  let declaredDone = false;
  let gaveUp = false;
  let stepCount = 0;
  /** Consecutive actions that hung past their own ceiling. */
  let stalls = 0;
  /** Set when the run ended for a reason of ours rather than the site's. */
  let abandoned: string | undefined;
  let launched: Awaited<ReturnType<typeof launchBrowser>> | undefined;

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
   */
  const reportTabs = async (): Promise<string | undefined> => {
    let deadEnd: string | undefined;
    for (const at of await sweepTabs()) {
      await emit({
        type: "status",
        message: `The site opened ${handoffLabel(at)} in a tab of its own: ${at.slice(0, 120)}`,
        at: now(),
      });
      deadEnd ??= isDeadEndHref(at) ? at : undefined;
    }
    return deadEnd;
  };

  try {
    await mkdir(shotDir, { recursive: true });
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

      const outcome = await decide(p, spec.goal, maxSteps - i, history, clock.cap(DECIDE_MS), i === 0);
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
      let wedged = false;
      try {
        error = await withTimeout(act(page, p, d), clock.cap(ACT_MS), "the action");
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        // Our ceiling fired, not Playwright's. The element did not refuse: the
        // browser never answered, which is our problem to report and not the
        // site's to be graded on.
        wedged = err instanceof TimeoutError;
      }
      if (error && !wedged) failures.push(error);
      stalls = wedged ? stalls + 1 : 0;
      history.push(
        `- ${d.action}${el ? ` "${el.name}"` : ""}${error ? ` FAILED: ${error}` : " (ok)"}`,
      );

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

      // Read after the step is reported, so the note about where a click sent the
      // visitor follows the click rather than preceding it.
      const handedOff = await reportTabs();

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
      handoffs: Array.from(handoffs),
    };
    const verdict = grade(transcript);
    if (sessionId) verdict.sessionId = sessionId;

    for (const b of verdict.blockers) {
      await emit({ type: "blocker", blocker: b.blocker, detail: b.detail, at: now() });
    }
    for (const m of verdict.milestones) {
      await emit({ type: "milestone", milestone: m, at: now() });
    }
    await emit({ type: "verdict", verdict, at: now() });
  }
}
