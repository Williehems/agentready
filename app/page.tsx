import Link from "next/link";

const FACTS = [
  {
    key: "A to F",
    line: "One grade, computed from how far the agent actually got, not from a second opinion about your markup.",
  },
  {
    key: "10 steps",
    line: "The cap on every run. A site that needs more than ten moves for one action has already told you something.",
  },
  {
    key: "Replay",
    line: "The recording of the attempt, so a blocker is a thing you can watch rather than a claim you have to trust.",
  },
];

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 pt-8">
        <span className="text-[12px] font-bold uppercase tracking-[0.2em]">AgentReady</span>
        <a
          href="https://github.com/solari-sdk/solari-cookbook"
          target="_blank"
          rel="noreferrer noopener"
          className="text-[11px] text-dim hover:text-muted"
        >
          built on Solari
        </a>
      </header>

      <section className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-6 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16 lg:py-24">
        <div>
          <p className="text-[10px] uppercase tracking-[0.24em] text-dim">Agent readiness audit</p>

          <h1 className="mt-5 max-w-2xl text-3xl font-bold leading-[1.14] sm:text-[44px]">
            Can an AI agent actually
            <br />
            use your website?
          </h1>

          <p className="mt-6 max-w-lg text-[13px] leading-relaxed text-muted">
            A growing share of your visitors are agents acting for a human. This sends a real
            stealth browser to attempt the one action your site exists for, then shows you the
            grade, the blockers, and the exact step where it gave up.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4">
            <Link
              href="/audit"
              className="inline-flex h-14 items-center rounded-full bg-text px-8 text-[11px] font-bold uppercase tracking-[0.16em] text-ink transition-transform hover:-translate-y-px"
            >
              run an audit
            </Link>
            <span className="text-[11px] text-dim">
              One cloud browser per run.
              <br className="hidden sm:block" /> No payment details are ever entered.
            </span>
          </div>
        </div>

        {/* The picture, given a frame instead of being washed across the page: at
            this contrast a full-bleed version of it is invisible, and a visible
            edge is what makes it read as chosen rather than left over. */}
        <div className="shot aspect-[16/11] w-full lg:aspect-[4/5]" role="presentation" />
      </section>

      <div className="mx-auto w-full max-w-6xl px-6 pb-14">
        <div className="rule" />
        <dl className="grid gap-x-8 gap-y-6 pt-6 sm:grid-cols-3">
          {FACTS.map((f) => (
            <div key={f.key}>
              <dt className="text-[12px] font-bold uppercase tracking-[0.14em]">{f.key}</dt>
              <dd className="mt-2 text-[12px] leading-relaxed text-dim">{f.line}</dd>
            </div>
          ))}
        </dl>
      </div>
    </main>
  );
}
