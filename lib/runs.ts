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
