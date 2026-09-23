"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTION_LABELS } from "@/lib/action-labels";
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
  const [stopping, setStopping] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [auditedUrl, setAuditedUrl] = useState("");

  /**
   * What a stop needs: the run's name, and a way to hang up on it.
   *
   * The name comes back in a header on the very first byte, before any event, so
   * the button works during the two seconds spent acquiring a browser. The
   * controller is the fallback, for when the server has no run by that name and
   * this page would otherwise wait for a stream nobody is writing to.
   */
  const runIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Leaving this page ends the run, because leaving is the same as closing the tab.
   *
   * The server documents three ways a run is released: the stop button, a tab that
   * goes away, and a client that stops reading. Client-side navigation was none of
   * them. The header links to / and /runs are on this page, so a visitor could click
   * through mid-audit and the loop below would keep reading a stream nobody was
   * watching, holding a billed cloud browser open for the rest of its ten steps with
   * no way to stop it but a page refresh. Aborting fires the request's own signal,
   * which is the second of the three the route already handles.
   */
  useEffect(() => () => abortRef.current?.abort(), []);

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
      setStopping(false);
      setEvents([]);
      setError(null);
      setAuditedUrl("");

      const controller = new AbortController();
      abortRef.current = controller;
      runIdRef.current = null;

      try {
        const res = await fetch("/api/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, action: chosen }),
          signal: controller.signal,
        });

        runIdRef.current = res.headers.get("X-Run-Id");

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
        // The only abort this page ever issues is its own stop, and a stream that
        // ends because it was asked to is not a failure to report.
        if (!(err instanceof Error && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        abortRef.current = null;
        runIdRef.current = null;
        setStopping(false);
        setRunning(false);
      }
    },
    [url, running],
  );

  /**
   * Stop the run, for real: the browser is billed by the session and the model by
   * the token, so this has to reach the server rather than merely stop watching.
   * A stopped run still finishes properly, releasing its browser and grading what
   * the agent managed to reach, which is why the stream is left open afterwards.
   */
  const stop = useCallback(async () => {
    if (!running || stopping) return;
    setStopping(true);

    const runId = runIdRef.current;
    let reached = false;
    if (runId) {
      try {
        const res = await fetch("/api/audit/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId }),
        });
        const body = (await res.json().catch(() => ({}))) as { stopped?: boolean };
        reached = res.ok && body.stopped === true;
      } catch {
        reached = false;
      }
    }

    // Nothing on the server answers to that name, so there is no verdict coming.
    // Hanging up here is what keeps the page from waiting on a run that is already
    // gone, and closing the stream is itself a second signal to release anything
    // still held.
    if (!reached) abortRef.current?.abort();
  }, [running, stopping]);

  const opened = Boolean(action) && (running || steps.length > 0 || Boolean(verdict) || Boolean(error));

  return (
    <>
      <div className="mx-auto w-full max-w-shell px-4 pb-40 sm:px-6">
        <ChatStream
          host={opened ? hostLabel(auditedUrl || url) : undefined}
          actionLabel={action ? ACTION_LABELS[action] : undefined}
          steps={steps}
          status={status}
          running={running}
          stopping={stopping}
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
        onStop={() => void stop()}
        running={running}
        stopping={stopping}
        lastAction={action}
      />
    </>
  );
}
