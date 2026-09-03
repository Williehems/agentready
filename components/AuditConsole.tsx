"use client";

import { useCallback, useMemo, useState } from "react";
import { ACTIONS } from "@/lib/actions";
import type { ActionKind, RunEvent, Verdict } from "@/lib/types";
import { AuditDock } from "./AuditDock";
import { ChatStream } from "./ChatStream";
import { GradeCard } from "./GradeCard";

type StepEvent = Extract<RunEvent, { type: "step" }>;
type StatusEvent = Extract<RunEvent, { type: "status" }>;

/** The host on its own, since that is what the visitor recognises as their site. */
function hostLabel(url: string): string {
  const raw = url.trim();
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return raw;
  }
}

export function AuditConsole() {
  const [url, setUrl] = useState("");
  const [action, setAction] = useState<ActionKind | undefined>();
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

  const run = useCallback(
    async (chosen: ActionKind) => {
      if (!url.trim() || running) return;
      setAction(chosen);
      setRunning(true);
      setEvents([]);
      setError(null);
      setAuditedUrl("");

      try {
        const res = await fetch("/api/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, action: chosen }),
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
    },
    [url, running],
  );

  const opened = Boolean(action) && (running || steps.length > 0 || Boolean(verdict) || Boolean(error));

  return (
    <>
      <div className="mx-auto w-full max-w-shell px-4 pb-40 sm:px-6">
        <ChatStream
          host={opened ? hostLabel(auditedUrl || url) : undefined}
          actionLabel={action ? ACTIONS[action].label : undefined}
          steps={steps}
          status={status}
          running={running}
          error={error}
          verdict={
            verdict ? <GradeCard verdict={verdict} url={auditedUrl || url} /> : undefined
          }
        />
      </div>

      <AuditDock
        url={url}
        onUrlChange={setUrl}
        onRun={(chosen) => void run(chosen)}
        running={running}
        lastAction={action}
      />
    </>
  );
}
