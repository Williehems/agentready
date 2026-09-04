import { notFound } from "next/navigation";
import { GradeCard } from "@/components/GradeCard";
import { ShellHeader } from "@/components/ShellHeader";
import { readRun, runTime } from "@/lib/store";

/** The disk is the source: a run finished a second ago must render on the first ask. */
export const dynamic = "force-dynamic";

const ACTION_LABEL: Record<string, string> = {
  signup: "sign up",
  purchase: "buy something",
  integrate: "integrate the api",
  book: "book something",
  contact: "get in touch",
};

export async function generateMetadata({ params }: { params: { id: string } }) {
  const run = await readRun(params.id);
  if (!run) return { title: "AgentReady: no such run" };
  let host = run.url;
  try {
    host = new URL(run.url).hostname;
  } catch {
    // Show the raw string rather than throwing inside metadata.
  }
  const letter = run.verdict.cutShort || run.verdict.inconclusive ? "no grade" : run.verdict.grade;
  return { title: `AgentReady: ${host} scored ${letter}` };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] uppercase tracking-widest text-dim">{label}</div>
      <div className="mt-1 text-[13px] text-text">{children}</div>
    </div>
  );
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 border border-line bg-surface">
      <header className="border-b border-line px-4 py-2.5">
        <h2 className="text-[11px] uppercase tracking-widest text-dim">{title}</h2>
        {note ? <p className="mt-1 text-[11px] text-muted">{note}</p> : null}
      </header>
      {children}
    </section>
  );
}

export default async function RunPage({ params }: { params: { id: string } }) {
  const run = await readRun(params.id);
  if (!run) notFound();

  const t = run.transcript;
  const at = runTime(run.runId);
  const tokens = run.spend ? run.spend.promptTokens + run.spend.completionTokens : undefined;

  return (
    <main className="audit-texture relative flex min-h-screen flex-col">
      <ShellHeader crumb={{ href: "/runs", label: "runs" }} />

      <div className="mx-auto w-full max-w-shell px-4 py-10 sm:px-6">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="min-w-0 break-all text-sm text-muted">
            <a href={run.url} target="_blank" rel="noreferrer noopener" className="hover:text-text">
              {run.url}
            </a>
          </h1>
          <span className="text-[11px] text-dim">
            {run.runId}
            {at ? ` · ${new Date(at).toISOString().slice(0, 16).replace("T", " ")}` : ""}
          </span>
        </div>

        <GradeCard verdict={run.verdict} url={run.url} />

        <div className="mt-6 grid grid-cols-2 border border-line bg-surface sm:grid-cols-4 [&>*]:border-b [&>*]:border-r [&>*]:border-line">
          <Fact label="Task">{ACTION_LABEL[run.action] ?? run.action}</Fact>
          <Fact label="Steps">{t.stepCount}</Fact>
          <Fact label="Browser">{t.stealth ? "stealth" : "plain"}</Fact>
          <Fact label="Our tokens">
            {tokens === undefined ? "not recorded" : `${tokens.toLocaleString("en-US")}`}
            {run.spend ? (
              <span className="text-dim">
                {" "}
                in {run.spend.calls} {run.spend.calls === 1 ? "call" : "calls"}
              </span>
            ) : null}
          </Fact>
        </div>

        {t.abandoned ? (
          <p className="mt-4 border border-grade-d/40 bg-surface px-4 py-3 text-[12px] leading-relaxed text-muted">
            We ended this run, not the site: {t.abandoned}
          </p>
        ) : null}

        <Panel
          title={`Where it went (${t.perceptions.length})`}
          note="Every page the agent read, in order, as it read it: not a screenshot but the text and the controls the grader was given."
        >
          {t.perceptions.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted">
              Nothing was ever perceived. The run did not reach the site.
            </p>
          ) : (
            <ol className="divide-y divide-line">
              {t.perceptions.map((p, i) => (
                <li key={`${p.url}-${i}`} className="flex gap-3 px-4 py-3">
                  <span className="w-6 shrink-0 text-[11px] text-dim">{i}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-text">{p.title || "(untitled)"}</div>
                    <div className="truncate text-[11px] text-muted">{p.url}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-dim">
                      <span>{p.elements.length} controls</span>
                      <span>
                        {p.text.replace(/\s+/g, " ").trim().length.toLocaleString("en-US")} chars of
                        text
                      </span>
                      {p.hasPrice ? <span className="text-grade-a">price in text</span> : null}
                      {p.jsGated ? <span className="text-grade-f">nothing without JS</span> : null}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        {run.steps?.length ? (
          <Panel
            title={`Why it moved (${run.steps.length})`}
            note="Each turn as the agent took it, in its own words. This is the model's account of itself and the grader never reads it: a site is graded on what it did to the agent, not on how the agent spoke about it."
          >
            <ol className="divide-y divide-line">
              {run.steps.map((s) => (
                <li key={s.index} className="flex gap-3 px-4 py-3">
                  <span className="w-6 shrink-0 text-[11px] text-dim">{s.index}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[12px] font-bold text-text">{s.action}</span>
                      {s.target ? (
                        <span className="min-w-0 truncate text-[12px] text-muted">
                          &ldquo;{s.target}&rdquo;
                        </span>
                      ) : null}
                      {s.value ? (
                        <span className="text-[11px] text-dim">with {s.value}</span>
                      ) : null}
                      {/* Only the refusals are coloured. A run of green ticks down the
                          side of a page teaches the reader nothing, and the thing they
                          came for is the one row where the page said no. */}
                      {s.ok ? null : (
                        <span className="text-[10px] uppercase tracking-widest text-grade-f">
                          refused
                        </span>
                      )}
                    </div>
                    {s.reasoning ? (
                      <p className="mt-1 text-[13px] leading-relaxed text-text/80">
                        {s.reasoning}
                      </p>
                    ) : null}
                    {s.error ? (
                      <p className="mt-1 text-[11px] leading-relaxed text-muted">{s.error}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
        ) : null}

        <div className="grid gap-6 sm:grid-cols-2">
          <Panel
            title={`What it did (${(t.operated ?? []).length})`}
            note={
              run.steps?.length
                ? "Only the moves that landed. A step 0 that reads the page and declares itself finished operates nothing."
                : "Only the moves that landed, which is all this run kept: it predates the step log, so why the agent chose each one was only ever visible live."
            }
          >
            {(t.operated ?? []).length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-muted">Nothing was operated.</p>
            ) : (
              <ol className="divide-y divide-line">
                {(t.operated ?? []).map((m, i) => (
                  <li key={`${m}-${i}`} className="px-4 py-2 text-[12px] text-text">
                    <span className="mr-2 text-dim">{i + 1}</span>
                    {m}
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel
            title={`What went wrong (${(t.failures ?? []).length})`}
            note="Moves the page refused, which is where a site's real friction shows."
          >
            {(t.failures ?? []).length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-muted">
                Nothing the agent tried was refused.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {(t.failures ?? []).map((f, i) => (
                  <li key={`${f}-${i}`} className="px-4 py-2 text-[12px] leading-relaxed text-muted">
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {run.shots?.length ? (
          <Panel
            title={`What it saw (${run.shots.length})`}
            note={
              run.example
                ? "Screenshots from the run, committed with it so this page is whole on a fresh clone."
                : "Screenshots from the live run. These live on the machine that ran it and are not committed."
            }
          >
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              {run.shots.map((src) => (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  key={src}
                  src={src}
                  alt={`Step ${src.split("/").pop()?.replace(/\.\w+$/, "")} as the agent saw it`}
                  className="w-full border border-line"
                  loading="lazy"
                />
              ))}
            </div>
          </Panel>
        ) : null}

        {run.example ? (
          <p className="mt-6 text-[11px] leading-relaxed text-dim">
            This run ships with the repository so the page has something real to show on a fresh
            clone.{" "}
            {run.shots?.length
              ? "Its screenshots ship with it."
              : "Its screenshots do not: those stay on the machine that ran it."}{" "}
            The replay is fetched live from Solari and needs a key in this environment.
          </p>
        ) : null}

        <p className="mt-8 text-[12px]">
          <a href="/audit" className="text-muted underline hover:text-text">
            Run one of your own
          </a>
        </p>
      </div>
    </main>
  );
}
