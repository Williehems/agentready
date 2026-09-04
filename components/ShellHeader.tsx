import { ThemeToggle } from "./ThemeToggle";

/**
 * The bar every page wears. Extracted the moment there were three pages rather
 * than two, so the wordmark and the theme switch cannot drift apart between them.
 */
export function ShellHeader({ crumb }: { crumb?: { href: string; label: string } }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line/70 bg-ink/60 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-shell items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-baseline gap-2">
          <a href="/" className="text-[12px] font-bold uppercase tracking-[0.2em] hover:text-muted">
            AgentReady
          </a>
          {crumb ? (
            <>
              <span className="text-[11px] text-line-strong" aria-hidden>
                /
              </span>
              <a href={crumb.href} className="text-[11px] text-dim hover:text-muted">
                {crumb.label}
              </a>
            </>
          ) : null}
        </div>
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
  );
}
