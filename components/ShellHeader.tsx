import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The bar every page wears. Extracted the moment there were three pages rather
 * than two, so the wordmark and the theme switch cannot drift apart between them.
 *
 * Both internal links are `Link` rather than `a`, which is what keeps a header on
 * every page from being a header that reloads the document on every press: Next
 * fetches the next page in the background on hover and swaps it in without
 * discarding the one being looked at. It matters most here, because the theme is
 * decided by a script in the document and a full reload is the one thing that makes
 * the eclipse look like a flash.
 *
 * The crumb opts out of prefetching. It points at a force-dynamic page that reads
 * every transcript on disk, and the header sits in the viewport of every page, so
 * the default would list the runs once more for every page anyone merely looked at.
 */
export function ShellHeader({ crumb }: { crumb?: { href: string; label: string } }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line/70 bg-ink/60 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-shell items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-baseline gap-2">
          <Link
            href="/"
            className="text-[12px] font-bold uppercase tracking-[0.2em] hover:text-muted"
          >
            AgentReady
          </Link>
          {crumb ? (
            <>
              <span className="text-[11px] text-line-strong" aria-hidden>
                /
              </span>
              <Link
                href={crumb.href}
                prefetch={false}
                className="text-[11px] text-dim hover:text-muted"
              >
                {crumb.label}
              </Link>
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
