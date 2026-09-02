/**
 * URL hygiene. This endpoint takes a URL from anyone and points a cloud browser
 * at it, so the input is treated as hostile.
 *
 * What this stops: non-http schemes, credentials smuggled into the authority,
 * and literal private, loopback, link-local and metadata addresses. The check
 * runs against the parsed hostname rather than the raw string, because the
 * WHATWG parser folds the decimal, hex, octal and short forms of an IPv4
 * address into a dotted quad first (http://2130706433 becomes 127.0.0.1), which
 * closes the whole family of encodings in one place.
 *
 * What it cannot stop: a public hostname whose DNS record points into a private
 * range, or a rebind between this check and the browser's own lookup. The
 * browser runs in Solari's cloud rather than on this host, so "localhost" there
 * is their container and not our server, which is what keeps that residual risk
 * to something worth accepting.
 */

/** Hostnames that are private by name rather than by address. */
const PRIVATE_NAME = /(^|\.)(localhost|local|internal|intranet|lan|corp|home\.arpa)$/i;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Ranges that are never a customer's public website. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, and every cloud metadata endpoint
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 3], // multicast plus the reserved 240/4 above it
];

function toInt(ip: string): number | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

const BLOCKED_V4_MASKED: ReadonlyArray<readonly [number, number]> = BLOCKED_V4.map(
  ([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return [(toInt(base)! & mask) >>> 0, mask] as const;
  },
);

function isPrivateIpv4(hostname: string): boolean {
  const ip = toInt(hostname);
  if (ip === null) return false;
  return BLOCKED_V4_MASKED.some(([net, mask]) => ((ip & mask) >>> 0) === net);
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.startsWith("[")) return false;
  const inner = hostname.slice(1, -1).toLowerCase();
  if (inner === "::1" || inner === "::") return true;
  if (/^f[cd]/.test(inner)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(inner)) return true; // fe80::/10 link-local
  // The parser rewrites an IPv4-mapped address into hex, so ::ffff:127.0.0.1
  // arrives as ::ffff:7f00:1. Recover the address and reuse the v4 ranges.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
  if (!mapped) return false;
  const packed = parseInt(mapped[1], 16) * 0x10000 + parseInt(mapped[2], 16);
  return isPrivateIpv4(
    [packed >>> 24, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255].join("."),
  );
}

/**
 * A leading token followed by a colon is a scheme when it is followed by "//",
 * or when the token is purely alphabetic and what follows is not a port. That
 * second clause is what tells "mailto:someone" apart from "example.com:8080".
 */
const LEADING_TOKEN = /^([a-z][a-z0-9+.-]*):(\/\/)?/i;

function declaredScheme(raw: string): string | null {
  const m = LEADING_TOKEN.exec(raw);
  if (!m) return null;
  const [, token, slashes] = m;
  if (slashes) return token.toLowerCase();
  if (!/^[a-z]+$/i.test(token)) return null;
  const next = raw.charAt(m[0].length);
  if (/\d/.test(next)) return null;
  return token.toLowerCase();
}

export interface UrlCheck {
  ok: boolean;
  url?: string;
  reason?: string;
}

export function normaliseTarget(input: string): UrlCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "Enter a URL." };
  if (/[\s]/.test(raw)) return { ok: false, reason: "A URL cannot contain spaces." };

  const scheme = declaredScheme(raw);
  if (scheme && scheme !== "http" && scheme !== "https") {
    return { ok: false, reason: `Only http and https targets are supported, not ${scheme}.` };
  }

  let u: URL;
  try {
    u = new URL(scheme ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: "That does not parse as a URL." };
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "Only http and https targets are supported." };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "Remove the credentials from the URL." };
  }
  if (
    PRIVATE_NAME.test(u.hostname) ||
    isPrivateIpv4(u.hostname) ||
    isPrivateIpv6(u.hostname)
  ) {
    return { ok: false, reason: "Private and loopback addresses are not allowed." };
  }
  if (!u.hostname.includes(".")) {
    return { ok: false, reason: "That hostname does not look public." };
  }

  u.hash = "";
  return { ok: true, url: u.toString() };
}

/** Short, stable id for a run. Used as the screenshot directory name. */
export function newRunId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}-${r}`;
}
