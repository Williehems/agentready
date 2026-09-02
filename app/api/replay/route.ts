import { Solari } from "@solarisdk/browser";
import { closeClient, fetchReplayUrl } from "@/lib/solari";

/**
 * The recording behind a run, fetched on demand.
 *
 * This is a separate endpoint rather than part of the audit stream because a
 * replay is not ready when the run ends: measured on this plan, the upload 404s
 * for at least 103 seconds after release and lands some minutes later. Holding
 * the audit request open for that would delay the grade, and on any serverless
 * host it would simply time out. So the run hands back its session id and the
 * client asks here until the recording appears.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Solari session ids are long opaque strings of host:uuid:account:stamp.token. */
const SESSION_ID = /^[A-Za-z0-9._:-]{20,300}$/;

export async function GET(req: Request) {
  const session = new URL(req.url).searchParams.get("session") ?? "";
  if (!SESSION_ID.test(session)) {
    return Response.json({ error: "Pass ?session=<solari session id>." }, { status: 400 });
  }
  if (!process.env.SOLARI_API_KEY) {
    return Response.json({ error: "Server is missing SOLARI_API_KEY." }, { status: 503 });
  }

  const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY });
  try {
    const found = await fetchReplayUrl(solari, session);
    return Response.json(found, { headers: { "Cache-Control": "no-store" } });
  } finally {
    // Without this the loopback proxy the client keeps open holds the event loop.
    await closeClient(solari);
  }
}
