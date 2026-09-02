"use client";

import { useCallback, useMemo, useState } from "react";
import { ACTION_LIST } from "@/lib/actions";
import type { ActionKind, RunEvent, Verdict } from "@/lib/types";
import { GradeCard } from "./GradeCard";
import { RunTimeline } from "./RunTimeline";

type StepEvent = Extract<RunEvent, { type: "step" }>;
type StatusEvent = Extract<RunEvent, { type: "status" }>;

export function AuditConsole() {
  const [url, setUrl] = useState("");
  const [action, setAction] = useState<ActionKind>("signup");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [auditedUrl, setAuditedUrl] = useState("");

  const steps = useMemo(
    () => events.filter((e): e is StepEvent => e.type === "step"),
    [events],
  );
  const status = useMemo(() => {
    const all = events.filter((e): e is StatusEvent => e.type === "status");
    return all[all.length - 1];
  }, [events]);
  const verdict: Verdict | undefined = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "verdict") return e.verdict;
    }
    return undefined;
  }, [events]);

  const run = useCallback(async () => {
    if (!url.trim() || running) return;
    setRunning(true);
    setEvents([]);
    setError(null);
    setAuditedUrl("");

    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, action }),
      });

      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `The run could not start (HTTP ${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as RunEvent;
            setEvents((prev) => [...prev, event]);
            if (event.type === "start") setAuditedUrl(event.url);
            if (event.type === "error") setError(event.message);
          } catch {
            // A truncated line is not worth failing the whole run over.
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [url, action, running]);

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        className="space-y-3"
      >
        <div className="flex border border-line-strong bg-ink/70 backdrop-blur-sm focus-within:border-text">
          <span className="hidden select-none items-center pl-4 text-sm text-dim sm:flex">
            https://
          </span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="your-site.com"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Site to audit"
            className="min-w-0 flex-1 bg-transparent px-4 py-4 text-sm text-text placeholder:text-dim focus:outline-none sm:pl-1"
          />
          <button
            type="submit"
            disabled={running || !url.trim()}
            className="shrink-0 bg-text px-6 text-[12px] font-bold uppercase tracking-widest text-ink transition-opacity disabled:opacity-30"
          >
            {running ? "running" : "audit"}
          </button>
        </div>

        <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
          <legend className="sr-only">What should the agent try to do?</legend>
          {ACTION_LIST.map((a) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2 text-[12px]">
              <input
                type="radio"
                name="action"
                value={a.id}
                checked={action === a.id}
                onChange={() => setAction(a.id)}
                className="sr-only"
              />
              <span
                className={`inline-block h-2.5 w-2.5 border ${
                  action === a.id ? "border-text bg-text" : "border-line-strong"
                }`}
                aria-hidden
              />
              <span className={action === a.id ? "text-text" : "text-dim"}>{a.label}</span>
            </label>
          ))}
        </fieldset>
      </form>

      {error ? (
        <p className="border border-grade-f/40 bg-grade-f/5 px-4 py-3 text-[13px] text-grade-f">
          {error}
        </p>
      ) : null}

      <RunTimeline steps={steps} status={status} running={running} />
      {verdict ? <GradeCard verdict={verdict} url={auditedUrl || url} /> : null}
    </div>
  );
}
