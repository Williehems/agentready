import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { keepsRuns, listRuns, readRun, runTime } from "../lib/store";

/**
 * These read the repository itself, which is the point.
 *
 * `examples/` is tracked, so the run in it is the evidence a stranger sees on a
 * fresh clone before they have spent a browser session of their own. A grader
 * change that would quietly downgrade that run is a change that has to fail the
 * gate loudly rather than be noticed later on a deployed page.
 */

describe("runTime", () => {
  it("recovers when a run happened from its id alone", () => {
    // The id newRunId() minted for the first A this product ever gave.
    const at = runTime("mtmvbwgn-6pofvk");
    assert.ok(at, "the base36 prefix is a timestamp");
    assert.equal(new Date(at).getUTCFullYear(), 2026);
  });

  it("refuses a prefix that is not a time", () => {
    // Base36 parses far more than it should: "examples" is a number to it, and a
    // small one, which is why the floor is checked rather than the parse alone.
    assert.equal(runTime("examples"), undefined);
    assert.equal(runTime("abc-def"), undefined);
    assert.equal(runTime(""), undefined);
  });
});

describe("readRun", () => {
  it("will not be walked out of the runs directory", async () => {
    // The id is a path segment and it arrives from the URL, so this is the only
    // thing standing between a visitor and the filesystem.
    for (const id of [
      "../../../etc/passwd",
      "..",
      "./secrets",
      "a/b",
      "a\\b",
      "run\0id",
      "-leading-dash",
    ]) {
      assert.equal(await readRun(id), undefined, id);
    }
  });

  it("answers nothing for a well formed id that was never run", async () => {
    assert.equal(await readRun("zzzzzzzz-000000"), undefined);
  });

  it("reads the run that ships with the repository", async () => {
    const run = await readRun("mtmvbwgn-6pofvk");
    assert.ok(run, "examples/mtmvbwgn-6pofvk.json is tracked and must be readable");
    // Not `example: true`. On the machine that made this run the same id is also
    // sitting in public/runs with its screenshot beside it, and readRun prefers
    // that copy on purpose. Both files carry the same transcript, so everything
    // below holds either way; which of the two answered is a fact about the
    // machine, not about the run.
    assert.equal(run.action, "integrate");
    assert.match(run.url, /^https:\/\/docs\.stripe\.com\//);
    // Recomputed from the transcript, not read back from the file.
    assert.equal(run.verdict.grade, "A");
    assert.equal(run.verdict.score, 100);
    assert.equal(run.verdict.steps, 1);
    assert.ok(run.verdict.milestones.includes("completed-action"));
    assert.equal(run.verdict.blockers.length, 0);
    assert.ok(run.verdict.sessionId, "the replay is fetched from this and nothing else");
    // Written before the step log existed, and honest about it on the page.
    assert.equal(run.steps, undefined);
  });
});

describe("listRuns", () => {
  it("includes the shipped example, newest first", async () => {
    const runs = await listRuns();
    assert.ok(runs.length >= 1);
    const found = runs.find((r) => r.runId === "mtmvbwgn-6pofvk");
    assert.ok(found, "a fresh clone must have at least one graded run to show");
    assert.equal(found.grade, "A");
    assert.equal(found.host, "docs.stripe.com");
    assert.equal(found.withheld, undefined, "this letter is the site's own");

    // The ids begin as base36 milliseconds, so a lexical sort is chronological.
    const ids = runs.map((r) => r.runId);
    assert.deepEqual(ids, [...ids].sort().reverse());
  });

  it("never quotes a letter it withheld", async () => {
    // A run we cut short keeps its card and loses its grade. The board counts on
    // `withheld` to know which of the two it is looking at, so the pairing of a
    // withheld run with a real letter must not exist.
    for (const r of await listRuns()) {
      if (r.withheld) assert.ok(["cut short", "no verdict"].includes(r.withheld));
    }
  });
});

describe("keepsRuns", () => {
  it("says yes on a disk that takes writes", async () => {
    // The ordinary case, and the one the board's promise depends on: a laptop.
    assert.equal(await keepsRuns(), true);
  });

  it("says no when the runs directory cannot be made", async () => {
    // A read-only serverless filesystem, stood in for by a root that is a file.
    // mkdir cannot make a directory underneath package.json on any platform, and
    // which errno it picks does not matter: the question is only whether the write
    // a run is about to attempt would land.
    const real = process.cwd;
    process.cwd = () => path.join(real(), "package.json");
    try {
      assert.equal(await keepsRuns(), false);
    } finally {
      process.cwd = real;
    }
  });

  it("leaves the answer to the disk rather than to an env var", async () => {
    // Deliberately not `process.env.VERCEL`. A run is lost because a filesystem
    // refused it, so if this ever starts reading a host name it will be right on
    // Vercel and wrong everywhere else that mounts its code read-only.
    const src = await readFile(new URL("../lib/store.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export async function keepsRuns"));
    assert.ok(!/process\.env/.test(body.slice(0, body.indexOf("\n}"))));
  });
});
