import { AssistantApiError, createSession, queryAssistant, queryAssistantStream } from "@/lib/assistant-api.server";

/**
 * Same-origin proxy for the building assistant.
 *
 *   POST /api/assistant/sessions      { worldId, deviceId }            -> AssistantSession
 *   POST /api/assistant/query         { sessionId, text, uiContext? }  -> AssistantResponse
 *   POST /api/assistant/query/stream  { sessionId, text, uiContext? }  -> text/event-stream
 *
 * The browser only ever talks to this route; `WANDER_API_URL` and the API key
 * stay on the server, exactly like /api/worlds.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: Request, ctx: RouteContext<"/api/assistant/[[...path]]">) {
  const { path = [] } = await ctx.params;
  const body = await readJson(req);
  if (!isObject(body)) return Response.json({ error: "Body must be a JSON object" }, { status: 400 });

  try {
    if (path.length === 1 && path[0] === "sessions") {
      if (typeof body.worldId !== "string" || typeof body.deviceId !== "string")
        return Response.json({ error: "Body needs worldId and deviceId" }, { status: 400 });
      const session = await createSession(body.worldId, body.deviceId);
      return Response.json(session, { status: 201, headers: NO_STORE });
    }

    if (path.length === 1 && path[0] === "query") {
      if (typeof body.sessionId !== "string" || typeof body.text !== "string")
        return Response.json({ error: "Body needs sessionId and text" }, { status: 400 });
      const uiContext = typeof body.uiContext === "string" ? body.uiContext : undefined;
      const answer = await queryAssistant(body.sessionId, body.text, uiContext);
      return Response.json(answer, { headers: NO_STORE });
    }

    if (path.length === 2 && path[0] === "query" && path[1] === "stream") {
      if (typeof body.sessionId !== "string" || typeof body.text !== "string")
        return Response.json({ error: "Body needs sessionId and text" }, { status: 400 });
      const uiContext = typeof body.uiContext === "string" ? body.uiContext : undefined;
      const upstream = await queryAssistantStream(body.sessionId, body.text, uiContext);
      // Pipe the backend's SSE body straight through; nothing here buffers it.
      return new Response(upstream.body, {
        headers: { "content-type": "text/event-stream", ...NO_STORE },
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    return failure(err);
  }
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function failure(err: unknown): Response {
  if (err instanceof AssistantApiError) return Response.json({ error: err.message }, { status: err.status });
  console.error("[api/assistant]", err);
  return Response.json({ error: "Assistant backend unavailable" }, { status: 502 });
}
