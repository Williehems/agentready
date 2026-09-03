import { z } from "zod";
import { stopRun } from "@/lib/runs";

// Same runtime as the run it stops: the two have to share module state to find
// each other, and a cached answer to a stop would be a stop that never happened.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ runId: z.string().min(1).max(64) });

/**
 * Stop a run that is still going.
 *
 * A separate request, because the run holds its own response open for as long as
 * it lasts: the stop cannot travel down the stream it is stopping. The reply says
 * whether anything was actually reached, so a page whose stop lands a moment too
 * late knows to stop waiting rather than assume the browser is still being
 * released.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Send { runId }." }, { status: 400 });
  }

  const stopped = stopRun(parsed.data.runId);
  // Not an error: the ordinary way to miss is to press stop just as the run ends.
  return Response.json({ stopped }, { status: 200 });
}
