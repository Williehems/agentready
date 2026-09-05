import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { grade, type Transcript } from "@/lib/grade";
import type { ActionKind, StepRecord, Verdict } from "@/lib/types";

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
  /**
   * Every turn the agent took, with its own reasoning, when the run was recorded
   * by a build that kept them. Absent on the runs behind this feature: their
   * reasoning went out live and was never written down.
   */
  steps?: StepRecord[];
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
/**
 * Where a shipped example's screenshots live, which is not where a live run puts
 * its own.
 *
 * `public/runs/` is gitignored, so for a long time the committed examples arrived
 * on a fresh clone with their notes and none of their frames: half the product is
 * called Witness and the half a stranger could see was the half without pictures.
 * An example's frames are committed here instead, deliberately outside the
 * directory a re-run is allowed to overwrite.
 */
const SHIPPED = () => path.join(process.cwd(), "public", "examples");

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

  // The notes and the frames beside them are two independent reads, so they go out
  // together. If the notes are not there the pair rejects and the next place is
  // tried, exactly as before; readShots answers undefined rather than throwing.
  try {
    const [raw, shots] = await Promise.all([
      readJson(path.join(RUNTIME(), runId, "transcript.json")),
      readShots(runId, RUNTIME(), "/runs"),
    ]);
    const found = shaped(raw, runId);
    if (found) return { ...found, shots };
  } catch {
    // Not run on this machine, or not run since the last deploy wiped the disk.
  }
  try {
    const [raw, shots] = await Promise.all([
      readJson(path.join(EXAMPLES(), `${runId}.json`)),
      readShots(runId, SHIPPED(), "/examples"),
    ]);
    const found = shaped(raw, runId);
    if (found) return { ...found, example: true, shots };
  } catch {
    // No such run anywhere.
  }
  return undefined;
}

/** The screenshots a run left beside its notes, in the order it took them. */
async function readShots(
  runId: string,
  dir: string,
  prefix: string,
): Promise<string[] | undefined> {
  try {
    const files = (await readdir(path.join(dir, runId)))
      .filter((f) => /\.(jpe?g|png)$/i.test(f))
      .sort();
    return files.length ? files.map((f) => `${prefix}/${runId}/${f}`) : undefined;
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
  const sources = [
    { dir: EXAMPLES(), isExample: true },
    { dir: RUNTIME(), isExample: false },
  ] as const;

  // Both directories at once, and every transcript inside them at once. Read one
  // after another, this page waited for the sum of forty-odd file reads and
  // forty-odd regrades when it could have waited for the slowest one. Unbounded on
  // purpose: the count here is the number of runs this instance has ever kept, and
  // the daily cap in runs.ts is what keeps that a number of runs rather than a
  // number worth pooling.
  const listings = await Promise.all(
    sources.map(async ({ dir, isExample }) => {
      let entries: string[] = [];
      try {
        entries = await readdir(dir);
      } catch {
        return [];
      }
      const wanted = entries.flatMap((entry) => {
        const runId = isExample ? entry.replace(/\.json$/i, "") : entry;
        if (entry === runId && isExample) return []; // not a .json file
        if (!RUN_ID.test(runId)) return [];
        const file = isExample ? path.join(dir, entry) : path.join(dir, entry, "transcript.json");
        return [{ runId, file }];
      });
      return Promise.all(
        wanted.map(async ({ runId, file }) => {
          try {
            const found = shaped(await readJson(file), runId);
            if (!found) return undefined;
            return { key: runId, run: isExample ? { ...found, example: true as const } : found };
          } catch {
            // A directory with no notes in it, or notes we cannot parse. Skip it.
            return undefined;
          }
        }),
      );
    }),
  );

  // Collected in source order, examples then runtime, so a run that has been re-run
  // here wins: the runtime copy is the one with the screenshots beside it. Keyed on
  // the id the directory gave rather than the one the file claims, which is what
  // decides whether the two copies are the same run.
  const ids = new Map<string, StoredRun>();
  for (const found of listings.flat()) {
    if (found) ids.set(found.key, found.run);
  }

  return Array.from(ids.values())
    .map(summarise)
    .sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}


