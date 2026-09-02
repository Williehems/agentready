import type { Grade, Milestone, Verdict } from "@/lib/types";

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

  return (
    <section className="animate-fade-up border border-line bg-surface">
      <header className="flex items-stretch border-b border-line">
        <div
          className={`flex w-28 shrink-0 items-center justify-center border-r border-line text-6xl font-bold leading-none ${GRADE_CLASS[verdict.grade]}`}
        >
          {verdict.grade}
        </div>
        <div className="flex flex-1 flex-col justify-center gap-1 px-5 py-4">
          <div className="text-[11px] uppercase tracking-widest text-dim">Verdict</div>
          <p className="text-sm leading-relaxed text-text">{verdict.summary}</p>
          <div className="text-[11px] text-muted">
            {verdict.score}/100 · {verdict.steps} steps · {new URL(url).hostname}
          </div>
        </div>
      </header>

      <div className="grid gap-0 sm:grid-cols-2">
        <div className="border-b border-line p-5 sm:border-b-0 sm:border-r">
          <h3 className="mb-3 text-[11px] uppercase tracking-widest text-dim">Progress</h3>
          <ul className="space-y-2">
            {ORDER.map((m) => {
              const done = hit.has(m);
              return (
                <li key={m} className="flex items-start gap-2.5 text-[13px]">
                  <span
                    className={`mt-[3px] inline-block h-2.5 w-2.5 shrink-0 border ${
                      done ? "border-grade-a bg-grade-a" : "border-line-strong"
                    }`}
                    aria-hidden
                  />
                  <span className={done ? "text-text" : "text-dim line-through decoration-dim"}>
                    {MILESTONE_LABEL[m]}
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
              Nothing stopped the agent. This site is legible to machines.
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

      {verdict.replayUrl ? (
        <footer className="border-t border-line px-5 py-3">
          <a
            href={verdict.replayUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[12px] text-muted underline decoration-line-strong underline-offset-4 hover:text-text"
          >
            Download the session replay (rrweb NDJSON)
          </a>
        </footer>
      ) : null}
    </section>
  );
}
