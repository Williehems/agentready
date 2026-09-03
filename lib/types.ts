/**
 * The wire contract between the agent loop and the UI.
 *
 * Everything the run view renders arrives as one of these events over NDJSON,
 * so the browser can narrate the run live instead of waiting on a spinner.
 */

export type ActionKind = "signup" | "purchase" | "integrate" | "book" | "contact";

/** What the agent decided to do on a given turn. */
export type StepAction = "click" | "type" | "select" | "scroll" | "back" | "done" | "give_up";

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
   * The Solari session behind this run. The recording is uploaded minutes after
   * the session is released, so the replay is fetched on demand from this id
   * rather than holding the run open waiting for it.
   */
  sessionId?: string;
}

export type RunEvent =
  | { type: "start"; runId: string; url: string; action: ActionKind; task: string; at: number }
  | { type: "status"; message: string; at: number }
  | {
      type: "step";
      index: number;
      action: StepAction;
      target?: string;
      value?: string;
      reasoning: string;
      ok: boolean;
      error?: string;
      screenshot?: string;
      url: string;
      elementCount: number;
      at: number;
    }
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
}
