import { AuditConsole } from "@/components/AuditConsole";

export default function Home() {
  return (
    <main className="hero-texture min-h-screen">
      <div className="mx-auto max-w-shell px-6 pb-24 pt-10 sm:pt-16">
        <header className="mb-16 flex items-center justify-between">
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

        <h1 className="max-w-xl text-3xl font-bold leading-[1.15] sm:text-[42px]">
          Can an AI agent actually
          <br />
          use your website?
        </h1>

        <p className="mt-5 max-w-lg text-[13px] leading-relaxed text-muted">
          A growing share of your visitors are agents acting for a human. This sends a real
          stealth browser to attempt the one action your site exists for, then shows you the
          grade, the blockers, and the exact step where it gave up.
        </p>

        <div className="mt-10">
          <AuditConsole />
        </div>

        <div className="rule mt-16" />
        <p className="mt-4 text-[11px] leading-relaxed text-dim">
          One cloud browser per run, ten steps maximum, no payment details ever entered.
          Grades are computed from what the agent reached, not from a second opinion about it.
        </p>
      </div>
    </main>
  );
}
