import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";

const FACTS = [
  {
    key: "A to F",
    line: "One grade, from how far the agent actually got.",
  },
  {
    key: "10 steps",
    line: "The cap on every run. Needing more is itself an answer.",
  },
  {
    key: "Replay",
    line: "The recording, so a blocker is a thing you can watch.",
  },
];

export default function Home() {
  return (
    <main className="field flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 pt-7">
        <span className="text-[12px] font-bold uppercase tracking-[0.2em]">AgentReady</span>
        <div className="flex items-center gap-4">
          <a
            href="https://github.com/solari-sdk/solari-cookbook"
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] text-text/70 hover:text-text"
          >
            built on Solari
          </a>
          <ThemeToggle />
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-6xl flex-1 items-center px-6 py-20">
        <div className="max-w-[32rem]">
          <p className="text-[10px] uppercase tracking-[0.24em] text-text/55">
            Agent readiness audit
          </p>

          <h1 className="mt-5 text-3xl font-bold leading-[1.14] sm:text-[42px]">
            Can an AI agent
            <br />
            actually use
            <br />
            your website?
          </h1>

          <p className="mt-6 max-w-sm text-[13px] leading-relaxed text-text/75">
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
            {/* The evidence, one click from the front door. A stranger should be able
                to read a real graded run without spending a browser session of ours
                to make one. */}
            <Link
              href="/runs"
              className="text-[11px] font-bold uppercase tracking-[0.16em] text-text/70 underline decoration-text/30 underline-offset-4 hover:text-text"
            >
              see graded runs
            </Link>
            <span className="text-[11px] text-text/60">
              One cloud browser per run.
              <br className="hidden sm:block" /> No payment details are ever entered.
            </span>
          </div>
        </div>
      </section>

      {/* Held to the left half as well, so the figure keeps the right side of the
          frame to itself all the way down. */}
      <div className="mx-auto w-full max-w-6xl px-6 pb-10">
        <div className="rule max-w-3xl" />
        <dl className="grid max-w-3xl gap-x-8 gap-y-5 pt-5 sm:grid-cols-3">
          {FACTS.map((f) => (
            <div key={f.key}>
              <dt className="text-[11px] font-bold uppercase tracking-[0.14em]">{f.key}</dt>
              <dd className="mt-1.5 text-[12px] leading-relaxed text-text/60">{f.line}</dd>
            </div>
          ))}
        </dl>
      </div>
    </main>
  );
}
