import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { grade, type Transcript } from "@/lib/grade";
import type { ActionKind, Verdict } from "@/lib/types";

/**
 * The runs already on disk, read back.
 *
 * Every run has always written itself down. Nothing could read it: the only two
 * pages in the product are the invitation and the console, so the thirty-two runs
 * behind this build, the A among them, were visible to whoever ran them and to
 * nobody else. A visitor who wanted to see one had to spend a browser session of
 * ours to make their own. This is the missing half of Witness, and it costs no
 * API call: the evidence is sitting in the filesystem.
 *
 * Two roots, because runtime output is gitignored on purpose. `public/runs` is
 * where a live run lands, screenshots and all, and it does not survive a clone or
 * a deploy. `examples/` is tracked, so a stranger who opens the deployed site sees
 * a real graded run rather than an empty list and a form.
 */

export interface StoredRun {
  runId: string;
  url: string;
  action: ActionKind;
  spend?: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    heldMs: number;
    remainingTokens?: number;
    limitTokens?: number;
  };
  transcript: Transcript;
  verdict: Verdict;
  /** Screenshot paths under /runs, newest run only: these are not committed. */
  shots?: string[];
  /** True when this run ships with the repo rather than having been run here. */
  example?: true;
}

/**
 * A run id is a path segment, and it arrives from the URL. Base36 time and six
 * random characters is all `newRunId` ever produces, so anything else is either a
 * typo or someone walking the filesystem, and both get the same answer.
 */
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const RUNTIME = () => path.join(process.cwd(), "public", "runs");
const EXAMPLES = () => path.join(process.cwd(), "examples");

/** When the run happened, out of its own id: base36 milliseconds, then randomness. */
export function runTime(runId: string): number | undefined {
  const stamp = Number.parseInt(runId.split("-")[0] ?? "", 36);
  // Anything before this product existed or after the next century is not a stamp.
  return Number.isFinite(stamp) && stamp > 1_700_000_000_000 ? stamp : undefined;
}

/**
 * The verdict is recomputed from the transcript rather than read back.
 *
 * Grading is a pure function of what the agent saw, so the transcript is the
 * evidence and the letter is only ever a reading of it. A run graded in March by a
 * grader that has since been corrected would otherwise keep showing its old
 * sentence forever: the very first A this product gave says "in 1 steps" in the
 * file, because it was written before that was fixed. Checked against all 32
 * stored runs when this went in, the recomputed letter and score matched the
 * stored ones exactly, so this is not quietly restating anyone's grade.
 *
 * `sessionId` and `replayUrl` are put back by hand, because they are facts about
 * the run rather than conclusions about the site, and the grader has never seen
 * them.
 */
function shaped(raw: unknown, runId: string): StoredRun | undefined {
  const r = raw as StoredRun | undefined;
  if (!r?.transcript || !r?.verdict || typeof r.url !== "string") return undefined;
  const verdict: Verdict = {
    ...grade(r.transcript),
    sessionId: r.verdict.sessionId,
    replayUrl: r.verdict.replayUrl,
  };
  return { ...r, runId: r.runId || runId, verdict };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * One run, from wherever it lives. Runtime first: if a run has been re-run here it
 * is the live copy that has the screenshots beside it.
 */
export async function readRun(runId: string): Promise<StoredRun | undefined> {
  if (!RUN_ID.test(runId)) return undefined;

  try {
    const found = shaped(await readJson(path.join(RUNTIME(), runId, "transcript.json")), runId);
    if (found) return { ...found, shots: await readShots(runId) };
  } catch {
    // Not run on this machine, or not run since the last deploy wiped the disk.
  }
  try {
    const found = shaped(await readJson(path.join(EXAMPLES(), `${runId}.json`)), runId);
    if (found) return { ...found, example: true };
  } catch {
    // No such run anywhere.
  }
  return undefined;
}

/** The screenshots a live run left beside its notes, in the order it took them. */
async function readShots(runId: string): Promise<string[] | undefined> {
  try {
    const files = (await readdir(path.join(RUNTIME(), runId)))
      .filter((f) => /\.(jpe?g|png)$/i.test(f))
      .sort();
    return files.length ? files.map((f) => `/runs/${runId}/${f}`) : undefined;
  } catch {
    return undefined;
  }
}

export interface RunSummary {
  runId: string;
  url: string;
  host: string;
  action: ActionKind;
  grade: Verdict["grade"];
  score: number;
  steps: number;
  /** Set when the letter is not the site's to own: we stopped it, or it never arrived. */
  withheld?: "cut short" | "no verdict";
  at?: number;
  example?: true;
}

function summarise(r: StoredRun): RunSummary {
  let host = r.url;
  try {
    host = new URL(r.url).hostname.replace(/^www\./, "");
  } catch {
    // A stored run with an unparseable url is still a run; show the string.
  }
  return {
    runId: r.runId,
    url: r.url,
    host,
    action: r.action,
    grade: r.verdict.grade,
    score: r.verdict.score,
    steps: r.verdict.steps,
    withheld: r.verdict.inconclusive ? "no verdict" : r.verdict.cutShort ? "cut short" : undefined,
    at: runTime(r.runId),
    example: r.example,
  };
}

/**
 * Every run this instance can show, newest first.
 *
 * Sorted on the id, which begins as base36 milliseconds, so the ordering is the
 * run order without reading a single file date. Runtime copies win over examples
 * of the same id, since the runtime one is the one with the screenshots.
 */
export async function listRuns(): Promise<RunSummary[]> {
  const ids = new Map<string, StoredRun>();

  for (const [dir, isExample] of [
    [EXAMPLES(), true],
    [RUNTIME(), false],
  ] as const) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const runId = isExample ? entry.replace(/\.json$/i, "") : entry;
      if (entry === runId && isExample) continue; // not a .json file
      if (!RUN_ID.test(runId)) continue;
      const file = isExample ? path.join(dir, entry) : path.join(dir, entry, "transcript.json");
      try {
        const found = shaped(await readJson(file), runId);
        if (found) ids.set(runId, isExample ? { ...found, example: true } : found);
      } catch {
        // A directory with no notes in it, or notes we cannot parse. Skip it.
      }
    }
  }

  return Array.from(ids.values())
    .map(summarise)
    .sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}


