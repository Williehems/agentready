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
 * Covering means it takes pointer events and either declares itself modal or
 * fills most of the viewport: a visible chat widget with `role="dialog"` traps
 * nothing and must not shrink the page to itself.
 *
 * Runs in the page, so it closes over nothing.
 */
function modalIsOpen(): boolean {
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

    if (el.getAttribute("aria-modal") === "true") return true;
    const viewport = window.innerWidth * window.innerHeight;
    if (viewport > 0 && (box.width * box.height) / viewport >= 0.55) return true;
  }

  return false;
}

const MAX_ELEMENTS = 60;
const MAX_TEXT = 2800;
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
}

function flag(flags: string, name: string): string | undefined {
  const m = new RegExp(`\\[${name}(?:=([^\\]]*))?\\]`).exec(flags);
  return m ? (m[1] ?? "") : undefined;
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
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].indent < indent) {
          nodes[i].href = (trailing ?? "").trim();
          break;
        }
      }
      continue;
    }

    const named = (quoted ?? "").replace(/\\(.)/g, "$1").trim();
    const name = (named || (trailing ?? "").trim()).slice(0, 120);

    // An option belonging to a dropdown is folded into it. Left on its own it is
    // an element the model will press and cannot, and seventeen time slots eat a
    // third of the element budget describing one control.
    if (role === "option") {
      const owner = enclosingSelect(nodes, indent);
      if (owner) {
        (owner.options ??= []).push(name);
        continue;
      }
    }

    nodes.push({
      indent,
      role,
      name,
      ref: flag(flags, "ref"),
      disabled: flag(flags, "disabled") !== undefined,
    });
  }

  const out: PerceivedElement[] = [];
  const seen = new Set<string>();
  const visible = modalOpen ? reachable(nodes) : nodes;

  for (let i = 0; i < visible.length && out.length < MAX_ELEMENTS; i++) {
    const n = visible[i];
    if (!INTERACTIVE.has(n.role) || n.disabled) continue;

    const name = n.name || inferName(visible, i);
    if (COLLAPSIBLE.has(n.role)) {
      const key = `${n.role}::${name.toLowerCase()}::${n.href ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }

    const el: PerceivedElement = { index: out.length + 1, role: n.role, name };
    if (n.ref) el.ref = n.ref;
    if (n.href) el.href = n.href;
    if (n.options?.length) el.options = n.options.slice(0, MAX_OPTIONS);
    out.push(el);
  }

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
    hasPrice: PRICE_RE.test(text),
  };
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

/** One line of the numbered list. Choices are spelled out so a select can name one. */
function describe(e: PerceivedElement): string {
  const target = e.href ? `  -> ${e.href}` : "";
  const choices = e.options?.length ? `  choices: ${e.options.join(", ")}` : "";
  return `${e.index}. [${e.role}] ${e.name}${target}${choices}`;
}
