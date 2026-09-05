"use client";

import { useEffect, useRef, useState } from "react";
import { ACTION_LABELS, ACTION_ORDER } from "@/lib/action-labels";
import type { ActionKind } from "@/lib/types";

/**
 * The dock: the only control on the audit page, in two floating pieces.
 *
 * The pill takes a URL and nothing else. The round button next to it asks the
 * one question a URL cannot answer, which action the site exists for, and it
 * asks it late: the menu opens on click and picking an entry is what starts the
 * run. So there is no third click, and nothing to read before typing.
 *
 * While a run is in flight that same button is how it is called off, in the place
 * the hand is already resting rather than as a new thing appearing somewhere else.
 */

/** What the agent will actually attempt, in the visitor's words rather than the model's. */
const HINT: Record<ActionKind, string> = {
  signup: "reach the account form and fill in what it can",
  purchase: "reach checkout on the cheapest thing you sell",
  integrate: "find the docs, a copyable example, and a key",
  book: "pick a slot, fill the details, press send",
  contact: "find a human and get as far as composing",
};

export function AuditDock({
  url,
  onUrlChange,
  onRun,
  onStop,
  running,
  stopping,
  lastAction,
}: {
  url: string;
  onUrlChange: (next: string) => void;
  onRun: (action: ActionKind) => void;
  onStop: () => void;
  running: boolean;
  stopping: boolean;
  lastAction?: ActionKind;
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);

  const ready = url.trim().length > 0 && !running;

  // Closing has to answer to the page, not just to the button: a click anywhere
  // else and Escape both mean the same thing, and Escape puts focus back where
  // it came from so the keyboard is not left stranded in a closed panel.
  useEffect(() => {
    if (!open) return;

    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };

    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key);
    first.current?.focus();
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  // A run in flight closes the menu it was started from.
  useEffect(() => {
    if (running) setOpen(false);
  }, [running]);

  const choose = (action: ActionKind) => {
    setOpen(false);
    onRun(action);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 pb-6 pt-10 sm:pb-8">
      <div className="dock-veil" aria-hidden />

      <div className="pointer-events-auto relative mx-auto flex w-full max-w-shell items-end gap-3 px-4 sm:gap-4 sm:px-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Enter is a request to run, and the action is still unanswered, so
            // it opens the menu rather than guessing which one was meant.
            if (ready) setOpen(true);
          }}
          className="dock-pill flex min-w-0 flex-1 items-center"
        >
          <span className="hidden select-none pl-5 text-[13px] text-dim sm:block">https://</span>
          <input
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="your-site.com"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={running}
            aria-label="Site to audit"
            className="min-w-0 flex-1 bg-transparent px-5 py-4 text-[13px] text-text placeholder:text-dim focus:outline-none disabled:opacity-50 sm:pl-1.5"
          />
        </form>

        {open ? (
          <div
            ref={panel}
            role="menu"
            aria-label="What should the agent try to do?"
            className="menu-card animate-rise absolute bottom-full right-4 mb-3 w-[min(22rem,calc(100%-2rem))] sm:right-6"
          >
            <p className="px-4 pb-2 pt-3.5 text-[10px] uppercase tracking-[0.18em] text-dim">
              What is this audit for?
            </p>
            {ACTION_ORDER.map((id, i) => (
              <button
                key={id}
                ref={i === 0 ? first : undefined}
                type="button"
                role="menuitem"
                onClick={() => choose(id)}
                className="group flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised focus:bg-raised focus:outline-none"
              >
                <span
                  className={`mt-[5px] h-2 w-2 shrink-0 rounded-full border ${
                    lastAction === id ? "border-grade-a bg-grade-a" : "border-line-strong"
                  }`}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="block text-[13px] text-text">{ACTION_LABELS[id]}</span>
                  <span className="block text-[11px] leading-snug text-dim">{HINT[id]}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {/*
          One button, two jobs, because they are never both available: before a run
          it opens the question, during one it ends the run. Held in the same place
          so a stop needs no aiming, and the square is the only glyph anyone has to
          recognise. It stays pressable until the stop has been asked for, and the
          pulse afterwards is the browser being released, which takes a moment.
        */}
        <button
          ref={trigger}
          type="button"
          onClick={running ? onStop : () => setOpen((v) => !v)}
          disabled={running ? stopping : !ready}
          aria-haspopup={running ? undefined : "menu"}
          aria-expanded={running ? undefined : open}
          aria-label={running ? (stopping ? "Stopping the run" : "Stop the run") : undefined}
          className="dock-orb shrink-0"
        >
          {running ? (
            <span className="flex items-center gap-2">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-[3px] bg-ink ${
                  stopping ? "animate-pulse-dot" : ""
                }`}
                aria-hidden
              />
              <span className="hidden sm:inline">{stopping ? "stopping" : "stop"}</span>
            </span>
          ) : (
            "audit"
          )}
        </button>
      </div>
    </div>
  );
}
