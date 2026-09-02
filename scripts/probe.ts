/**
 * Key probe. Run this once after filling in .env.local, before the first audit:
 *
 *   npm run probe
 *
 * It exercises the same two dependencies a real run needs, in the same order,
 * through the same modules, so a green probe means an audit will work. Costs one
 * Solari session and one very small Groq completion.
 */

import { groqJson } from "../lib/groq";
import { perceive, type AgentPage } from "../lib/perceive";
import { closeClient, getReplayUrl, launchBrowser, releaseSession } from "../lib/solari";

const TARGET = "https://example.com/";

interface ProbePage extends AgentPage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: "domcontentloaded" }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
}

function line(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(22)} ${detail}`);
}

async function probeGroq(): Promise<boolean> {
  try {
    const out = await groqJson<{ ready?: boolean }>(
      [
        { role: "system", content: 'Reply with JSON only: {"ready":true}' },
        { role: "user", content: "ping" },
      ],
      { maxTokens: 20 },
    );
    const ok = out?.ready === true;
    line("groq", ok, ok ? "model answered in JSON" : `unexpected shape: ${JSON.stringify(out)}`);
    return ok;
  } catch (err) {
    line("groq", false, err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function probeSolari(): Promise<boolean> {
  let launched: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    launched = await launchBrowser({ stealth: true });
    line("solari launch", true, `session ${launched.sessionId}`);
    line("solari stealth", launched.stealth, launched.stealth ? "granted" : "not on this plan");

    const page = (await launched.browser.newPage()) as unknown as ProbePage;
    await page.goto(TARGET, { timeout: 45000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    const p = await perceive(page);
    const ok = !p.jsGated;
    line("perception", ok, `${p.elements.length} actionable, ${p.text.length} chars of text`);
    return ok;
  } catch (err) {
    line("solari", false, err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    if (launched) {
      await releaseSession(launched.browser);
      const replay = await getReplayUrl(launched.solari, launched.sessionId);
      line("replay", Boolean(replay), replay ? "recording is retrievable" : "no replay url yet");
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

  const groqOk = await probeGroq();
  const solariOk = await probeSolari();

  console.log("");
  if (groqOk && solariOk) {
    console.log("Both dependencies are live. Run `npm run dev` and audit a real site.");
    return;
  }
  console.error("Probe failed. Fix the lines marked FAIL before running an audit.");
  process.exit(1);
}

void main();
