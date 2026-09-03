import { AuditConsole } from "@/components/AuditConsole";
import { ThemeToggle } from "@/components/ThemeToggle";

export const metadata = {
  title: "AgentReady: run an audit",
};

export default function AuditPage() {
  return (
    <main className="audit-texture relative flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-line/70 bg-ink/60 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-shell items-center justify-between px-4 py-3 sm:px-6">
          <a href="/" className="text-[12px] font-bold uppercase tracking-[0.2em] hover:text-muted">
            AgentReady
          </a>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/solari-sdk/solari-cookbook"
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] text-dim hover:text-muted"
            >
              built on Solari
            </a>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <AuditConsole />
    </main>
  );
}
