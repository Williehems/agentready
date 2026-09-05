import { ACTION_LABELS } from "./action-labels";
import type { ActionKind } from "./types";

/**
 * The action taxonomy. Every site exists for one primary action; pick it and the
 * agent has an unambiguous goal, which is what keeps the loop from wandering.
 */
export interface ActionSpec {
  id: ActionKind;
  /** From ./action-labels, which is the copy the browser is allowed to have. */
  label: string;
  /** Handed to the model verbatim as the task. */
  goal: string;
  /**
   * The test the model applies to know it has finished, handed to it verbatim.
   *
   * Here because two live runs proved the goal alone is not enough. On
   * docs.stripe.com an `integrate` run reached /keys#obtain-api-keys and a
   * quickstart full of copyable curl, which is the whole of what the goal asks
   * for, and then spent its remaining steps clicking, never said "done", and was
   * graded C 60 for a site that had answered it completely. A second run reached
   * /get-started/development-environment and /agents#tools and did the same.
   *
   * The reason is in the prompt's shape: every rule around it is about fields,
   * submits and disabled buttons, so a model reading it looks for a button that
   * ends the task. On a task whose object is to find something there is no such
   * button, and nothing told it that finding was finishing.
   *
   * Each of these names the state that counts, and each names the wall that does
   * not, because "as far as a visitor can get" was the old wording and it invited
   * a run stopped dead by an emailed code to call itself a success.
   */
  done: string;
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
    label: ACTION_LABELS.signup,
    goal:
      "Create a new account on this site. Get as far as the account creation form and fill in what you can, but never submit real payment details.",
    done:
      "the site confirms an account now exists: a dashboard, a welcome page, or a message that the account was created. A page asking for a code from an inbox or a phone is not that. It is a wall, and the honest answer to a wall is give_up naming it.",
    keyInfo: "what the product does and what a plan costs or whether there is a free tier",
    ctaHints: ["sign up", "signup", "get started", "start free", "create account", "try free", "register", "join"],
    urlHints: ["signup", "sign-up", "register", "join", "create-account", "get-started"],
  },
  purchase: {
    id: "purchase",
    label: ACTION_LABELS.purchase,
    goal:
      "Buy the cheapest available product or plan. Get as far as the checkout or payment step, then stop. Never enter real payment details.",
    done:
      "the checkout or payment step is on screen with its card fields visible. That is the end of this task by design, so stop there rather than filling them.",
    keyInfo: "the price of at least one product, as selectable text rather than an image",
    ctaHints: ["buy", "add to cart", "add to bag", "checkout", "order", "purchase", "shop", "subscribe", "choose plan", "select plan"],
    urlHints: ["cart", "checkout", "basket", "order", "pricing", "product", "shop"],
  },
  integrate: {
    id: "integrate",
    label: ACTION_LABELS.integrate,
    goal:
      "You are a developer evaluating this product. Find the API documentation, a code example you could copy, and how to obtain an API key.",
    done:
      "you have seen a code example you could copy and a page that states where an API key comes from. Both are facts to find, not things to hold: you do not need an account and you do not need a key of your own. Once you have read both, you are finished.",
    keyInfo: "a copyable code example and a stated route to an API key",
    ctaHints: ["docs", "documentation", "api", "developers", "developer", "quickstart", "reference", "get api key"],
    urlHints: ["docs", "developer", "api", "reference", "quickstart"],
  },
  book: {
    id: "book",
    label: ACTION_LABELS.book,
    /**
     * Pressing submit is the measurement, not a step past it.
     *
     * This used to end at "stop before final confirmation", and two live runs
     * showed what that costs: with the form filled and the send button on screen,
     * the model had been told to stop there, so one gave up and the other pressed
     * it only by accident. Everything worth finding is at that button. On the site
     * this was measured against, pressing it opens WhatsApp in another tab and the
     * booking is never made, which is the finding, and it is invisible to a run
     * that stops one click short of it.
     */
    goal:
      "Book an appointment, demo, or reservation. Pick whatever slot or time the site offers, fill in the visitor details it asks for, then press the control that submits the booking request. Never enter payment card details.",
    done:
      "the booking has been submitted and the site has said what became of it, whether that is a confirmation, a reference, or an error. Submitting and being told nothing at all is also an answer: report done and say the site went silent.",
    keyInfo: "available times or dates, and what the appointment is for",
    ctaHints: ["book", "reserve", "schedule", "appointment", "demo", "consultation", "request a demo", "talk to sales"],
    urlHints: ["book", "booking", "reserve", "schedule", "appointment", "demo", "calendar"],
  },
  contact: {
    id: "contact",
    label: ACTION_LABELS.contact,
    goal:
      "Reach a human at this organisation. Find a working contact route and get as far as composing a message, then stop before sending.",
    done:
      "a contact form is on screen with your message typed into it, ready to send. Stop there without sending it.",
    keyInfo: "a named contact route that works without leaving the browser",
    ctaHints: ["contact", "contact us", "get in touch", "support", "help", "talk to us", "message us", "enquire", "inquire"],
    urlHints: ["contact", "support", "help", "enquiry", "inquiry", "get-in-touch"],
  },
};

export const ACTION_LIST: ActionSpec[] = Object.values(ACTIONS);

/**
 * Protocols that leave the browser for another application entirely. Nothing an
 * agent can do with one of these, and nothing a machine visitor can complete
 * beyond it.
 */
export const DEAD_END_PROTOCOLS = [
  "tel:", "mailto:", "sms:", "whatsapp:", "fb-messenger:", "viber:", "tg:",
];

/**
 * Hosts whose whole purpose is to hand the visitor to a chat app. Reaching one
 * requires an account and a session in that app, which no fresh browser has.
 */
export const DEAD_END_HOSTS = [
  "wa.me", "whatsapp.com", "t.me", "telegram.me", "m.me", "messenger.com",
];

/**
 * The host an href points at, or undefined when it points at this site.
 *
 * Written out rather than done with `includes`, because substrings lie: "t.me"
 * appears inside "client.metrics.com" and "support.medium.com", and matching that
 * way charges an ordinary link with being a Telegram handoff. A dead end is a
 * property of the host, so the host is what gets compared.
 */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    // Not absolute: either protocol-relative (//wa.me/234), bare (wa.me/234), or
    // a path on this site, which is not a handoff at all.
  }
  return /^(?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/.exec(url)?.[1];
}

export function isDeadEndHref(href: string | undefined): boolean {
  if (!href) return false;
  const h = href.trim().toLowerCase();
  if (DEAD_END_PROTOCOLS.some((p) => h.startsWith(p))) return true;
  const host = hostOf(h);
  return host !== undefined && DEAD_END_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * What to call a handoff destination in a finding a site owner will read.
 *
 * "api.whatsapp.com" is what the URL says; "WhatsApp" is what they built. A
 * finding they cannot recognise as their own button is a finding they will not
 * act on.
 */
export function handoffLabel(url: string): string {
  const u = url.trim().toLowerCase();
  if (u.startsWith("tel:")) return "a phone dialler";
  if (u.startsWith("sms:")) return "a text-message app";
  if (u.startsWith("mailto:")) return "an email client";
  const host = hostOf(u) ?? "";
  if (u.startsWith("whatsapp:") || host === "wa.me" || host.endsWith("whatsapp.com")) {
    return "WhatsApp";
  }
  if (u.startsWith("tg:") || host === "t.me" || host.endsWith("telegram.me")) return "Telegram";
  if (u.startsWith("fb-messenger:") || host === "m.me" || host.endsWith("messenger.com")) {
    return "Facebook Messenger";
  }
  if (u.startsWith("viber:")) return "Viber";
  return host || "another app";
}
