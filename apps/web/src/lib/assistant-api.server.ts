import "server-only";

/**
 * Server-side client for the building assistant (`POST /sessions`,
 * `POST /assistant/query` on the same FastAPI service `worlds-api.server.ts`
 * talks to). Mirrors that file's shape (env vars, `apiHeaders`, `apiError`)
 * rather than importing it: the assistant has no meaningful local-file
 * fallback the way world manifests do, so this module is simpler on purpose.
 */

const API_URL = process.env.WANDER_API_URL?.replace(/\/+$/, "");
const API_KEY = process.env.WANDER_API_KEY;

/** Error with an HTTP status the route handler can pass through. */
export class AssistantApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function apiHeaders(): HeadersInit {
  return { ...(API_KEY ? { "X-API-Key": API_KEY } : {}), "content-type": "application/json" };
}

function requireApiUrl(): string {
  if (!API_URL) throw new AssistantApiError(501, "WANDER_API_URL is not configured; the assistant needs a live backend");
  return API_URL;
}

export type AssistantSession = {
  sessionId: string;
  worldId: string;
  deviceId: string;
  state: string;
};

export type AssistantSource = { type: string; id: string };
export type AssistantAction = { type: string; [key: string]: unknown };

export type AssistantResponse = {
  text: string;
  sources: AssistantSource[];
  actions: AssistantAction[];
};

/** `POST /sessions {worldId, deviceId}` — creates (or the backend's own dedup) a session. */
export async function createSession(worldId: string, deviceId: string): Promise<AssistantSession> {
  const res = await fetch(`${requireApiUrl()}/sessions`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ worldId, deviceId }),
    cache: "no-store",
  });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as AssistantSession;
}

/** `POST /assistant/query {session_id, text, ui_context?}` — one turn of the building assistant.
 * `uiContext` is a plain-text hint of what the caller currently has on screen (e.g. a
 * selected note or waypoint); the backend never treats it as live sensor/navigation truth. */
export async function queryAssistant(sessionId: string, text: string, uiContext?: string): Promise<AssistantResponse> {
  const res = await fetch(`${requireApiUrl()}/assistant/query`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ session_id: sessionId, text, ...(uiContext ? { ui_context: uiContext } : {}) }),
    cache: "no-store",
  });
  if (!res.ok) throw await apiError(res);
  const body = (await res.json()) as Partial<AssistantResponse>;
  return { text: body.text ?? "", sources: body.sources ?? [], actions: body.actions ?? [] };
}

/** `POST /assistant/query/stream {session_id, text, ui_context?}` — server-sent events version
 * of queryAssistant. Returns the raw upstream Response so the route handler can pipe its body
 * straight through to the browser without buffering the whole answer first. */
export async function queryAssistantStream(sessionId: string, text: string, uiContext?: string): Promise<Response> {
  const res = await fetch(`${requireApiUrl()}/assistant/query/stream`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ session_id: sessionId, text, ...(uiContext ? { ui_context: uiContext } : {}) }),
    cache: "no-store",
  });
  if (!res.ok) throw await apiError(res);
  return res;
}

/** Turn a failed backend response into an error the UI can show, keeping FastAPI's `detail` text. */
async function apiError(res: Response): Promise<AssistantApiError> {
  const { status } = res;
  if (status === 401 || status === 403)
    return new AssistantApiError(502, "Assistant API rejected the API key — check WANDER_API_KEY matches the backend");
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const detail =
    typeof body?.detail === "string"
      ? body.detail
      : Array.isArray(body?.detail)
        ? (body.detail as { msg?: string }[]).map((d) => d.msg ?? JSON.stringify(d)).join("; ")
        : null;
  return new AssistantApiError(status >= 500 ? 502 : status, detail ? `Assistant API: ${detail}` : `Assistant API responded ${status}`);
}
