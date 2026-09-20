import { parseGraph, parseMeasurements, parseNotes } from "@/lib/world-manifest";
import {
  autoDetectNotes,
  buildNavmesh,
  createWorld,
  deleteWorld,
  getLocalizations,
  getNavmesh,
  getMeasurements,
  getNotes,
  getWorld,
  isSafeSegment,
  listWorlds,
  openAsset,
  patchWorld,
  postLocalizationQuery,
  saveGraph,
  saveMeasurements,
  saveNotes,
  uploadAsset,
  uploadTarget,
  validateGraphAgainstMesh,
  WorldsApiError,
  type CreateWorldInput,
  type WorldPatch,
} from "@/lib/worlds-api.server";

/**
 * Same-origin proxy for the worlds stored on the Modal Volume.
 *
 *   GET   /api/worlds                         → { worlds: WorldManifest[] }
 *   POST  /api/worlds                         → WorldManifest (create draft; body: { id, name, space?, nianticSiteId?, splatFilename? })
 *   GET   /api/worlds/:id                     → WorldManifest
 *   PATCH /api/worlds/:id                     → WorldManifest (partial update, e.g. switch version)
 *   DELETE /api/worlds/:id                    → 204 (removes the world and every version; irreversible)
 *   GET   /api/worlds/:id/notes               → { notes }
 *   GET   /api/worlds/:id/measurements        → { measurements }
 *   GET   /api/worlds/:id/localizations?limit → { schema, worldId, queries: LocalizationQuery[] } (newest first; polled by the viewer)
 *   POST  /api/worlds/:id/localize/query      → LocalizationQuery (phone upload of one VPS image query; stored locally without a backend)
 *   GET   /api/worlds/:id/navmesh             → NavmeshProposal (last mesh-derived graph proposal) or 404
 *   POST  /api/worlds/:id/navmesh             → NavmeshProposal (grid `assets.mesh`, propose a graph; body: { params?, frame? }; backend only)
 *   POST  /api/worlds/:id/graph/validate      → GraphValidation (edges through walls, floor snapping; body: { graph?, snap? }; backend only)
 *   POST  /api/worlds/:id/notes/auto-detect   → NotesFile & { added, skippedDuplicates, unplaced } (vision-detect scene objects into note pins; body: { limit?, floor? }; backend only)
 *   PUT   /api/worlds/:id/graph               → WorldManifest (body: NavigationGraph)
 *   PUT   /api/worlds/:id/notes               → NotesFile (body: { notes })
 *   PUT   /api/worlds/:id/measurements        → MeasurementsFile (body: { measurements })
 *   GET   /api/worlds/:id/:version/:file      → streamed asset bytes (e.g. scene.spz, localizations/<queryId>.jpg)
 *   PUT   /api/worlds/:id/:version/:file      → { path, bytes } (streamed upload; 409 if the file exists)
 *   POST  /api/worlds/:id/:version/:file/ticket → { mode } & where to PUT the bytes (see uploadTarget)
 *
 * The browser only ever talks to this route; `WANDER_API_URL` and the API key
 * stay on the server. Without an API URL the files live in maps/assets.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const RESOURCES = new Set(["notes", "measurements", "graph"]);

export async function GET(req: Request, ctx: RouteContext<"/api/worlds/[[...path]]">) {
  const { path = [] } = await ctx.params;
  if (path.some((s) => !isSafeSegment(s))) return Response.json({ error: "Invalid path" }, { status: 400 });

  try {
    if (path.length === 0) return Response.json({ worlds: await listWorlds() }, { headers: NO_STORE });
    if (path.length === 1) {
      const world = await getWorld(path[0]);
      return world
        ? Response.json(world, { headers: NO_STORE })
        : Response.json({ error: "World not found" }, { status: 404 });
    }
    if (path.length === 2 && path[1] === "notes") {
      return Response.json({ notes: await getNotes(path[0]) }, { headers: NO_STORE });
    }
    if (path.length === 2 && path[1] === "measurements") {
      return Response.json({ measurements: await getMeasurements(path[0]) }, { headers: NO_STORE });
    }
    if (path.length === 2 && path[1] === "navmesh") {
      const proposal = await getNavmesh(path[0]);
      return proposal
        ? Response.json(proposal, { headers: NO_STORE })
        : Response.json({ error: "No graph has been generated from the mesh yet" }, { status: 404 });
    }
    if (path.length === 2 && path[1] === "localizations") {
      const limit = Number(new URL(req.url).searchParams.get("limit") ?? 20) || 20;
      const queries = await getLocalizations(path[0], limit);
      return Response.json({ schema: "wander.localizations/v1", worldId: path[0], queries }, { headers: NO_STORE });
    }
    const asset = await openAsset(path);
    return asset ?? Response.json({ error: "Asset not found" }, { status: 404 });
  } catch (err) {
    return failure(err);
  }
}

/**
 * `POST /api/worlds` creates a world manifest (draft; the splat is uploaded separately with PUT).
 * `POST /api/worlds/:id/localize/query` stores one VPS image query from the phone.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/worlds/[[...path]]">) {
  const { path = [] } = await ctx.params;
  if (path.some((s) => !isSafeSegment(s))) return Response.json({ error: "Invalid path" }, { status: 400 });

  // Where should the browser send this file's bytes? Big uploads cannot go through a
  // Vercel function (4.5 MB body cap), so this hands back a direct, path-scoped ticket.
  if (path.length === 4 && path[3] === "ticket") {
    try {
      return Response.json(await uploadTarget(path.slice(0, 3)), { headers: NO_STORE });
    } catch (err) {
      return failure(err);
    }
  }

  if (path.length === 3 && path[1] === "localize" && path[2] === "query") {
    const body = await readJson(req);
    if (!isObject(body)) return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
    try {
      const record = await postLocalizationQuery(path[0], body);
      return record
        ? Response.json(record, { status: 201, headers: NO_STORE })
        : Response.json({ error: "World not found" }, { status: 404 });
    } catch (err) {
      return failure(err);
    }
  }

  if (path.length === 3 && path[1] === "notes" && path[2] === "auto-detect") {
    const body = (await readJson(req)) ?? {};
    if (!isObject(body)) return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
    try {
      const result = await autoDetectNotes(path[0], body as { limit?: number; floor?: number });
      return result
        ? Response.json(result, { status: 201, headers: NO_STORE })
        : Response.json({ error: "World not found" }, { status: 404 });
    } catch (err) {
      return failure(err);
    }
  }

  if ((path.length === 2 && path[1] === "navmesh") || (path.length === 3 && path[1] === "graph" && path[2] === "validate")) {
    const body = (await readJson(req)) ?? {};
    if (!isObject(body)) return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
    try {
      const result = path[1] === "navmesh" ? await buildNavmesh(path[0], body) : await validateGraphAgainstMesh(path[0], body);
      return result
        ? Response.json(result, { status: path[1] === "navmesh" ? 201 : 200, headers: NO_STORE })
        : Response.json({ error: "World not found" }, { status: 404 });
    } catch (err) {
      return failure(err);
    }
  }

  if (path.length !== 0) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await readJson(req);
  if (!isObject(body) || typeof body.id !== "string" || typeof body.name !== "string")
    return Response.json({ error: "Body needs id and name" }, { status: 400 });
  try {
    const manifest = await createWorld(body as CreateWorldInput);
    return Response.json(manifest, { status: 201, headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/worlds/[[...path]]">) {
  const { path = [] } = await ctx.params;
  if (path.length !== 1 || !isSafeSegment(path[0])) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await readJson(req);
  if (!isObject(body)) return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  try {
    const manifest = await patchWorld(path[0], body as WorldPatch);
    return manifest
      ? Response.json(manifest, { headers: NO_STORE })
      : Response.json({ error: "World not found" }, { status: 404 });
  } catch (err) {
    return failure(err);
  }
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/worlds/[[...path]]">) {
  const { path = [] } = await ctx.params;
  if (path.length !== 1 || !isSafeSegment(path[0])) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    return (await deleteWorld(path[0]))
      ? new Response(null, { status: 204, headers: NO_STORE })
      : Response.json({ error: "World not found" }, { status: 404 });
  } catch (err) {
    return failure(err);
  }
}

export async function PUT(req: Request, ctx: RouteContext<"/api/worlds/[[...path]]">) {
  const { path = [] } = await ctx.params;
  if (path.some((s) => !isSafeSegment(s))) return Response.json({ error: "Invalid path" }, { status: 400 });

  try {
    // Asset upload: stream the body straight through, never into memory.
    if (path.length === 3) {
      if (!req.body) return Response.json({ error: "Missing file body" }, { status: 400 });
      const length = req.headers.get("content-length");
      const stored = await uploadAsset(path, req.body, length ? Number(length) : null);
      return Response.json(stored, { status: 201, headers: NO_STORE });
    }

    if (path.length !== 2 || !RESOURCES.has(path[1])) return Response.json({ error: "Not found" }, { status: 404 });
    const [id, resource] = path;
    const body = await readJson(req);
    if (body === undefined) return Response.json({ error: "Body must be JSON" }, { status: 400 });
    const field = (key: string) => (isObject(body) ? (body[key] ?? body) : body);

    let saved: unknown;
    if (resource === "graph") saved = await saveGraph(id, parseGraph(body), req.headers.get("if-match"));
    else if (resource === "notes") saved = await saveNotes(id, parseNotes(field("notes")));
    else saved = await saveMeasurements(id, parseMeasurements(field("measurements")));
    return saved
      ? Response.json(saved, { headers: NO_STORE })
      : Response.json({ error: "World not found" }, { status: 404 });
  } catch (err) {
    return failure(err);
  }
}

/* ------------------------------------------------------------------ utils */

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
  if (err instanceof WorldsApiError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof Error && /^Invalid /.test(err.message)) return Response.json({ error: err.message }, { status: 400 });
  console.error("[api/worlds]", err);
  return Response.json({ error: "Worlds backend unavailable" }, { status: 502 });
}
