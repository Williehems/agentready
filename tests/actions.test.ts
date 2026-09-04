import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTION_LIST, ACTIONS, handoffLabel, isDeadEndHref } from "../lib/actions";

describe("isDeadEndHref", () => {
  it("catches the chat links a browser agent cannot follow", () => {
    for (const href of [
      "https://wa.me/2348099224450",
      "https://api.whatsapp.com/send/?phone=2348099224450&text=Hi",
      "https://web.whatsapp.com/send?phone=234",
      "whatsapp://send?phone=234",
      "https://t.me/someone",
      "https://m.me/somepage",
      "tel:+2348099224450",
      "mailto:hello@example.com",
      "sms:+2348099224450",
    ]) {
      assert.ok(isDeadEndHref(href), href);
    }
  });

  it("leaves this site's own routes alone", () => {
    for (const href of ["/contact", "/book", "forgot", "?step=2", "#booking", "/wa.me-guide"]) {
      assert.ok(!isDeadEndHref(href), href);
    }
  });

  /**
   * The reason this compares hosts rather than substrings. "t.me" sits inside
   * "client.metrics.com" and inside "support.medium.com", and a site whose new tab
   * opened either one would have been charged with a Telegram handoff: a hard
   * blocker, a cap at 45, and a finding its owner could not act on because it
   * never happened.
   */
  it("does not find a chat host inside an ordinary domain", () => {
    for (const href of [
      "https://client.metrics.com/dashboard",
      "https://support.medium.com/help",
      "https://docs.stripe.com/api",
      "https://calendly.com/acme/intro",
      "https://whatsapp-clone-tutorial.dev/",
    ]) {
      assert.ok(!isDeadEndHref(href), href);
    }
  });

  it("reads a protocol-relative or bare host the way a browser would", () => {
    assert.ok(isDeadEndHref("//wa.me/234"));
    assert.ok(isDeadEndHref("wa.me/234"));
    assert.ok(!isDeadEndHref("//example.com/pricing"));
  });

  it("catches a subdomain of a chat host, and nothing that merely ends in one", () => {
    assert.ok(isDeadEndHref("https://chat.whatsapp.com/ABC123"));
    assert.ok(!isDeadEndHref("https://notwhatsapp.com/"));
  });

  it("says no to nothing at all", () => {
    assert.ok(!isDeadEndHref(undefined));
    assert.ok(!isDeadEndHref(""));
  });
});

describe("handoffLabel", () => {
  it("names the app, not the URL, since the name is what the owner built", () => {
    assert.equal(handoffLabel("https://api.whatsapp.com/send/?phone=234"), "WhatsApp");
    assert.equal(handoffLabel("https://wa.me/234"), "WhatsApp");
    assert.equal(handoffLabel("https://t.me/someone"), "Telegram");
    assert.equal(handoffLabel("https://m.me/somepage"), "Facebook Messenger");
    assert.equal(handoffLabel("tel:+234809"), "a phone dialler");
    assert.equal(handoffLabel("mailto:hi@example.com"), "an email client");
    assert.equal(handoffLabel("sms:+234809"), "a text-message app");
  });

  it("falls back to the host for anything it has no name for", () => {
    assert.equal(handoffLabel("https://booking.acme.co.uk/slots"), "booking.acme.co.uk");
  });

  it("says something rather than nothing when the URL is unreadable", () => {
    assert.equal(handoffLabel("javascript:void(0)"), "another app");
  });
});

/**
 * The completion tests, which are prompt text and therefore behaviour.
 *
 * Asserted on content rather than presence, because presence is already the
 * compiler's job: ActionSpec.done is required and ACTIONS is keyed by every
 * ActionKind, so an action cannot ship without one. What can still go wrong is a
 * completion test that lets a run call a wall a success, which is worth 40 points
 * and would take a site that stopped the agent dead to an A.
 */
describe("what each action tells the model finishing looks like", () => {
  it("gives every action a test in its own words", () => {
    for (const spec of ACTION_LIST) {
      assert.ok(spec.done.length > 40, `${spec.id} has no real completion test`);
      assert.notEqual(spec.done, spec.goal, `${spec.id} restates the goal`);
    }
  });

  /**
   * The hole this closes. The old wording was "the furthest point a visitor can
   * reach without paying and without a pre-existing account credential", which is
   * exactly where an emailed code leaves you. A signup run that stopped at
   * "Check your email" and answered done would have earned completed-action, and
   * with the other three milestones that is 100 and an A for a site no agent can
   * register on. Measured on plausible.io five times over: the wall is always
   * there, and the only reason no run scored A is that the model happened to
   * answer give_up instead.
   */
  it("refuses to let signup count an inbox wall as an account", () => {
    const done = ACTIONS.signup.done.toLowerCase();
    assert.match(done, /inbox|code/);
    assert.match(done, /give_up/);
    assert.match(done, /wall/);
  });

  /**
   * The defect that prompted all of this, from the other side. Both of these say
   * the key is something to read about, not something to leave holding, because
   * obtaining one is what the signup action measures and measuring it here as well
   * charges one wall twice and leaves the documentation unmeasured.
   */
  it("tells integrate that the key is a fact to find, not a thing to hold", () => {
    const done = ACTIONS.integrate.done.toLowerCase();
    assert.match(done, /code example/);
    assert.match(done, /not things to hold|do not need an account/);
  });

  it("keeps purchase and contact stopping where the task says to stop", () => {
    assert.match(ACTIONS.purchase.done.toLowerCase(), /card fields/);
    assert.match(ACTIONS.purchase.done.toLowerCase(), /rather than filling them|stop there/);
    assert.match(ACTIONS.contact.done.toLowerCase(), /without sending/);
  });

  it("keeps book's test on the far side of the submit, where the finding is", () => {
    assert.match(ACTIONS.book.done.toLowerCase(), /submitted/);
    // A site that takes the booking and says nothing is the case this exists for:
    // silence is an answer, and a run that waits for a confirmation that never
    // comes spends its remaining steps on it. Measured live, that cost two steps
    // and sixty seconds clicking at a button that had already moved.
    assert.match(ACTIONS.book.done.toLowerCase(), /silent|nothing at all/);
  });
});
