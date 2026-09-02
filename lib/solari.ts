import { Solari, SolariError, type BrowserSession, type LaunchOptions } from "@solarisdk/browser";

/**
 * Solari lifecycle. Two things in here exist purely because getting them wrong
 * is silent and expensive:
 *
 *  1. `solari.close()` must run in a finally block. The client keeps a loopback
 *     proxy server open for connection retries, and that handle keeps the Node
 *     event loop alive: skip it and the request never finishes.
 *  2. `browser.close()` releases the session slot. Closing only the page would
 *     hold a concurrency slot until the plan deadline.
 */

export interface LaunchResult {
  solari: Solari;
  browser: BrowserSession;
  sessionId: string;
  /** False when stealth was requested but the plan refused it. */
  stealth: boolean;
}

export class SolariUnavailableError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SolariUnavailableError";
  }
}

function friendly(err: unknown): SolariUnavailableError {
  if (err instanceof SolariError) {
    switch (err.code) {
      case "ConcurrencyLimitExceeded":
        return new SolariUnavailableError(
          "All browser slots are busy. Wait for a run to finish and try again.",
          err.code,
        );
      case "PlanLimitExceeded":
        return new SolariUnavailableError(
          "The Solari plan limit was reached for this period.",
          err.code,
        );
      case "BrowserUnhealthy":
        return new SolariUnavailableError(
          "Solari could not start a healthy browser. Retrying usually clears it.",
          err.code,
        );
      case "FeatureRequiresPlan":
        return new SolariUnavailableError(
          "That feature is not on the current Solari plan.",
          err.code,
        );
      default:
        return new SolariUnavailableError(err.message, err.code);
    }
  }
  return new SolariUnavailableError(err instanceof Error ? err.message : String(err));
}

/**
 * Launch a recording browser. Stealth is what lets us see what a real bot-walled
 * site does, but it is a paid feature, so if the plan refuses it we fall back to
 * a plain browser and say so rather than failing the whole run.
 */
export async function launchBrowser(opts: { stealth?: boolean } = {}): Promise<LaunchResult> {
  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey) throw new SolariUnavailableError("SOLARI_API_KEY not set");

  const solari = new Solari({ apiKey });
  const base: LaunchOptions = { recording: true, retries: 1 };
  const wantStealth = opts.stealth !== false;

  try {
    if (wantStealth) {
      try {
        const browser = await solari.launch({ ...base, stealth: true });
        return { solari, browser, sessionId: browser.id, stealth: true };
      } catch (err) {
        if (!(err instanceof SolariError) || err.code !== "FeatureRequiresPlan") throw err;
        // Fall through to a plain browser.
      }
    }
    const browser = await solari.launch(base);
    return { solari, browser, sessionId: browser.id, stealth: false };
  } catch (err) {
    await solari.close().catch(() => {});
    throw friendly(err);
  }
}

/**
 * Release the session slot. Must happen before asking for a replay, because the
 * recording is only uploaded once the session is released.
 */
export async function releaseSession(browser: BrowserSession): Promise<void> {
  await browser.close().catch(() => {});
}

/**
 * Close the client. Must be the last thing to run, and must run even when the
 * run threw, or the Node event loop stays alive and the request never finishes.
 */
export async function closeClient(solari: Solari): Promise<void> {
  await solari.close().catch(() => {});
}

/**
 * The replay upload happens asynchronously after release, so the first poll
 * routinely 404s on a perfectly good recording. Returns undefined rather than
 * throwing: a missing replay is a degraded result, not a failed run.
 */
export async function getReplayUrl(
  solari: Solari,
  sessionId: string,
  attempts = 5,
  delayMs = 1500,
): Promise<string | undefined> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const { url } = await solari.sessions.getReplayUrl(sessionId);
      if (url) return url;
    } catch (err) {
      if (err instanceof SolariError && err.status === 404) continue;
      return undefined;
    }
  }
  return undefined;
}
