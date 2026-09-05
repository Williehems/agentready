import type { ActionKind } from "./types";

/**
 * What each action is called, apart from what each action is.
 *
 * Its own module because of where it is read. The dock and the console are client
 * components, and an import of `lib/actions` from either one sends that whole file
 * to the browser: five goals, five done-tests, five definitions of key info and
 * every CTA and URL hint in the taxonomy, 2,867 bytes of prose written for a model,
 * shipped so that a menu can render 69 bytes of labels. None of it is secret and
 * none of it is large, but it is weight in the first load of the one page a visitor
 * waits on.
 *
 * The names are written once, here, and `lib/actions` reads them into each spec,
 * so there is still a single place to change what an action is called.
 */
export const ACTION_LABELS: Record<ActionKind, string> = {
  signup: "Sign up",
  purchase: "Buy something",
  integrate: "Integrate the API",
  book: "Book an appointment",
  contact: "Reach a human",
};

/**
 * Menu order, which is taxonomy order: the two lists are the same five ids and
 * this is the one the dock renders, so it is declared rather than derived from an
 * object whose key order is only conventionally stable.
 */
export const ACTION_ORDER: ActionKind[] = [
  "signup",
  "purchase",
  "integrate",
  "book",
  "contact",
];
