import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ACTIONS } from "./actions";
import { Deadline, withTimeout } from "./deadline";
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

const DecisionSchema = z.object({
  action: z.enum(["click", "type", "scroll", "back", "done", "give_up"]),
  target: z.union([z.number(), z.string()]).optional(),
  value: z.string().optional(),
  reasoning: z.string().default(""),
});

type Decision = z.infer<typeof DecisionSchema>;

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
{"action":"click"|"type"|"scroll"|"back"|"done"|"give_up","target":<element number>,"value":"<text>","reasoning":"<one short first-person sentence>"}

Rules:
- Address elements only by their number from the list. Never invent a number.
- "type" fills one field. Follow it with a separate "click" on the submit control.
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
    const parsed = DecisionSchema.safeParse(raw);
    if (parsed.success) return { kind: "decided", decision: parsed.data };
    // A malformed answer is the model's failure, not the site's, but it is also
    // the model looking at this page: one retry-free give_up keeps the run honest
    // without pretending the site caused it.
    return {
      kind: "unavailable",
      why: "the model did not return a usable action for this page",
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
}

interface Locatorish {
  first(): Locatorish;
  click(opts?: { timeout?: number }): Promise<void>;
  fill(value: string, opts?: { timeout?: number }): Promise<void>;
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
  /** Set when the run ended for a reason of ours rather than the site's. */
  let abandoned: string | undefined;
  let launched: Awaited<ReturnType<typeof launchBrowser>> | undefined;

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
      const error = await withTimeout(act(page, p, d), clock.cap(ACT_MS), "the action").catch(
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      if (error) failures.push(error);
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
    }
  } catch (err) {
    await emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      at: now(),
    });
  } finally {
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
