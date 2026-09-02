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
