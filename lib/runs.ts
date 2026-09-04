/**
 * The runs in flight, so that a second request can stop one.
 *
 * A stop has to reach the run, not just the tab watching it. The cloud browser is
 * billed by the session and the model by the token, so a client that only stopped
 * listening would keep paying for two minutes of work nobody would ever read. The
 * stream and the stop are two separate HTTP requests, so they need somewhere to
 * meet, and this is it: the run leaves a handle here, the stop pulls it.
 *
 * Module state, one process, deliberately. That is the whole of this deployment:
 * one machine, one person, one run at a time, and a run lives two minutes at the
 * outside. On more than one instance a stop would land on whichever instance
 * answered rather than the one holding the browser, and then this map becomes a
 * row keyed by run id. Nothing else about the shape of it would change.
 */

const inFlight = new Map<string, AbortController>();

/** Announce a run, and take the handle a stop will pull. */
export function beginRun(runId: string): AbortController {
  const controller = new AbortController();
  inFlight.set(runId, controller);
  return controller;
}

/**
 * Stop a run.
 *
 * False means there is nothing by that name, which is the ordinary outcome of a
 * stop that arrived a moment after the run had already finished. The caller wants
 * to know, because the answer decides whether the browser tab should give up on
 * the stream itself.
 */
export function stopRun(runId: string): boolean {
  const controller = inFlight.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Forget a run once it has finished tearing itself down. */
export function endRun(runId: string): void {
  inFlight.delete(runId);
}

/** Whether a run is still one this process could stop. */
export function isRunning(runId: string): boolean {
  return inFlight.has(runId);
}

/**
 * How many runs a day this deployment is willing to pay for.
 *
 * A run opens a metered cloud browser and spends model tokens, so an audit
 * endpoint on a public URL is a spending endpoint on a public URL. Measured over
 * the 34 runs on disk that recorded their spend: 185 model calls and 362,337
 * prompt tokens, so about 10,600 tokens for an average run and about 20,000 for a
 * full ten-step one. The free daily allowance is 200,000, which is ten runs in the
 * worst case, so ten is the default and the number is not arbitrary.
 *
 * Raise it with AUDIT_DAILY_CAP once someone else is paying for the tokens.
 */
const DAILY_CAP = Number(process.env.AUDIT_DAILY_CAP ?? 10);

/** How long one visitor waits between runs, so a single tab cannot drain the day. */
const COOLDOWN_MS = 60_000;

/** Runs started today, and by whom, reset when the UTC date rolls over. */
let day = "";
let started = 0;
const lastByVisitor = new Map<string, number>();

/**
 * Forget yesterday.
 *
 * Every function that reads or writes the day's tally goes through here first, so
 * that they cannot disagree about which day it is. A cooldown recorded at 23:59 and
 * asked about at 00:01 is not a cooldown, and the visitor is owed the run.
 */
function roll(at: number): void {
  const today = new Date(at).toISOString().slice(0, 10);
  if (today === day) return;
  day = today;
  started = 0;
  lastByVisitor.clear();
}

/**
 * Whether this request may start a run, and a sentence for the visitor if not.
 *
 * One at a time is not a limitation invented here, it is the deployment this
 * product already documents above: module state, one process, one browser. Said
 * out loud with a number rather than left as an assumption, because the failure it
 * prevents is a stranger's traffic spending someone's balance, and that failure is
 * silent until the balance is gone.
 */
export function mayStart(visitor: string, at = Date.now()): { ok: true } | { ok: false; why: string } {
  roll(at);

  if (inFlight.size > 0) {
    return {
      ok: false,
      why: "An audit is already running. Runs drive one real browser at a time, so this one has to wait for it. Try again in a minute or two.",
    };
  }

  if (started >= DAILY_CAP) {
    return {
      ok: false,
      why: `This instance has run its ${DAILY_CAP} audits for today. The model behind it is on a free daily allowance and running past it would return grades about our billing rather than about the site. Clone the repository and use your own keys, or come back tomorrow.`,
    };
  }

  const last = lastByVisitor.get(visitor);
  if (last !== undefined && at - last < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (at - last)) / 1000);
    return { ok: false, why: `You have just run one. Another in ${wait} seconds.` };
  }

  return { ok: true };
}

/** Charge a started run against today's budget and the visitor's cooldown. */
export function chargeStart(visitor: string, at = Date.now()): void {
  roll(at);
  started++;
  lastByVisitor.set(visitor, at);
}

/** What today's budget has left, for a caller that wants to say so out loud. */
export function budget(at = Date.now()): { used: number; cap: number } {
  const today = new Date(at).toISOString().slice(0, 10);
  return { used: today === day ? started : 0, cap: DAILY_CAP };
}

/**
 * Forget everything the gate remembers, and drop any run it thinks is in flight.
 * Tests only: a run left behind by one test would refuse every run in the next.
 */
export function resetGate(): void {
  inFlight.forEach((controller) => controller.abort());
  inFlight.clear();
  day = "";
  started = 0;
  lastByVisitor.clear();
}
