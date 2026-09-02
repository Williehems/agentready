import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newRunId, normaliseTarget } from "../lib/url";

function reject(input: string): string {
  const r = normaliseTarget(input);
  assert.equal(r.ok, false, `expected ${input} to be rejected, got ${r.url}`);
  assert.ok(r.reason, "a rejection must carry a reason the user can act on");
  return r.reason!;
}

function accept(input: string): string {
  const r = normaliseTarget(input);
  assert.equal(r.ok, true, `expected ${input} to be accepted, got ${r.reason}`);
  return r.url!;
}

describe("normaliseTarget: shape", () => {
  it("refuses empty input", () => {
    assert.match(reject(""), /Enter a URL/);
    assert.match(reject("   "), /Enter a URL/);
  });

  it("assumes https for a bare hostname", () => {
    assert.equal(accept("stripe.com"), "https://stripe.com/");
    assert.equal(accept("  stripe.com  "), "https://stripe.com/");
  });

  it("keeps an explicit http scheme rather than silently upgrading it", () => {
    assert.equal(accept("http://stripe.com"), "http://stripe.com/");
  });

  it("lowercases the host and keeps path and query, dropping only the fragment", () => {
    assert.equal(accept("HTTPS://Stripe.COM/Pricing?plan=pro#faq"), "https://stripe.com/Pricing?plan=pro");
  });

  it("does not mistake a port for a scheme", () => {
    assert.equal(accept("example.com:8080/health"), "https://example.com:8080/health");
  });

  it("refuses input with spaces instead of quietly encoding it", () => {
    assert.match(reject("stripe.com/a b"), /spaces/);
  });
});

describe("normaliseTarget: scheme allowlist", () => {
  for (const input of [
    "mailto:sales@example.com",
    "javascript:alert(1)",
    "data:text/html,<h1>hi</h1>",
    "file:///etc/passwd",
    "ftp://files.example.com",
    "ws://example.com/socket",
    "tel:+2348012345678",
    "chrome://settings",
  ]) {
    it(`refuses ${input}`, () => {
      assert.match(reject(input), /Only http and https/);
    });
  }

  it("names the offending scheme so the message is useful", () => {
    assert.match(reject("ftp://files.example.com"), /not ftp/);
  });
});

describe("normaliseTarget: private targets", () => {
  it("refuses credentials smuggled into the authority", () => {
    assert.match(reject("https://admin:hunter2@example.com"), /credentials/);
  });

  it("refuses a hostname with no dot, which cannot be public", () => {
    assert.match(reject("https://intranet-box"), /does not look public/);
  });

  for (const host of [
    "localhost",
    "app.localhost",
    "printer.local",
    "api.internal",
    "wiki.intranet",
    "nas.lan",
    "files.corp",
    "device.home.arpa",
  ]) {
    it(`refuses ${host} by name`, () => {
      assert.match(reject(`https://${host}`), /Private and loopback/);
    });
  }

  for (const host of [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254", // the cloud metadata endpoint, the reason this check exists
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "192.0.2.5",
    "198.18.0.1",
  ]) {
    it(`refuses ${host} by address`, () => {
      assert.match(reject(`http://${host}`), /Private and loopback/);
    });
  }

  // Every one of these is 127.0.0.1 after the URL parser is done with it. The
  // check runs on the parsed hostname precisely so this family closes at once.
  for (const host of ["2130706433", "0x7f000001", "127.1", "0177.0.0.1", "127.0.1"]) {
    it(`refuses ${host}, which canonicalises to loopback`, () => {
      assert.match(reject(`http://${host}`), /Private and loopback/);
    });
  }

  for (const host of [
    "[::1]",
    "[::]",
    "[fe80::1]",
    "[fc00::1]",
    "[fd12:3456::1]",
    "[::ffff:127.0.0.1]", // the parser rewrites this to [::ffff:7f00:1]
    "[::ffff:192.168.1.1]",
    "[0:0:0:0:0:ffff:c0a8:101]",
  ]) {
    it(`refuses ${host}`, () => {
      assert.match(reject(`http://${host}`), /Private and loopback/);
    });
  }

  it("does not overreach past the edges of the blocked ranges", () => {
    assert.equal(accept("http://172.15.0.1"), "http://172.15.0.1/");
    assert.equal(accept("http://172.32.0.1"), "http://172.32.0.1/");
    assert.equal(accept("http://100.63.255.255"), "http://100.63.255.255/");
    assert.equal(accept("http://100.128.0.1"), "http://100.128.0.1/");
    assert.equal(accept("http://8.8.8.8"), "http://8.8.8.8/");
    assert.equal(accept("http://11.0.0.1"), "http://11.0.0.1/");
  });

  it("does not treat a public name that merely contains a private word as private", () => {
    assert.equal(accept("localhost.example.com"), "https://localhost.example.com/");
    assert.equal(accept("internal-tools.example.com"), "https://internal-tools.example.com/");
  });
});

describe("newRunId", () => {
  it("is filesystem safe and unique across calls", () => {
    const ids = Array.from({ length: 200 }, () => newRunId());
    assert.equal(new Set(ids).size, 200);
    for (const id of ids) assert.match(id, /^[a-z0-9]+-[a-z0-9]+$/);
  });
});
