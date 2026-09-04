/**
 * The wire contract between the agent loop and the UI.
 *
 * Everything the run view renders arrives as one of these events over NDJSON,
 * so the browser can narrate the run live instead of waiting on a spinner.
 */

export type ActionKind = "signup" | "purchase" | "integrate" | "book" | "contact";

/** What the agent decided to do on a given turn. */
export type StepAction = "click" | "type" | "select" | "scroll" | "back" | "escape" | "done" | "give_up";

/** Why a site failed a machine visitor. Attached to the verdict, not guessed by an LLM. */
export type Blocker =
  | "bot-wall"
  | "captcha"
  | "js-gate"
  | "verification-gate"
  | "no-structured-price"
  | "dead-end-cta"
  | "form-stall"
  | "auth-gate"
  | "nav-error"
  | "loop";

/** Progress checkpoints. Which of these the agent reached is what sets the grade. */
export type Milestone =
  | "understood-offering"
  | "found-key-info"
  | "found-cta"
  | "completed-action";

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface BlockerHit {
  blocker: Blocker;
  detail: string;
}

export interface Verdict {
  grade: Grade;
  score: number;
  milestones: Milestone[];
  blockers: BlockerHit[];
  summary: string;
  steps: number;
  replayUrl?: string;
  /**
   * True when the run never reached the site, so there is nothing to grade. The
   * letter and the score are meaningless here and must not be shown: an F handed
   * to a site because our browser provider answered 503 is a libel, not a finding.
   */
  inconclusive?: true;
  /**
   * Why our side ended a run that had already reached the site, or absent when
   * the run ended on its own terms.
   *
   * Different from `inconclusive`: what the agent saw before we cut it off is
   * real, so the milestones and blockers stand. What is not real is the letter,
   * because forty of the hundred points are only winnable by finishing and this
   * run was never allowed to try. Measured: a run stopped at step 3 of 14 when
   * our free-tier daily token allowance ran out and reported C 60 against
   * docs.stripe.com, a grade about our billing.
   */
  cutShort?: string;
  /**
   * The Solari session behind this run. The recording is uploaded minutes after
   * the session is released, so the replay is fetched on demand from this id
   * rather than holding the run open waiting for it.
   */
  sessionId?: string;
}

/**
 * One turn of the loop, as it happened: what the agent chose, on what, why, and
 * whether the page allowed it.
 *
 * The same shape goes out over the wire as a `step` event and into the stored
 * record, because the live narration and the written record are the same facts
 * and there is no reason for the two to drift.
 */
export interface StepRecord {
  index: number;
  action: StepAction;
  /** The control it addressed, by accessible name, or absent for done and give_up. */
  target?: string;
  value?: string;
  /** The model's own one-line account of the move, in the first person. */
  reasoning: string;
  ok: boolean;
  error?: string;
  screenshot?: string;
  url: string;
  elementCount: number;
  at: number;
}

export type RunEvent =
  | { type: "start"; runId: string; url: string; action: ActionKind; task: string; at: number }
  | { type: "status"; message: string; at: number }
  | ({ type: "step" } & StepRecord)
  | { type: "milestone"; milestone: Milestone; at: number }
  | { type: "blocker"; blocker: Blocker; detail: string; at: number }
  | { type: "verdict"; verdict: Verdict; at: number }
  | { type: "error"; message: string; at: number };

/** One interactive thing the agent can address, by number. */
export interface PerceivedElement {
  index: number;
  role: string;
  name: string;
  /** Present for links, so we can detect dead-end CTAs like wa.me or tel:. */
  href?: string;
  /**
   * The aria snapshot handle for this element, valid only for the snapshot it
   * came from. Acting through it hits exactly the node we described to the model
   * rather than re-guessing from role and name.
   */
  ref?: string;
  /**
   * The choices inside a dropdown, folded up from its option children. A native
   * select's options are not separately clickable, so they are listed here as the
   * values a "select" can ask for rather than offered as elements of their own.
   */
  options?: string[];
  /**
   * What this control currently holds: the text in a field, the chosen option of
   * a dropdown, "checked" on a box that is ticked. Absent when it holds nothing.
   *
   * Without this a filled field and an empty one are the same three words to the
   * model, and a model that cannot see what it typed types it again. Measured on
   * a live run: the same name went into the same box on four consecutive steps,
   * every one reported ok, and the run ended on a loop blocker.
   */
  value?: string;
  /**
   * The control is on the page but cannot be operated: the snapshot marked it
   * `[disabled]`, which covers both the HTML attribute and `aria-disabled`.
   *
   * Reported rather than hidden, because the difference between "there is no
   * submit button" and "the submit button is disabled" is the difference between
   * our blindness and the site's finding. Absent when the control works, so the
   * common case costs nothing.
   */
  disabled?: true;
}

export interface Perception {
  url: string;
  title: string;
  elements: PerceivedElement[];
  /** Trimmed visible text, so the model can tell what the site actually offers. */
  text: string;
  /** True when the accessibility tree came back essentially empty. */
  jsGated: boolean;
  /** A currency amount was present as selectable text, not baked into an image. */
  hasPrice: boolean;
  /**
   * A copyable call was present on the page, measured against the whole document
   * rather than the trimmed `text` above.
   *
   * Absent rather than false when there was none, so the runs recorded before this
   * existed are distinguishable from pages that genuinely had no code: on those,
   * the grader falls back to reading the trimmed text as it always did.
   */
  hasCode?: true;
}
