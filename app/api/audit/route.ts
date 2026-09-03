import { z } from "zod";
import { runAudit } from "@/lib/agent";
import { ACTIONS } from "@/lib/actions";
import { beginRun, endRun } from "@/lib/runs";
import { newRunId, normaliseTarget } from "@/lib/url";
import type { RunEvent } from "@/lib/types";

// A run drives a real cloud browser for one to two minutes, so this has to be
// the Node runtime, and it must not be cached or statically evaluated.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BodySchema = z.object({
  url: z.string().min(1).max(2048),
  action: z.enum(["signup", "purchase", "integrate", "book", "contact"]),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Send { url, action }." }, { status: 400 });
  }

  const target = normaliseTarget(parsed.data.url);
  if (!target.ok || !target.url) {
    return Response.json({ error: target.reason ?? "Invalid URL." }, { status: 400 });
  }

  if (!process.env.SOLARI_API_KEY || !process.env.GROQ_API_KEY) {
    return Response.json(
      { error: "Server is missing SOLARI_API_KEY or GROQ_API_KEY. Copy .env.local.example to .env.local." },
      { status: 503 },
    );
  }

  const runId = newRunId();
  const encoder = new TextEncoder();

  // One handle, pulled three ways, because all three mean the same thing and the
  // cloud browser is billed until it is released: the stop button posts to
  // /api/audit/stop, a tab that goes away aborts the request, and a client that
  // stops reading cancels the stream.
  const runner = beginRun(runId);
  req.signal.addEventListener("abort", () => runner.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (e: RunEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          open = false;
        }
      };

      try {
        await runAudit({
          url: target.url!,
          action: parsed.data.action,
          runId,
          onEvent: send,
          signal: runner.signal,
        });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          at: Date.now(),
        });
      } finally {
        open = false;
        endRun(runId);
        try {
          controller.close();
        } catch {
          // Already closed because the client disconnected.
        }
      }
    },
    cancel() {
      // The reader went away mid-run. Whatever it was watching is still running and
      // still costing, so it ends here too.
      runner.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Run-Id": runId,
      "X-Task": ACTIONS[parsed.data.action].label,
    },
  });
}
