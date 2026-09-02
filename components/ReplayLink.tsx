"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The replay half of the product, which arrives late.
 *
 * A Solari recording is uploaded minutes after the session is released, so the
 * grade cannot wait for it. This asks for the recording in the background and
 * fills the link in when it lands, and says plainly what is happening in the
 * meantime rather than showing nothing and looking broken.
 */

const FIRST_DELAY = 15_000;
const EVERY = 15_000;
const ATTEMPTS = 24;

interface Lookup {
  url?: string;
  pending?: boolean;
  reason?: string;
  error?: string;
}

const LINK =
  "text-[12px] text-muted underline decoration-line-strong underline-offset-4 hover:text-text";

export function ReplayLink({ sessionId, url }: { sessionId?: string; url?: string }) {
  const [found, setFound] = useState<string | undefined>(url);
  const [reason, setReason] = useState<string | undefined>();
  const [dead, setDead] = useState(false);
  const [checking, setChecking] = useState(false);
  const tries = useRef(0);

  const check = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return true;
    setChecking(true);
    try {
      const res = await fetch(`/api/replay?session=${encodeURIComponent(sessionId)}`);
      const body = (await res.json()) as Lookup;
      if (body.url) {
        setFound(body.url);
        return true;
      }
      setReason(body.reason ?? body.error ?? "no recording yet");
      // Anything that is not "still uploading" will not fix itself.
      if (!body.pending) {
        setDead(true);
        return true;
      }
      return false;
    } catch (err) {
      setReason(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setChecking(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || found) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (!live) return;
      tries.current += 1;
      const settled = await check();
      if (!live || settled) return;
      if (tries.current >= ATTEMPTS) {
        setDead(true);
        return;
      }
      timer = setTimeout(() => void tick(), EVERY);
    };

    timer = setTimeout(() => void tick(), FIRST_DELAY);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sessionId, found, check]);

  if (!sessionId && !found) return null;

  if (found) {
    return (
      <a href={found} target="_blank" rel="noreferrer noopener" className={LINK}>
        Download the session replay (rrweb NDJSON)
      </a>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-[12px] text-dim">
        {dead
          ? `No replay yet: ${reason ?? "unknown reason"}.`
          : `Recording is uploading: ${reason ?? "waiting on Solari"}.`}
      </span>
      <button
        type="button"
        onClick={() => void check()}
        disabled={checking}
        className={`${LINK} disabled:opacity-40`}
      >
        {checking ? "checking" : "check now"}
      </button>
    </div>
  );
}
