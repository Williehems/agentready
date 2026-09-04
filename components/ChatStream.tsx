"use client";

import { useEffect, useRef, useState } from "react";
import type { RunEvent, StepAction } from "@/lib/types";

/**
 * The run as a conversation.
 *
 * Every line here is something that was observed, not something inferred after
 * the fact: the verb the agent chose, the element it aimed at, the sentence it
 * gave for why, and the frame it was looking at. The screenshot stays folded
 * because it is the evidence for a claim, and the claim is what gets read first.
 */

type StepEvent = Extract<RunEvent, { type: "step" }>;
type StatusEvent = Extract<RunEvent, { type: "status" }>;

/** Typed by StepAction so adding an action the stream cannot say is a build error. */
const VERB: Record<StepAction, string> = {
  click: "clicked",
  type: "typed into",
  select: "chose",
  scroll: "scrolled",
  back: "went back",
  escape: "pressed Escape",
  done: "declared done",
  give_up: "gave up",
};

function StepBubble({ step }: { step: StepEvent }) {
  const [open, setOpen] = useState(false);
  const terminal = step.action === "done" || step.action === "give_up";

  const headline = terminal
    ? step.action === "done"
      ? "font-bold text-grade-a"
      : "font-bold text-grade-f"
    : step.ok
      ? "text-text"
      : "text-grade-d";

  return (
    <li className="animate-fade-up flex justify-start">
      <div className="bubble-agent min-w-0 max-w-[min(38rem,100%)]">
        <div className="flex items-baseline gap-2 text-[10px] text-dim">
          <span className="tabular-nums">step {step.index}</span>
          {!step.ok ? <span className="text-grade-d">failed</span> : null}
        </div>

        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[13px]">
          <span className={headline}>{VERB[step.action] ?? step.action}</span>
          {step.target ? <span className="text-muted">&quot;{step.target}&quot;</span> : null}
          {step.value ? <span className="text-dim">= {step.value}</span> : null}
        </div>

        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{step.reasoning}</p>
        {step.error ? <p className="mt-1.5 text-[11px] text-grade-d">{step.error}</p> : null}

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
          <span className="max-w-full truncate">{step.url}</span>
          <span className="tabular-nums">{step.elementCount} actionable</span>
          {step.screenshot ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
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
            className="mt-3 w-full rounded-xl border border-line"
          />
        ) : null}
      </div>
    </li>
  );
}

export function ChatStream({
  host,
  actionLabel,
  steps,
  status,
  running,
  stopping,
  error,
  verdict,
}: {
  host?: string;
  actionLabel?: string;
  steps: StepEvent[];
  status?: StatusEvent;
  running: boolean;
  stopping?: boolean;
  error?: string | null;
  verdict?: React.ReactNode;
}) {
  const end = useRef<HTMLDivElement | null>(null);

  // Follow the run, and only the run: the browser's own smooth scroll is opt-out
  // for anyone who asked the system for less motion.
  useEffect(() => {
    if (!end.current) return;
    const still =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    end.current.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "end" });
  }, [steps.length, status?.message, stopping, error, verdict]);

  const started = Boolean(host);

  if (!started && !error) {
    return (
      <div className="flex min-h-[60vh] flex-col justify-center py-16">
        <p className="text-[13px] leading-relaxed text-muted">
          Paste a site below and say what it is for. A stealth browser will attempt that one
          action for real, ten steps at most, and report back here as it goes.
        </p>
        <p className="mt-3 text-[12px] leading-relaxed text-dim">
          No payment details are ever entered. Nothing is stored anywhere but this machine.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-4 py-8">
      {host ? (
        <li className="animate-fade-up flex justify-end">
          <div className="bubble-you">
            <div className="text-[13px] text-text">{host}</div>
            {actionLabel ? (
              <div className="mt-0.5 text-[11px] text-dim">{actionLabel}</div>
            ) : null}
          </div>
        </li>
      ) : null}

      {steps.map((s) => (
        <StepBubble key={s.index} step={s} />
      ))}

      {running && status ? (
        <li className="flex justify-start">
          <div className="flex items-center gap-2.5 pl-1 text-[12px] text-muted">
            <span className="inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-grade-c" />
            {status.message}
          </div>
        </li>
      ) : null}

      {/*
        Said as soon as the button is pressed, and left alongside whatever the run
        is saying rather than in place of it. A stop can land mid-click, and the
        wait between asking and the browser letting go is the one moment a person
        would otherwise think nothing had happened.
      */}
      {running && stopping ? (
        <li className="animate-fade-up flex justify-start">
          <div className="pl-1 text-[12px] leading-relaxed text-dim">
            Stopping. The run finishes the step it is on, releases the browser, and grades what
            the agent reached.
          </div>
        </li>
      ) : null}

      {error ? (
        <li className="animate-fade-up flex justify-start">
          <div className="bubble-agent max-w-[min(38rem,100%)] border-grade-f/40 bg-grade-f/5 text-[13px] text-grade-f">
            {error}
          </div>
        </li>
      ) : null}

      {verdict ? <li className="animate-fade-up pt-2">{verdict}</li> : null}

      <li aria-hidden>
        <div ref={end} />
      </li>
    </ul>
  );
}
