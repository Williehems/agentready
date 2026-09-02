import type { ActionKind } from "./types";

/**
 * The action taxonomy. Every site exists for one primary action; pick it and the
 * agent has an unambiguous goal, which is what keeps the loop from wandering.
 */
export interface ActionSpec {
  id: ActionKind;
  label: string;
  /** Handed to the model verbatim as the task. */
  goal: string;
  /** What "key info" means for this action, used for the found-key-info milestone. */
  keyInfo: string;
  /** Lowercased substrings that suggest the primary CTA for this action. */
  ctaHints: string[];
  /** Reaching a URL containing one of these counts as arriving at the action surface. */
  urlHints: string[];
}

export const ACTIONS: Record<ActionKind, ActionSpec> = {
  signup: {
    id: "signup",
    label: "Sign up",
    goal:
      "Create a new account on this site. Get as far as the account creation form and fill in what you can, but never submit real payment details.",
    keyInfo: "what the product does and what a plan costs or whether there is a free tier",
    ctaHints: ["sign up", "signup", "get started", "start free", "create account", "try free", "register", "join"],
    urlHints: ["signup", "sign-up", "register", "join", "create-account", "get-started"],
  },
  purchase: {
    id: "purchase",
    label: "Buy something",
    goal:
      "Buy the cheapest available product or plan. Get as far as the checkout or payment step, then stop. Never enter real payment details.",
    keyInfo: "the price of at least one product, as selectable text rather than an image",
    ctaHints: ["buy", "add to cart", "add to bag", "checkout", "order", "purchase", "shop", "subscribe", "choose plan", "select plan"],
    urlHints: ["cart", "checkout", "basket", "order", "pricing", "product", "shop"],
  },
  integrate: {
    id: "integrate",
    label: "Integrate the API",
    goal:
      "You are a developer evaluating this product. Find the API documentation, a code example you could copy, and how to obtain an API key.",
    keyInfo: "a copyable code example and a stated route to an API key",
    ctaHints: ["docs", "documentation", "api", "developers", "developer", "quickstart", "reference", "get api key"],
    urlHints: ["docs", "developer", "api", "reference", "quickstart"],
  },
  book: {
    id: "book",
    label: "Book an appointment",
    goal:
      "Book an appointment, demo, or reservation. Get as far as choosing a date or time slot and entering details, then stop before final confirmation.",
    keyInfo: "available times or dates, and what the appointment is for",
    ctaHints: ["book", "reserve", "schedule", "appointment", "demo", "consultation", "request a demo", "talk to sales"],
    urlHints: ["book", "booking", "reserve", "schedule", "appointment", "demo", "calendar"],
  },
  contact: {
    id: "contact",
    label: "Reach a human",
    goal:
      "Reach a human at this organisation. Find a working contact route and get as far as composing a message, then stop before sending.",
    keyInfo: "a named contact route that works without leaving the browser",
    ctaHints: ["contact", "contact us", "get in touch", "support", "help", "talk to us", "message us", "enquire", "inquire"],
    urlHints: ["contact", "support", "help", "enquiry", "inquiry", "get-in-touch"],
  },
};

export const ACTION_LIST: ActionSpec[] = Object.values(ACTIONS);

/**
 * Link schemes that hand the visitor off to something a browser agent cannot
 * complete. A site whose only route to conversion is one of these is a
 * dead end for every machine visitor, which is the dead-end-cta blocker.
 */
export const DEAD_END_SCHEMES = ["wa.me", "whatsapp://", "api.whatsapp.com", "tel:", "mailto:", "sms:", "fb-messenger://", "viber://", "t.me"];

export function isDeadEndHref(href: string | undefined): boolean {
  if (!href) return false;
  const h = href.toLowerCase();
  return DEAD_END_SCHEMES.some((s) => h.startsWith(s) || h.includes(`//${s}`) || h.includes(s));
}
