/**
 * Time limits.
 *
 * Every slow thing in this product is on the other end of a network: a browser
 * in someone else's datacentre driving a page that may never settle, and a model
 * endpoint that may never answer. Measured here: a run wedged for over ten
 * minutes with no error, no output and the HTTP request still open, because one
 * call in the loop had no ceiling on it.
 *
 * So the rule is that no call to anything remote is awaited bare. Individual
 * timeouts stop one wedged call from taking the run, and the run-wide deadline
 * stops ten merely-slow calls from doing the same thing more politely.
 */

export class TimeoutError extends Error {
  constructor(what: string, readonly ms: number) {
    super(`${what} did not finish within ${Math.round(ms / 1000)}s`);
    this.name = "TimeoutError";
  }
}

/**
 * Reject if `work` has not settled in `ms`.
 *
 * The abandoned promise keeps running: there is no way to cancel a Playwright
 * call already in flight. It gets a no-op catch so its eventual rejection does
 * not surface later as an unhandled rejection and take the process down.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
  });
  work.catch(() => {});
  return Promise.race([work, bell]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * A budget for a whole run, so the sum of legal-but-slow steps stays bounded.
 *
 * `cap` is the useful part: a call's own timeout should never outlive the run it
 * belongs to, or the last step of a run that is already over its budget can
 * still add a minute to it.
 */
export class Deadline {
  private readonly startedAt = Date.now();
  private readonly endsAt: number;

  constructor(readonly budgetMs: number) {
    this.endsAt = this.startedAt + budgetMs;
  }

  get remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  get expired(): boolean {
    return this.remainingMs === 0;
  }

  get spentSeconds(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  /** The shorter of a call's own timeout and what is left of the run. */
  cap(ms: number): number {
    return Math.max(1, Math.min(ms, this.remainingMs));
  }
}
