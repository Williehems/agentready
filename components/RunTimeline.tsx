"use client";

import { useState } from "react";
import type { RunEvent, StepAction } from "@/lib/types";

type StepEvent = Extract<RunEvent, { type: "step" }>;
type StatusEvent = Extract<RunEvent, { type: "status" }>;

/** Typed by StepAction so adding an action the timeline cannot say is a build error. */
const VERB: Record<StepAction, string> = {
  click: "clicked",
  type: "typed into",
  select: "chose",
  scroll: "scrolled",
  back: "went back",
  done: "declared done",
  give_up: "gave up",
};

function StepRow({ step }: { step: StepEvent }) {
  const [open, setOpen] = useState(false);
  const terminal = step.action === "done" || step.action === "give_up";

  return (
    <li className="animate-fade-up border-b border-line last:border-b-0">
      <div className="flex gap-4 px-4 py-3">
        <div className="w-6 shrink-0 pt-0.5 text-right text-[11px] text-dim">{step.index}</div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
            <span
              className={
                terminal
                  ? step.action === "done"
                    ? "font-bold text-grade-a"
                    : "font-bold text-grade-f"
                  : step.ok
                    ? "text-text"
                    : "text-grade-d"
              }
            >
              {VERB[step.action] ?? step.action}
            </span>
            {step.target ? <span className="text-muted">&quot;{step.target}&quot;</span> : null}
            {step.value ? <span className="text-dim">= {step.value}</span> : null}
            {!step.ok ? <span className="text-[11px] text-grade-d">failed</span> : null}
          </div>

          <p className="mt-1 text-[12px] leading-relaxed text-muted">{step.reasoning}</p>
          {step.error ? (
            <p className="mt-1 text-[11px] text-grade-d">{step.error}</p>
          ) : null}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[11px] text-dim">
            <span className="truncate">{step.url}</span>
            <span>{step.elementCount} actionable</span>
            {step.screenshot ? (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="underline decoration-line-strong underline-offset-2 hover:text-muted"
              >
                {open ? "hide view" : "what it saw"}
              </button>
            ) : null}
          </div>

          {open && step.screenshot ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={step.screenshot}
              alt={`What the agent saw at step ${step.index}`}
              className="mt-3 w-full border border-line"
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function RunTimeline({
  steps,
  status,
  running,
}: {
  steps: StepEvent[];
  status?: StatusEvent;
  running: boolean;
}) {
  if (!steps.length && !status) return null;

  return (
    <section className="border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-[11px] uppercase tracking-widest text-dim">What the agent did</h2>
        {running ? (
          <span className="flex items-center gap-2 text-[11px] text-muted">
            <span className="inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-grade-c" />
            running
          </span>
        ) : null}
      </header>

      <ul>
        {steps.map((s) => (
          <StepRow key={s.index} step={s} />
        ))}
      </ul>

      {running && status ? (
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-muted">{status.message}</p>
      ) : null}
    </section>
  );
}
