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

/**
 * The status the SDK dropped on the floor.
 *
 * Its HTTP layer retries 502/503/504 and network faults, then throws
 * `Solari POST /sessions: exhausted 2 attempts` with no status of its own and the
 * last real failure hidden in `cause`. Read as-is, an outage on their side is
 * indistinguishable from a bad key or a spent plan, and the one thing the reader
 * needs to know is which. Seen live: a run died on that exact string.
 */
function rootCause(err: SolariError): { status?: number; text: string } {
  let cause: unknown = err.cause;
  for (let hop = 0; hop < 4 && cause; hop++) {
    if (cause instanceof SolariError) {
      if (cause.status) return { status: cause.status, text: cause.message };
      cause = cause.cause;
      continue;
    }
    if (cause instanceof Error) return { text: cause.message };
    return { text: String(cause) };
  }
  return { text: err.message };
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
        break;
    }
    if (/exhausted \d+ attempts/.test(err.message)) {
      const root = rootCause(err);
      const why =
        root.status && root.status >= 500
          ? `Solari answered ${root.status} to every attempt, so the fault is on their side, not with this key.`
          : `Solari could not be reached: ${root.text}`;
      return new SolariUnavailableError(`${why} Nothing was charged and no session was created.`);
    }
    if (err.status === 401 || err.status === 403) {
      return new SolariUnavailableError(
        "Solari rejected the API key. Check SOLARI_API_KEY in .env.local.",
        err.code,
      );
    }
    if (err.status === 429) {
      return new SolariUnavailableError("Solari is rate limiting this key. Try again shortly.", err.code);
    }
    return new SolariUnavailableError(err.message, err.code);
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

  // Three attempts, not the default two, and a backoff long enough to be worth
  // making: session creation is the one call the whole run depends on, and a run
  // lost to a single 503 costs the user two minutes and tells them nothing about
  // their site. Seen live: two attempts, both 503, verdict F. The retries are
  // free, and 502/503/504 is all the SDK will retry.
  const solari = new Solari({ apiKey, maxAttempts: 3, backoffMs: 1500 });
  /**
   * Two re-launches, and a health probe with room to answer.
   *
   * The SDK probes the browser after connecting and calls it unhealthy if it does
   * not respond in 2s. Measured from here, a bare GET to their API is already
   * 1.7s of round trip, so a 2s budget on a browser that has just booted is
   * inside the noise: a third live run died on exactly that while the API was
   * otherwise fine. A slow browser is worth waiting for, and a genuinely dead one
   * still fails, just later.
   */
  const base: LaunchOptions = { recording: true, retries: 2, probeTimeoutMs: 6000 };
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
 * recording is only uploaded once the session is released. Returns the reason
 * when release did not confirm, which is also the likeliest reason a replay
 * never turns up: swallowing it here is what makes a missing replay a mystery.
 */
export async function releaseSession(browser: BrowserSession): Promise<string | undefined> {
  try {
    await browser.close();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Close the client. Must be the last thing to run, and must run even when the
 * run threw, or the Node event loop stays alive and the request never finishes.
 */
export async function closeClient(solari: Solari): Promise<void> {
  await solari.close().catch(() => {});
}

export interface ReplayLookup {
  url?: string;
  /** True when the recording is merely not uploaded yet, so asking again is worth it. */
  pending?: boolean;
  /** Why there is no replay. Worth surfacing: Witness is half the product. */
  reason?: string;
}

/**
 * One lookup, no waiting.
 *
 * Measured on this plan: a released session 404s continuously for at least 103
 * seconds, then resolves some minutes later. So nothing may hold a request open
 * waiting for a recording. Ask once, report `pending`, and ask again later.
 */
export async function fetchReplayUrl(solari: Solari, sessionId: string): Promise<ReplayLookup> {
  try {
    const { url } = await solari.sessions.getReplayUrl(sessionId);
    return { url };
  } catch (err) {
    if (err instanceof SolariError) {
      const envelope = /exhausted \d+ attempts/.test(err.message) ? rootCause(err) : undefined;
      const status = envelope?.status ?? err.status;

      // Not uploaded yet is the ordinary answer for the first minutes, and it has
      // to be recognised through the retry envelope as well as bare, or the run
      // that finished fastest is the one told its recording is gone.
      if (status === 404) {
        return { pending: true, reason: "the recording has not finished uploading yet" };
      }

      // A failure to reach Solari is not the same as a recording that does not
      // exist, so the page keeps asking and the sentence says whose side it is.
      //
      // Said in words because the envelope carries neither code nor status of its
      // own, which is the whole point of rootCause above. Measured on run
      // mtmvbwgn-6pofvk, the first A this product ever gave: under the verdict,
      // where the replay link belongs, the card read "No replay yet: undefined:
      // Solari GET /sessions/ip-10-0-10-9%3A...%2Freplay-url: exhausted 2
      // attempts." That is `${err.code ?? err.status}` resolving to undefined
      // twice over, printed at the reader.
      if (envelope) {
        return {
          pending: true,
          reason: status
            ? `Solari answered ${status} to every attempt, so this is their side and not a lost recording`
            : `Solari could not be reached (${envelope.text})`,
        };
      }

      const named = err.code ?? (status ? `HTTP ${status}` : undefined);
      return {
        reason: named ? `Solari refused the recording (${named}): ${err.message}` : err.message,
      };
    }
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}
