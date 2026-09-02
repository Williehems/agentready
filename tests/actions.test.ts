import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handoffLabel, isDeadEndHref } from "../lib/actions";

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
