import type { Grade, Milestone, Verdict } from "@/lib/types";
import { ReplayLink } from "./ReplayLink";

const GRADE_CLASS: Record<Grade, string> = {
  A: "text-grade-a",
  B: "text-grade-b",
  C: "text-grade-c",
  D: "text-grade-d",
  F: "text-grade-f",
};

const MILESTONE_LABEL: Record<Milestone, string> = {
  "understood-offering": "Understood what you offer",
  "found-key-info": "Found the information the task needs",
  "found-cta": "Found a usable primary action",
  "completed-action": "Completed the action",
};

const ORDER: Milestone[] = [
  "understood-offering",
  "found-key-info",
  "found-cta",
  "completed-action",
];

export function GradeCard({ verdict, url }: { verdict: Verdict; url: string }) {
  const hit = new Set(verdict.milestones);

  // The run never reached the site. Showing the letter here would publish a
  // grade nothing was measured for, and the empty progress and blocker panels
  // would read as findings about a site the agent never saw. The cell keeps its
  // width so the card still lines up with a real verdict, and says "n/a" rather
  // than a dash, which at this size reads as a rendering fault.
  if (verdict.inconclusive) {
    return (
      <section className="animate-fade-up border border-line bg-surface">
        <header className="flex items-stretch">
          <div className="flex w-28 shrink-0 items-center justify-center border-r border-line py-6 text-3xl font-bold leading-none text-dim">
            n/a
          </div>
          <div className="flex flex-1 flex-col justify-center gap-1 px-5 py-4">
            <div className="text-[11px] uppercase tracking-widest text-dim">No verdict</div>
            <p className="text-sm leading-relaxed text-text">{verdict.summary}</p>
            <div className="text-[11px] text-muted">
              nothing observed · {new URL(url).hostname}
            </div>
          </div>
        </header>
      </section>
    );
  }

  return (
    <section className="animate-fade-up border border-line bg-surface">
      <header className="flex items-stretch border-b border-line">
        {/*
         * A run our side cut short keeps its card, because everything the agent
         * saw before we stopped it is a real observation, but it cannot keep the
         * letter: forty of the hundred points are only winnable by finishing and
         * this run never got to try. So the cell says so at a size that cannot be
         * mistaken for a grade, and the footer counts steps without a score.
         */}
        {verdict.cutShort ? (
          <div className="flex w-28 shrink-0 flex-col items-center justify-center border-r border-line px-2 py-6 text-center text-dim">
            <span className="text-2xl font-bold leading-none">n/a</span>
            <span className="mt-1.5 text-[10px] uppercase tracking-widest">cut short</span>
          </div>
        ) : (
          <div
            className={`flex w-28 shrink-0 items-center justify-center border-r border-line text-6xl font-bold leading-none ${GRADE_CLASS[verdict.grade]}`}
          >
            {verdict.grade}
          </div>
        )}
        <div className="flex flex-1 flex-col justify-center gap-1 px-5 py-4">
          <div className="text-[11px] uppercase tracking-widest text-dim">
            {verdict.cutShort ? "No grade" : "Verdict"}
          </div>
          <p className="text-sm leading-relaxed text-text">{verdict.summary}</p>
          <div className="text-[11px] text-muted">
            {verdict.cutShort ? "" : `${verdict.score}/100 · `}
            {verdict.steps} steps · {new URL(url).hostname}
          </div>
        </div>
      </header>

      <div className="grid gap-0 sm:grid-cols-2">
        <div className="border-b border-line p-5 sm:border-b-0 sm:border-r">
          <h3 className="mb-3 text-[11px] uppercase tracking-widest text-dim">Progress</h3>
          <ul className="space-y-2">
            {ORDER.map((m) => {
              const done = hit.has(m);
              // Struck through means the agent tried and did not get there. On a
              // run we cut short the ones it never reached were never attempted,
              // and striking those blames the site for our stopping.
              const untested = !done && Boolean(verdict.cutShort);
              return (
                <li key={m} className="flex items-start gap-2.5 text-[13px]">
                  <span
                    className={`mt-[3px] inline-block h-2.5 w-2.5 shrink-0 border ${
                      done ? "border-grade-a bg-grade-a" : "border-line-strong"
                    }`}
                    aria-hidden
                  />
                  <span
                    className={
                      done
                        ? "text-text"
                        : untested
                          ? "text-dim"
                          : "text-dim line-through decoration-dim"
                    }
                  >
                    {MILESTONE_LABEL[m]}
                    {untested ? <span className="text-muted"> (never tested)</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="p-5">
          <h3 className="mb-3 text-[11px] uppercase tracking-widest text-dim">
            Blockers ({verdict.blockers.length})
          </h3>
          {verdict.blockers.length === 0 ? (
            <p className="text-[13px] text-muted">
              {verdict.cutShort
                ? "Nothing had stopped the agent by the time we stopped it, which is not the same as nothing being there."
                : "Nothing stopped the agent. This site is legible to machines."}
            </p>
          ) : (
            <ul className="space-y-3">
              {verdict.blockers.map((b, i) => (
                <li key={`${b.blocker}-${i}`}>
                  <div className="text-[12px] font-bold text-grade-f">{b.blocker}</div>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{b.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {verdict.replayUrl || verdict.sessionId ? (
        <footer className="border-t border-line px-5 py-3">
          <ReplayLink sessionId={verdict.sessionId} url={verdict.replayUrl} />
        </footer>
      ) : null}
    </section>
  );
}
