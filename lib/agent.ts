import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ACTIONS } from "./actions";
import { groqJson } from "./groq";
import { type AgentPage, perceive, renderState } from "./perceive";
import { grade, type Transcript } from "./grade";
import { closeClient, getReplayUrl, launchBrowser, releaseSession } from "./solari";
import type { ActionKind, Perception, RunEvent, StepAction } from "./types";

export const MAX_STEPS = 10;

const DecisionSchema = z.object({
  action: z.enum(["click", "type", "scroll", "back", "done", "give_up"]),
  target: z.union([z.number(), z.string()]).optional(),
  value: z.string().optional(),
  reasoning: z.string().default(""),
});

type Decision = z.infer<typeof DecisionSchema>;

const SYSTEM = `You are an AI agent operating a real web browser on behalf of a person.
You are not a crawler and not a tester: you are trying to actually get something done.

You will be given the page state as a numbered list of interactive elements plus the
visible text. Choose exactly ONE next action.

Respond with JSON only, in this shape:
{"action":"click"|"type"|"scroll"|"back"|"done"|"give_up","target":<element number>,"value":"<text>","reasoning":"<one short first-person sentence>"}

Rules:
- Address elements only by their number from the list. Never invent a number.
- "type" fills one field. Follow it with a separate "click" on the submit control.
- Use realistic placeholder details when a form needs them: name "Alex Morgan",
  email "alex.morgan.test@example.com", phone "+1 415 555 0132", company "Morgan Labs".
- NEVER enter real payment card details. If a page demands card details to continue,
  that is as far as this task goes: answer "done".
- "done" means the task is complete, OR you have reached the furthest point a visitor
  can reach without paying and without a pre-existing account credential.
- "give_up" means this site cannot be used for this task. Explain why in reasoning.
  Prefer give_up over clicking things at random.
- If the element list is empty, the page is unreadable to you: give_up.
- Do not repeat an action that already failed or already left the page unchanged.`;

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
): Promise<Decision> {
  const recent = history.length
    ? `\n\nWHAT YOU HAVE ALREADY TRIED:\n${history.slice(-5).join("\n")}`
    : "";

  try {
    const raw = await groqJson<unknown>(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `TASK: ${goal}\n\n${renderState(p, stepsLeft)}${recent}` },
      ],
      { maxTokens: 300, temperature: 0.1 },
    );
    const parsed = DecisionSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    return {
      action: "give_up",
      reasoning: "I could not form a valid next action from what the page gave me.",
    };
  } catch (err) {
    return {
      action: "give_up",
      reasoning: `My reasoning step failed: ${err instanceof Error ? err.message : String(err)}`,
    };
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

  const locator = page.getByRole(el.role, { name: el.name, exact: false }).first();
  try {
    if (d.action === "type") {
      if (!d.value) return "type was chosen with nothing to type";
      await locator.fill(d.value, { timeout: 8000 });
    } else {
      await locator.click({ timeout: 8000 });
      await settle();
    }
  } catch (err) {
    return `${el.role} "${el.name}" would not accept a ${d.action}`;
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

  await emit({ type: "start", runId, url, action, task: spec.goal, at: now() });

  const perceptions: Perception[] = [];
  const failures: string[] = [];
  const history: string[] = [];
  let declaredDone = false;
  let gaveUp = false;
  let stepCount = 0;
  let launched: Awaited<ReturnType<typeof launchBrowser>> | undefined;

  try {
    await mkdir(shotDir, { recursive: true });
    await emit({ type: "status", message: "Acquiring a stealth browser", at: now() });
    launched = await launchBrowser({ stealth: true });
    if (!launched.stealth) {
      await emit({
        type: "status",
        message: "Stealth unavailable on this plan, running a plain browser",
        at: now(),
      });
    }

    const page = (await launched.browser.newPage()) as unknown as ActPage;
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
      const p = await perceive(page);
      perceptions.push(p);

      // The screenshot is taken before the action, so each step shows exactly
      // what the agent was looking at when it made that decision.
      let shot: string | undefined;
      try {
        const buf = await page.screenshot({ type: "jpeg", quality: 55 });
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

      const d = await decide(p, spec.goal, maxSteps - i, history);
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

      const error = await act(page, p, d);
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
    // Order matters: release the session first, because the replay is only
    // uploaded once released, and close the client last, because nothing else
    // can talk to Solari afterwards and the process will not exit without it.
    let replayUrl: string | undefined;
    if (launched) {
      await emit({ type: "status", message: "Releasing the browser", at: now() });
      await releaseSession(launched.browser);
      replayUrl = await getReplayUrl(launched.solari, launched.sessionId);
      await closeClient(launched.solari);
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
    };
    const verdict = grade(transcript);
    if (replayUrl) verdict.replayUrl = replayUrl;

    for (const b of verdict.blockers) {
      await emit({ type: "blocker", blocker: b.blocker, detail: b.detail, at: now() });
    }
    for (const m of verdict.milestones) {
      await emit({ type: "milestone", milestone: m, at: now() });
    }
    await emit({ type: "verdict", verdict, at: now() });
  }
}
