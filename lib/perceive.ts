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

const MAX_ELEMENTS = 60;
const MAX_TEXT = 2800;
/** Snapshots run a few KB. Past this the page is beyond what one prompt can hold. */
const MAX_SNAPSHOT = 500_000;
/** How far back to look for a label when a control has no accessible name. */
const LABEL_LOOKBACK = 4;

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
}

function flag(flags: string, name: string): string | undefined {
  const m = new RegExp(`\\[${name}(?:=([^\\]]*))?\\]`).exec(flags);
  return m ? (m[1] ?? "") : undefined;
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

/** Turn one aria snapshot into the numbered list the model addresses by index. */
export function parseAriaSnapshot(snapshot: string): PerceivedElement[] {
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
    nodes.push({
      indent,
      role,
      name: (named || (trailing ?? "").trim()).slice(0, 120),
      ref: flag(flags, "ref"),
      disabled: flag(flags, "disabled") !== undefined,
    });
  }

  const out: PerceivedElement[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < nodes.length && out.length < MAX_ELEMENTS; i++) {
    const n = nodes[i];
    if (!INTERACTIVE.has(n.role) || n.disabled) continue;

    const name = n.name || inferName(nodes, i);
    if (COLLAPSIBLE.has(n.role)) {
      const key = `${n.role}::${name.toLowerCase()}::${n.href ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }

    const el: PerceivedElement = { index: out.length + 1, role: n.role, name };
    if (n.ref) el.ref = n.ref;
    if (n.href) el.href = n.href;
    out.push(el);
  }

  return out;
}

/**
 * Never reach for a page method without a try around the call itself. An SDK
 * that has dropped the method throws synchronously, before any `.catch()` on
 * the returned promise can attach, and takes the whole run with it.
 */
async function attempt<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function perceive(page: AgentPage): Promise<Perception> {
  const [snapshot, rawText, title] = await Promise.all([
    attempt(() => page.ariaSnapshot({ mode: "ai" }), ""),
    attempt(() => page.evaluate<string>(() => (document.body ? document.body.innerText : "")), ""),
    attempt(() => page.title(), ""),
  ]);

  const elements = parseAriaSnapshot(snapshot);
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
export function renderState(p: Perception, stepsLeft: number): string {
  const els = p.elements.length
    ? p.elements
        .map((e) => `${e.index}. [${e.role}] ${e.name}${e.href ? `  -> ${e.href}` : ""}`)
        .join("\n")
    : "(none: the accessibility tree is empty)";

  return [
    `URL: ${p.url}`,
    `TITLE: ${p.title || "(none)"}`,
    `STEPS REMAINING: ${stepsLeft}`,
    "",
    "INTERACTIVE ELEMENTS:",
    els,
    "",
    "VISIBLE TEXT:",
    p.text || "(none)",
  ].join("\n");
}
