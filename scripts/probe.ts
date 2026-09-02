/**
 * Key probe. Run this once after filling in .env.local, before the first audit:
 *
 *   npm run probe
 *
 * It exercises the same two dependencies a real run needs, in the same order,
 * through the same modules, so a green probe means an audit will work. Costs one
 * Solari session and one very small Groq completion.
 *
 * Three states, because "works but degraded" is the interesting one: stealth off
 * and a replay that has not uploaded yet are both survivable, and calling them
 * FAIL next to a summary that says everything is live is worse than useless.
 */

import { groqJson } from "../lib/groq";
import { perceive, type AgentPage } from "../lib/perceive";
import { closeClient, fetchReplayUrl, launchBrowser, releaseSession } from "../lib/solari";

const TARGET = "https://example.com/";

interface ProbePage extends AgentPage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: "domcontentloaded" }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
}

type State = "ok" | "warn" | "FAIL";

const MARK: Record<State, string> = { ok: "ok  ", warn: "warn", FAIL: "FAIL" };

const broken: string[] = [];
const degraded: string[] = [];

function line(label: string, state: State, detail: string): void {
  console.log(`${MARK[state]}  ${label.padEnd(22)} ${detail}`);
}

function fail(label: string, detail: string): void {
  line(label, "FAIL", detail);
  broken.push(`${label}: ${detail}`);
}

function warn(label: string, detail: string, consequence: string): void {
  line(label, "warn", detail);
  degraded.push(consequence);
}

async function probeGroq(): Promise<void> {
  try {
    const out = await groqJson<{ ready?: boolean }>([
      { role: "system", content: 'Reply with JSON only: {"ready":true}' },
      { role: "user", content: "ping" },
    ]);
    if (out?.ready === true) line("groq", "ok", "model answered in JSON");
    else fail("groq", `unexpected shape: ${JSON.stringify(out)}`);
  } catch (err) {
    fail("groq", err instanceof Error ? err.message : String(err));
  }
}

async function probeSolari(): Promise<void> {
  let launched: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    launched = await launchBrowser({ stealth: true });
    line("solari launch", "ok", `session ${launched.sessionId}`);
    if (launched.stealth) line("solari stealth", "ok", "granted");
    else {
      warn(
        "solari stealth",
        "not on this plan, audits will drive a plain browser",
        "stealth is off, so a bot-walled site will block the agent for the wrong reason",
      );
    }

    const page = (await launched.browser.newPage()) as unknown as ProbePage;
    await page.goto(TARGET, { timeout: 45000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    const p = await perceive(page);
    const detail = `${p.elements.length} actionable, ${p.text.length} chars of text`;
    if (p.jsGated) fail("perception", `nothing addressable on ${TARGET}: ${detail}`);
    else line("perception", "ok", detail);
  } catch (err) {
    fail("solari", err instanceof Error ? err.message : String(err));
  } finally {
    if (launched) {
      const releaseError = await releaseSession(launched.browser);
      if (releaseError) fail("release", releaseError);
      else line("release", "ok", "slot returned");

      // One look, no polling: the upload takes minutes, and the app fetches it
      // from /api/replay when the user is ready for it.
      const replay = await fetchReplayUrl(launched.solari, launched.sessionId);
      if (replay.url) line("replay", "ok", "recording already retrievable");
      else if (replay.pending) {
        warn(
          "replay",
          `${replay.reason}, which is expected this soon`,
          "the replay was not up yet, so confirm one lands before showing the product to anyone",
        );
      } else fail("replay", replay.reason ?? "no url and no reason");

      await closeClient(launched.solari);
    }
  }
}

async function main(): Promise<void> {
  const missing = ["SOLARI_API_KEY", "GROQ_API_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing ${missing.join(" and ")}. Copy .env.local.example to .env.local first.`);
    process.exit(1);
  }

  await probeGroq();
  await probeSolari();
  console.log("");

  if (broken.length) {
    console.error(`Probe failed on ${broken.length}:`);
    for (const b of broken) console.error(`  - ${b}`);
    process.exit(1);
  }
  if (degraded.length) {
    console.log(`Both dependencies are live, with ${degraded.length} caveat(s):`);
    for (const d of degraded) console.log(`  - ${d}`);
    console.log("\nAudits will run. Run `npm run dev` and audit a real site.");
    return;
  }
  console.log("Both dependencies are live. Run `npm run dev` and audit a real site.");
}

void main();
