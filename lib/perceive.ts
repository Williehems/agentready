import { withTimeout } from "./deadline";
import type { Perception, PerceivedElement } from "./types";

/**
 * Perception: turn a live page into the small text state an LLM can reason over.
 *
 * We read the accessibility tree rather than raw HTML. It is an order of
 * magnitude smaller, it contains exactly the things a visitor can act on, and
 * when it comes back empty that emptiness is itself the finding: the site is a
 * blank wall to anything that is not a full rendering browser with JS.
 *
 * The tree arrives as Playwright's aria snapshot in "ai" mode, an indented
 * outline where every node carries a handle:
 *
 *   - generic [ref=e2]:
 *     - heading "Example Domain" [level=1] [ref=e3]
 *     - link "Learn more" [ref=e6] [cursor=pointer]:
 *       - /url: https://iana.org/domains/example
 *
 * Those handles are why we parse this instead of using the older accessibility
 * tree API, which no longer exists in Playwright: acting on `aria-ref=e6` hits
 * the exact node we described to the model rather than re-resolving a role and
 * name that might match three things. They are also why an input carrying no
 * label at all is still addressable to us.
 */

/** Only the page surface this module needs, so we do not couple to a Playwright version. */
export interface AgentPage {
  url(): string;
  title(): Promise<string>;
  ariaSnapshot(options?: { mode?: "ai" | "default" }): Promise<string>;
  evaluate<R>(fn: string | (() => R)): Promise<R>;
}

/** ARIA roles a visitor can actually operate. Anything else is scenery. */
const INTERACTIVE = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "slider",
  "spinbutton",
]);

/**
 * Repeats of one link or button are redundant navigation and worth collapsing.
 * Repeats of a form field are not: a page with a login form and a signup form
 * carries two fields labelled "username", and dropping one loses half a flow.
 */
const COLLAPSIBLE = new Set(["link", "button", "menuitem", "tab", "option"]);

/**
 * Controls whose options live inside them rather than on the page. A native
 * select renders its options in an OS layer, so they are not clickable nodes and
 * an agent that presses one waits out its timeout for nothing: measured on a real
 * booking form, clicking `option "10:00 AM"` failed after 8s, every time, while
 * `selectOption` on the parent took 36ms. Their labels are folded into the parent
 * as choices instead.
 */
const SELECTABLE = new Set(["combobox", "listbox"]);

/**
 * Roles whose current contents are part of the page state.
 *
 * A filled field and an empty one are the same three words to a model shown only
 * a role and a name, and a model that cannot see what it typed types it again.
 * Measured on a live run: the same name went into the same box on steps 7, 8, 9
 * and 10, every one reported ok, and the run ended on a loop blocker.
 */
const VALUED = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
  "checkbox",
  "radio",
  "switch",
]);

/** How much of a value to carry. Enough to recognise it, not enough to eat the budget. */
const MAX_VALUE = 60;

/** How many choices to show per dropdown. A country list has 200 and needs none of them. */
const MAX_OPTIONS = 12;

/**
 * Roles that take the page over while they are open. Everything behind one is
 * covered by its backdrop, so a click on it can never land.
 */
const MODAL = new Set(["dialog", "alertdialog"]);

/**
 * Is a modal actually covering the page?
 *
 * The accessibility tree cannot say, and this is the whole reason the DOM has to
 * be asked. A modal hidden with `opacity: 0` and `pointer-events: none` keeps
 * every one of its controls in the tree, so a dialog node is not evidence of an
 * open dialog. Verified in the markup of a live booking site:
 *
 *   .overlay      { position: fixed; inset: 0; opacity: 0; pointer-events: none }
 *   .overlay.open { opacity: 1; pointer-events: all }
 *
 * with `role="dialog" aria-modal="true"` on the overlay from page load. Treating
 * that as open sent the agent clicking into a void, 25s a step, twice.
 * `display: none` and `visibility: hidden` do drop out of the tree, so it is the
 * rest that matter here.
 *
 * Covering means it takes pointer events and one of three things is true: it
 * declares itself modal, it fills most of the viewport, or it owns the middle of
 * the screen. A visible chat widget with `role="dialog"` traps nothing and must
 * not shrink the page to itself.
 *
 * The third test is there because the first two both missed a real trap. Measured
 * on resend.com/docs/api-reference/api-keys/create-api-key, on the Mintlify search
 * palette our own agent opened at step 1: `role="dialog"`, no `aria-modal`, and a
 * box of 640x62 in a 1280x720 viewport, which is 4% of it. So sixty elements were
 * offered at every step afterwards and three clicks in a row were intercepted by
 * `<div> "Ask AssistantUse the up and down arrow k"`, ten seconds each.
 *
 * What was actually covering the page was not the dialog but the layer holding it:
 * a `role="presentation"` div, `position: fixed`, inset to all four edges, taking
 * pointer events, containing the dialog, with a second one behind it painting the
 * page out at 40% black. The middle of the screen hit-tested to that layer. The
 * aria snapshot did carry `dialog "Search or ask a question..."` all along, so
 * `reachable` could have found it from the first step; only this test was missing.
 *
 * Asking `elementFromPoint` is the same question the browser itself answers when
 * it decides where a click goes, which is the only question that matters here.
 *
 * Runs in the page, so it closes over nothing, and holds no named inner function:
 * esbuild's keep-names wraps those in a `__name()` helper that does not exist
 * inside the page, and the whole probe dies with `__name is not defined`.
 */
export function modalIsOpen(): boolean {
  const candidates = document.querySelectorAll(
    'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]',
  );

  for (const el of Array.from(candidates)) {
    const own = getComputedStyle(el);
    if (own.pointerEvents === "none") continue;

    // Opacity and visibility inherit their effect down the tree: an overlay
    // faded out by its wrapper is just as untouchable as one faded out itself.
    let hidden = false;
    let node: Element | null = el;
    for (let hop = 0; hop < 8 && node; hop++, node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;

    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;

    const viewport = window.innerWidth * window.innerHeight;
    if (viewport <= 0) continue;

    if (el.getAttribute("aria-modal") === "true") return true;
    if ((box.width * box.height) / viewport >= 0.55) return true;

    // Whatever the browser would hand a click aimed at the centre of the page.
    const top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    if (!top) continue;

    // Inside the dialog: it is between the visitor and the page at the most
    // central point there is, whatever its size.
    if (el.contains(top)) return true;

    // Otherwise it has to be the layer the dialog lives in, positioned out of the
    // flow and covering the page. A backdrop is inset to all four edges by
    // construction, so the bar is high; the margin is for a scrollbar. An ordinary
    // page wrapper that happens to be hit at the centre fails both of these, and a
    // dialog somewhere off to the side is not in this chain at all.
    if (!top.contains(el)) continue;
    const layer = getComputedStyle(top);
    if (layer.position !== "fixed" && layer.position !== "absolute") continue;
    const over = top.getBoundingClientRect();
    if ((over.width * over.height) / viewport >= 0.9) return true;
  }

  return false;
}

const MAX_ELEMENTS = 60;
const MAX_TEXT = 2800;
/**
 * How many of the sixty slots the page's furniture may hold when its own content
 * wants them all.
 *
 * Measured on docs.stripe.com/keys, which is where this number comes from. The
 * snapshot has 1145 nodes and 184 controls. Its `article` holds 97 of them; the
 * rest are two skip links, a search, an assistant, sign-in and create-account, six
 * product tabs, a 32-entry sidebar, three locale pickers and three breadcrumbs.
 * In document order the furniture comes first, so the sixty slots went 57 to the
 * furniture and 3 to the article, and the agent read a page whose body it had
 * barely seen. Four of that run's ten steps were spent going back to it.
 *
 * Eighteen leaves the global search, the account links and the top-level tabs,
 * which is the least a site's own map can be and still be a map. The content side
 * is not given a floor in return: a page whose body really is four links should
 * not have the rest of its list held empty for it.
 */
const MIN_CHROME = 18;
/**
 * Containers whose interiors are furniture wherever they sit.
 *
 * Wherever, because Stripe's `toolbar "Actions"` is inside the article and holds
 * "Ask about this page", "Copy for LLM", "View as Markdown" and "Install tools":
 * four slots of page apparatus in the middle of the content. `search` is not here,
 * a searchbox being a control an agent may well want, and neither is `form`.
 */
const CHROME = new Set([
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "tablist",
  "toolbar",
]);
/**
 * What a page calls its own content, best first.
 *
 * `main` when the page has one, and `article` when it does not: verified on two
 * real snapshots rather than assumed, because the assumption was wrong.
 * plausible.io/register is rooted at `main` and has no article;
 * docs.stripe.com/keys has no `main`, no `banner` and no `complementary`, and its
 * body is an `article` with the sidebar outside it as plain list items under
 * `generic`. A rule written for landmarks alone would have done nothing on Stripe.
 */
const CONTENT_ANCHORS = ["main", "article"];
/**
 * How many controls that cannot be operated are worth describing.
 *
 * A greyed-out submit is the answer to why a form is stuck, so a few belong in
 * the list. A disabled table of forty rows is not an answer to anything, and
 * every line of it is prompt budget spent on something the agent cannot press.
 */
const MAX_DISABLED = 8;
/** Snapshots run a few KB. Past this the page is beyond what one prompt can hold. */
const MAX_SNAPSHOT = 500_000;
/** How far back to look for a label when a control has no accessible name. */
const LABEL_LOOKBACK = 4;
/** Reading one page. Generous, because a heavy page under a cold cache is slow. */
const PERCEIVE_MS = 15_000;

/** Currency as selectable text. Deliberately conservative to avoid false positives. */
const PRICE_RE =
  /(?:[$€£¥₦]|\bNGN\b|\bUSD\b|\bEUR\b|\bGBP\b|\bRs\.?)\s?\d[\d,.]*|\d[\d,.]*\s?(?:USD|EUR|GBP|NGN)\b/i;

/**
 * Does this text carry a price a machine could read?
 *
 * Exported so the run can ask the same question of a page it did not walk through.
 * One definition of a price, used everywhere, or the answer depends on who asked.
 */
export function looksPriced(text: string): boolean {
  return PRICE_RE.test(text);
}

/**
 * One outline line: indent, "- ", a role, an optional quoted accessible name,
 * any number of [flag] or [flag=value] brackets, then an optional ": text" tail.
 * The quoted group is matched before the brackets, which is what stops a name
 * like "username:" from being read as the start of that tail.
 */
const LINE =
  /^(\s*)-\s+([a-z/][\w/-]*)\s*(?:"((?:[^"\\]|\\.)*)")?\s*((?:\[[^\]]*\]\s*)*)(?::\s*(.*))?$/i;

interface Node {
  indent: number;
  role: string;
  name: string;
  ref?: string;
  href?: string;
  disabled: boolean;
  options?: string[];
  value?: string;
}

function flag(flags: string, name: string): string | undefined {
  const m = new RegExp(`\\[${name}(?:=([^\\]]*))?\\]`).exec(flags);
  return m ? (m[1] ?? "") : undefined;
}

/** The node a child line hangs off: the nearest one above it that is less indented. */
function parentOf(nodes: Node[], indent: number): Node | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].indent < indent) return nodes[i];
  }
  return undefined;
}

/**
 * A snapshot value with the quotes Playwright puts around non-text ones removed,
 * so `spinbutton "Guests": "3"` reports 3 rather than `"3"`.
 */
function unquote(s: string): string {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  return (m ? m[1].replace(/\\(.)/g, "$1") : s).slice(0, MAX_VALUE);
}

/**
 * The dropdown a bare option belongs to. Looks one level past its parent so an
 * option wrapped in an optgroup still finds its control.
 */
function enclosingSelect(nodes: Node[], indent: number): Node | undefined {
  let depth = indent;
  for (let level = 0; level < 2; level++) {
    let parent: Node | undefined;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].indent < depth) {
        parent = nodes[i];
        break;
      }
    }
    if (!parent) return undefined;
    if (SELECTABLE.has(parent.role)) return parent;
    if (parent.indent === 0) return undefined;
    depth = parent.indent;
  }
  return undefined;
}

/**
 * Give a nameless control the nearest label above it, which is what a sighted
 * reader uses. A bare `textbox` becomes `username:` when that is the cell to
 * its left, and the model gets something it can reason about.
 */
function inferName(nodes: Node[], before: number): string {
  const floor = Math.max(0, before - LABEL_LOOKBACK);
  for (let i = before - 1; i >= floor; i--) {
    if (nodes[i].name) return nodes[i].name.slice(0, 60);
  }
  return "";
}

/**
 * The window of nodes a visitor can actually reach.
 *
 * An open modal covers the page behind it, but the page behind it is still in
 * the accessibility tree, so the model is offered buttons whose click cannot
 * land. Measured on a live run: with the booking modal open, three consecutive
 * clicks on "Book Now" and "Book this ritual" behind the backdrop each burned
 * their whole ceiling, ending the run seven steps in. When a modal is open, only
 * what is inside it is on offer.
 *
 * The topmost modal wins, and a modal holding nothing to operate is ignored
 * rather than reported as an empty page.
 */
function reachable(nodes: Node[]): Node[] {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!MODAL.has(nodes[i].role)) continue;
    const open = nodes[i].indent;
    let end = nodes.length;
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j].indent <= open) {
        end = j;
        break;
      }
    }
    const inside = nodes.slice(i + 1, end);
    if (inside.some((n) => INTERACTIVE.has(n.role) && !n.disabled)) return inside;
  }
  return nodes;
}

/**
 * Which of these nodes are the page's furniture rather than its content, one flag
 * per node in the same order.
 *
 * Two rules, and a node needs to fail only one of them. It is furniture if any
 * container above it is furniture, and it is furniture if the page named a content
 * container somewhere and this node is not inside it. The second rule is what
 * demotes a sidebar that is only `generic` and `list`, which no landmark rule can
 * reach: on docs.stripe.com that sidebar is 32 of the 60 slots.
 *
 * A page that names no content container has no second rule to fail, so all of it
 * is content bar the furniture proper. That is the honest reading of a page that
 * did not say, and it is also every page this parser handled before zones existed.
 *
 * Ancestors are tracked as a stack of open containers, popped by indent, so the
 * whole classification is one pass.
 */
function furniture(nodes: Node[]): boolean[] {
  const anchor = CONTENT_ANCHORS.find((role) => nodes.some((n) => n.role === role));
  const flags: boolean[] = [];
  const open: Node[] = [];
  for (const n of nodes) {
    while (open.length && open[open.length - 1].indent >= n.indent) open.pop();
    const belowChrome = open.some((a) => CHROME.has(a.role));
    const insideContent = !anchor || open.some((a) => a.role === anchor);
    flags.push(belowChrome || !insideContent);
    open.push(n);
  }
  return flags;
}

/**
 * Turn one aria snapshot into the numbered list the model addresses by index.
 *
 * `modalOpen` comes from the DOM, never from the snapshot, and defaults to false:
 * without positive evidence that a dialog is covering the page, the whole page is
 * on offer. Guessing the other way costs a run.
 */
export function parseAriaSnapshot(snapshot: string, modalOpen = false): PerceivedElement[] {
  const nodes: Node[] = [];

  for (const raw of snapshot.slice(0, MAX_SNAPSHOT).split("\n")) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const [, pad, rawRole, quoted, flags = "", trailing] = m;
    const role = rawRole.toLowerCase();
    const indent = pad.length;

    // A link's target arrives as its own child line: "- /url: /pricing". Attach
    // it to the nearest node above that is shallower, which is the link itself.
    if (role === "/url") {
      const owner = parentOf(nodes, indent);
      if (owner) owner.href = (trailing ?? "").trim();
      continue;
    }

    const named = (quoted ?? "").replace(/\\(.)/g, "$1").trim();
    const tail = (trailing ?? "").trim();
    const valued = VALUED.has(role);

    // A nameless field's tail is what it holds, not what it is called: reading it
    // as a name shows the model `[textbox] SPA10`, a box that appears to be named
    // after its own contents, and hides that it is already filled.
    const name = (named || (valued ? "" : tail)).slice(0, 120);

    /**
     * A field's contents arrive in one of two shapes, and which one depends only
     * on whether the input carries a placeholder:
     *
     *   - textbox "Preferred Date" [ref=e4]: 2026-09-07
     *   - textbox "Your Name" [ref=e341]:
     *     - /placeholder: Full name
     *     - text: Alex Morgan
     *
     * Both verified against Playwright's renderer and against the live booking
     * form that caused the loop. Reading only the inline one reports every
     * placeholder-bearing field as empty, which is most of a real form.
     */
    if (role === "text" && tail) {
      const owner = parentOf(nodes, indent);
      if (owner && VALUED.has(owner.role) && owner.value === undefined) {
        owner.value = unquote(tail);
      }
      // Still recorded: a label above a nameless control is found by looking back
      // over these, so consuming the line would cost that control its name.
    }

    // An option belonging to a dropdown is folded into it. Left on its own it is
    // an element the model will press and cannot, and seventeen time slots eat a
    // third of the element budget describing one control.
    if (role === "option") {
      const owner = enclosingSelect(nodes, indent);
      if (owner) {
        (owner.options ??= []).push(name);
        if (flag(flags, "selected") !== undefined) owner.value = name.slice(0, MAX_VALUE);
        continue;
      }
    }

    const checked = valued ? flag(flags, "checked") : undefined;

    nodes.push({
      indent,
      role,
      name,
      ref: flag(flags, "ref"),
      disabled: flag(flags, "disabled") !== undefined,
      // A tick has no text, so its state is the flag. Unticked carries no flag at
      // all, which is why an absent value has to mean empty rather than unknown.
      value: checked !== undefined ? checked || "checked" : valued && tail ? unquote(tail) : undefined,
    });
  }

  const out: PerceivedElement[] = [];
  const seen = new Set<string>();
  const visible = modalOpen ? reachable(nodes) : nodes;

  // A control that cannot be operated is still described, but never in a slot a
  // working one wanted.
  //
  // Described, because dropping it makes the site look emptier than it is. The
  // snapshot marks these `[disabled]` and hands over a usable ref; we were the
  // ones throwing them away. Measured on plausible.io's signup: a visible 416x42
  // submit, disabled until a captcha resolves, was absent from our element list
  // while the page text plainly read "Start my free trial", so the agent reported
  // no submit button on a page that has one. "There is no submit button" reads as
  // our failure to see. "The submit button is disabled" is a finding an owner can
  // act on.
  //
  // Ranked below the live ones, because they are context and not actions. Every
  // working control is counted first and its slot held back, so a page of dead
  // rows can never crowd out the buttons a visitor could actually press. The
  // count is of nodes rather than of emitted elements, so duplicate links make it
  // an overestimate: that errs toward keeping live controls, which is the side to
  // err on.
  const live = visible.filter((n) => INTERACTIVE.has(n.role) && !n.disabled).length;
  let deadLeft = Math.min(MAX_DISABLED, Math.max(0, MAX_ELEMENTS - live));

  /**
   * How many slots the page's own furniture may take, so a site's map can never
   * crowd out the thing the map points at.
   *
   * The content side asks for what it wants and the furniture gets the rest, down
   * to MIN_CHROME and no further. `wanted` counts nodes rather than the elements
   * they collapse to, so it overestimates; the top-up pass below hands back
   * whatever that overestimate reserved and nobody used.
   *
   * Computed over `visible`, which matters: behind an open modal the page has
   * already been narrowed to the modal, so there is no furniture there to hold
   * back and every control in it is content.
   */
  const chrome = furniture(visible);
  const wanted = visible.filter(
    (n, i) => !chrome[i] && INTERACTIVE.has(n.role) && !n.disabled,
  ).length;
  let chromeLeft = MAX_ELEMENTS - Math.min(wanted, MAX_ELEMENTS - MIN_CHROME);

  /** Describe one node, or report that its slot went unspent. */
  const push = (i: number): boolean => {
    const n = visible[i];
    if (n.disabled && deadLeft <= 0) return false;

    const name = n.name || inferName(visible, i);
    if (COLLAPSIBLE.has(n.role)) {
      // State is part of the key. A live control and a dead one of the same name
      // are two different facts about the page, and a dead one arriving first
      // must not swallow the one that works.
      const key = `${n.role}::${name.toLowerCase()}::${n.href ?? ""}::${n.disabled}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }

    const el: PerceivedElement = { index: out.length + 1, role: n.role, name };
    if (n.ref) el.ref = n.ref;
    if (n.href) el.href = n.href;
    if (n.options?.length) el.options = n.options.slice(0, MAX_OPTIONS);
    if (n.value) el.value = n.value;
    if (n.disabled) {
      el.disabled = true;
      deadLeft--;
    }
    out.push(el);
    return true;
  };

  const held: number[] = [];
  for (let i = 0; i < visible.length && out.length < MAX_ELEMENTS; i++) {
    if (!INTERACTIVE.has(visible[i].role)) continue;
    if (chrome[i] && chromeLeft <= 0) {
      held.push(i);
      continue;
    }
    if (push(i) && chrome[i]) chromeLeft--;
  }

  // Furniture held back above goes back in if the content did not want the room
  // after all. Repeated links collapse into one element, so the reserve can go
  // unspent, and describing less of the page than the budget allows buys nothing.
  for (let i = 0; i < held.length && out.length < MAX_ELEMENTS; i++) push(held[i]);

  return out;
}

/**
 * Never reach for a page method without a try around the call itself. An SDK
 * that has dropped the method throws synchronously, before any `.catch()` on
 * the returned promise can attach, and takes the whole run with it.
 *
 * The timeout is the other half of that. `ariaSnapshot` and `evaluate` take no
 * timeout option of their own, and a page whose main thread is wedged never
 * answers either of them, so without a clock here one stuck site stops the run
 * dead. A partial perception is a real finding; silence is not.
 */
async function attempt<T>(fn: () => Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  try {
    return await withTimeout(fn(), timeoutMs, "the page");
  } catch {
    return fallback;
  }
}

export async function perceive(page: AgentPage, timeoutMs = PERCEIVE_MS): Promise<Perception> {
  const [snapshot, rawText, title, modalOpen] = await Promise.all([
    attempt(() => page.ariaSnapshot({ mode: "ai" }), "", timeoutMs),
    attempt(
      () => page.evaluate<string>(() => (document.body ? document.body.innerText : "")),
      "",
      timeoutMs,
    ),
    attempt(() => page.title(), "", timeoutMs),
    // False on failure: a probe that did not answer is not evidence of a modal,
    // and restricting the page on a guess is what this probe exists to prevent.
    attempt(() => page.evaluate<boolean>(modalIsOpen), false, timeoutMs),
  ]);

  const elements = parseAriaSnapshot(snapshot, modalOpen);
  const text = rawText.replace(/\s*\n\s*\n\s*/g, "\n").trim().slice(0, MAX_TEXT);

  return {
    url: page.url(),
    title,
    elements,
    text,
    // A real page with content has both actionable elements and prose. Missing
    // both is the signature of a JS-gated or blocked page.
    jsGated: elements.length === 0 && text.length < 200,
    // Tested against the whole page, not the trimmed copy above. MAX_TEXT is a
    // token budget for the model, and a price that happens to sit below it is
    // still selectable text on the page. Measured on plausible.io: the pricing
    // slider reads in euros and the run was charged no-structured-price anyway,
    // because our own truncation cut the page off above it. Charging a site for
    // what our trimming hid is the one kind of wrong finding this cannot afford.
    hasPrice: looksPriced(rawText),
  };
}

/**
 * What the agent was looking at, reduced to something comparable.
 *
 * Read by two things for the same reason. The grader calls four identical
 * perceptions in a row a stuck loop, and the run itself compares one step to the
 * next to tell whether the click it just made did anything at all.
 *
 * The URL alone is not it. A booking flow inside one modal advances through four
 * screens without the address ever changing, and judging that by URL calls a
 * working flow a stuck loop: seen live on a real spa site, where the element
 * count went 37 to 51 while the URL stood still. So a loop is the page not
 * changing, and this is what "not changing" means.
 *
 * What the fields hold counts as part of it. Filling in a form is progress even
 * though it moves nothing else on the page, and a run that types a name, a phone
 * number and a note would otherwise look identical at every step and earn a loop
 * blocker for working correctly. Retyping the same value into the same field
 * still leaves this string unchanged, which is the case the blocker is for.
 *
 * So does whether a control can be operated. A submit going live is the single
 * most important way a page can change, and nothing else about it moves: same
 * roles, same names, same values, same count. The prompt now tells the agent to
 * look once more at a form whose submit is disabled by a challenge that clears
 * itself, and without this that patience reads back as going in circles.
 *
 * What is deliberately absent is `ref`, which is minted fresh for every snapshot.
 * Including it would make an untouched page look different every time it was
 * looked at, which is the one thing this must never say.
 */
export function fingerprint(p: Perception): string {
  return [p.url, p.title, p.elements.length, marks(p).join("|")].join("~");
}

/**
 * One page as the set of things on it that can be told apart.
 *
 * The same strings `fingerprint` joins, handed back as a list so two pages can be
 * compared by how much they share rather than only by whether they match.
 */
export function marks(p: Perception): string[] {
  return p.elements.map((e) => `${e.role}:${e.name}:${e.value ?? ""}:${e.disabled ? "off" : "on"}`);
}

/**
 * Is this the same page as that one, allowing for the parts of it that move by
 * themselves?
 *
 * Because plenty of pages are never twice the same. docs.stripe.com carries a code
 * sample that rotates on a timer, and across four snapshots of an untouched home
 * page its two elements read "jenny.rosen@example.com", then "$ stripe balance
 * retrieve", then "false", then "https://example.com/success". Two elements of
 * sixty, changing with nobody touching anything, and `fingerprint` returns a
 * different string for each. Everything downstream that asks "did that do
 * anything" then answers yes: a click that navigated nowhere was never reported
 * as inert, so the run clicked the same link again two steps later, and the lap
 * warning never fired because no page was ever visited twice.
 *
 * Measured on that run, the overlap is a clean split with nothing near the middle.
 * The untouched home page against itself: 0.93. The same page after typing into
 * its search box: 0.87. A menu opening on stripe.com: 0.63 and 0.28. An actual
 * navigation: 0.01 and 0.00. So the default sits in the gap rather than on a
 * measurement, and both neighbours are far from it.
 *
 * Only the agent's own memory uses this. The loop blocker still wants two pages to
 * be identical, because a four-step wizard whose pages share their navigation
 * would resemble itself the whole way through, and charging that with going in
 * circles is a false finding on a site that works. Being told "you already tried
 * this" one step too eagerly costs a step; a false blocker costs the truth.
 */
export function resembles(a: Perception, b: Perception, threshold = 0.85): boolean {
  if (a.url !== b.url) return false;
  const A = Array.from(new Set(marks(a)));
  const B = new Set(marks(b));
  if (!A.length && !B.size) return a.title === b.title;
  let shared = 0;
  for (const m of A) if (B.has(m)) shared++;
  return shared / (A.length + B.size - shared) >= threshold;
}

/** Render the perception as the compact numbered state the model sees. */
export function renderState(p: Perception, stepsLeft: number, textBudget = MAX_TEXT): string {
  const els = p.elements.length
    ? p.elements.map(describe).join("\n")
    : "(none: the accessibility tree is empty)";

  const prose = p.text.slice(0, Math.max(0, textBudget));

  return [
    `URL: ${p.url}`,
    `TITLE: ${p.title || "(none)"}`,
    `STEPS REMAINING: ${stepsLeft}`,
    "",
    "INTERACTIVE ELEMENTS:",
    els,
    "",
    "VISIBLE TEXT:",
    prose || "(none)",
  ].join("\n");
}

/**
 * One line of the numbered list. Choices are spelled out so a select can name
 * one, and contents are spelled out so the model can see what it has already
 * filled in rather than filling it again.
 *
 * The disabled mark goes directly after the name, where it cannot be mistaken
 * for part of the value or the target. It is listed at all so the model can say
 * why it is stuck instead of reporting the control missing.
 */
function describe(e: PerceivedElement): string {
  const dead = e.disabled ? "  (disabled)" : "";
  const target = e.href ? `  -> ${e.href}` : "";
  const holds = e.value ? `  = "${e.value}"` : "";
  const choices = e.options?.length ? `  choices: ${e.options.join(", ")}` : "";
  return `${e.index}. [${e.role}] ${e.name}${dead}${holds}${target}${choices}`;
}
