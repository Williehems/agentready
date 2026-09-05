import Link from "next/link";
import { ShellHeader } from "@/components/ShellHeader";
import { keepsRuns, listRuns, type RunSummary } from "@/lib/store";

export const metadata = {
  title: "AgentReady: runs on the board",
};

/**
 * Read the disk on every request: where a run can be kept, one that finished a
 * second ago belongs on this list. Where it cannot, the page says so, because a
 * board that silently never grows is worse than one that admits why.
 */
export const dynamic = "force-dynamic";

const GRADE_CLASS: Record<string, string> = {
  A: "text-grade-a",
  B: "text-grade-b",
  C: "text-grade-c",
  D: "text-grade-d",
  F: "text-grade-f",
};

const ACTION_LABEL: Record<string, string> = {
  signup: "sign up",
  purchase: "buy something",
  integrate: "integrate the api",
  book: "book something",
  contact: "get in touch",
};

function when(at?: number): string {
  if (!at) return "";
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * How many of these letters are the site's own.
 *
 * The count matters more than it looks. A run we stopped, or one that never
 * reached the site, still has a score in it, and quoting those alongside the real
 * ones would inflate the board with grades about our token budget.
 */
function tally(runs: RunSummary[]) {
  const real = runs.filter((r) => !r.withheld);
  const letters: Record<string, number> = {};
  for (const r of real) letters[r.grade] = (letters[r.grade] ?? 0) + 1;
  return { real, letters, withheld: runs.length - real.length };
}

export default async function RunsPage() {
  // Two independent reads of the same disk, so they go out together.
  const [runs, kept] = await Promise.all([listRuns(), keepsRuns()]);
  const { real, letters, withheld } = tally(runs);

  return (
    <main className="audit-texture relative flex min-h-screen flex-col">
      <ShellHeader crumb={{ href: "/runs", label: "runs" }} />

      <div className="mx-auto w-full max-w-shell px-4 py-10 sm:px-6">
        <h1 className="text-lg font-bold tracking-tight">Runs on the board</h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
          Every audit this instance has on disk. {real.length} of {runs.length} carry a letter the
          site earned; {withheld} do not, because we stopped the run or the page never loaded, and a
          grade about our own budget is not a finding about anyone&apos;s website.
        </p>

        {!kept ? (
          <p className="mt-3 max-w-2xl border-l-2 border-line pl-3 text-[13px] leading-relaxed text-dim">
            This instance cannot keep a run. Its filesystem is read-only, so an audit you start
            here streams to your screen, grades correctly, and is gone the moment it ends: it will
            not appear below and its link would be a 404. The runs listed ship with the repository.
            Clone it and yours stay.
          </p>
        ) : null}

        {real.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-dim">
            {["A", "B", "C", "D", "F"].map((g) => (
              <span key={g}>
                <span className={`font-bold ${GRADE_CLASS[g]}`}>{g}</span> {letters[g] ?? 0}
              </span>
            ))}
          </div>
        ) : null}

        {runs.length === 0 ? (
          <p className="mt-10 border border-line bg-surface p-5 text-[13px] text-muted">
            Nothing here yet.{" "}
            <Link href="/audit" className="underline hover:text-text">
              Run an audit
            </Link>
            {kept
              ? " and it will be on this list before the page finishes streaming."
              : ". It will not land here, because this instance cannot write to its own disk."}
          </p>
        ) : (
          <ul className="mt-8 border border-line bg-surface">
            {/* Client-side navigation, but no prefetching: every row points at a
                force-dynamic page that parses a transcript and regrades it, and a
                board of thirty rows would otherwise render thirty of them on the
                server the moment the list came into view. */}
            {runs.map((r) => (
              <li key={r.runId} className="border-b border-line last:border-b-0">
                <Link
                  href={`/runs/${r.runId}`}
                  prefetch={false}
                  className="flex items-stretch gap-0 hover:bg-line/20"
                >
                  <div className="flex w-16 shrink-0 items-center justify-center border-r border-line">
                    {r.withheld ? (
                      <span className="text-[10px] uppercase tracking-widest text-dim">n/a</span>
                    ) : (
                      <span className={`text-2xl font-bold leading-none ${GRADE_CLASS[r.grade]}`}>
                        {r.grade}
                      </span>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-4 py-3">
                    <div className="truncate text-[13px] text-text">{r.host}</div>
                    <div className="text-[11px] text-muted">
                      {ACTION_LABEL[r.action] ?? r.action} ·{" "}
                      {r.withheld ? r.withheld : `${r.score}/100`} · {r.steps}{" "}
                      {r.steps === 1 ? "step" : "steps"}
                      {r.example ? " · shipped with the repo" : ""}
                    </div>
                  </div>
                  <div className="hidden shrink-0 items-center px-4 text-[11px] text-dim sm:flex">
                    {when(r.at)}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
