import type { Perception, PerceivedElement } from "./types";

/**
 * Perception: turn a live page into the small text state an LLM can reason over.
 *
 * We read the accessibility tree rather than raw HTML. It is an order of
 * magnitude smaller, it contains exactly the things a visitor can act on, and
 * when it comes back empty that emptiness is itself the finding: the site is
 * a blank wall to anything that is not a full rendering browser with JS.
 */

/** Only the page surface this module needs, so we do not couple to a Playwright version. */
export interface AgentPage {
  url(): string;
  title(): Promise<string>;
  accessibility: { snapshot(options?: { interestingOnly?: boolean }): Promise<AxNode | null> };
  evaluate<R>(fn: string | (() => R)): Promise<R>;
  $$eval<R>(selector: string, fn: (els: Element[]) => R): Promise<R>;
}

export interface AxNode {
  role?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  children?: AxNode[];
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

const MAX_ELEMENTS = 60;
const MAX_TEXT = 2800;

/** Currency as selectable text. Deliberately conservative to avoid false positives. */
const PRICE_RE =
  /(?:[$€£¥₦]|\bNGN\b|\bUSD\b|\bEUR\b|\bGBP\b|\bRs\.?)\s?\d[\d,.]*|\d[\d,.]*\s?(?:USD|EUR|GBP|NGN)\b/i;

function walk(node: AxNode | null, out: AxNode[], depth = 0): void {
  if (!node || depth > 40) return;
  const role = (node.role ?? "").toLowerCase();
  const name = (node.name ?? "").trim();
  if (INTERACTIVE.has(role) && name && !node.disabled) {
    out.push({ role, name, value: node.value });
  }
  for (const child of node.children ?? []) walk(child, out, depth + 1);
}

function dedupe(nodes: AxNode[]): AxNode[] {
  const seen = new Set<string>();
  const kept: AxNode[] = [];
  for (const n of nodes) {
    const key = `${n.role}::${(n.name ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(n);
  }
  return kept;
}

export async function perceive(page: AgentPage): Promise<Perception> {
  const [snapshot, rawText, links, title] = await Promise.all([
    page.accessibility.snapshot({ interestingOnly: true }).catch(() => null),
    page
      .evaluate<string>(() => (document.body ? document.body.innerText : ""))
      .catch(() => ""),
    page
      .$$eval<{ name: string; href: string }[]>("a[href]", (els) =>
        els.slice(0, 400).map((el) => ({
          name: (el.textContent ?? "").trim().slice(0, 120),
          href: (el as HTMLAnchorElement).getAttribute("href") ?? "",
        })),
      )
      .catch(() => [] as { name: string; href: string }[]),
    page.title().catch(() => ""),
  ]);

  const collected: AxNode[] = [];
  walk(snapshot, collected);
  const unique = dedupe(collected).slice(0, MAX_ELEMENTS);

  // Attach hrefs to links by name so the grader can spot dead-end CTAs.
  const hrefByName = new Map<string, string>();
  for (const l of links) {
    const k = l.name.toLowerCase();
    if (k && !hrefByName.has(k)) hrefByName.set(k, l.href);
  }

  const elements: PerceivedElement[] = unique.map((n, i) => {
    const name = (n.name ?? "").slice(0, 120);
    const el: PerceivedElement = { index: i + 1, role: n.role ?? "generic", name };
    if (el.role === "link") {
      const href = hrefByName.get(name.toLowerCase());
      if (href) el.href = href;
    }
    return el;
  });

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
