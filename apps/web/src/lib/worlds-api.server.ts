import "server-only";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  LOCALIZATION_QUERY_SCHEMA,
  LOCALIZATIONS_KEPT,
  LOCALIZATIONS_SCHEMA,
  parseQueries,
  validateQueryUpload,
  type LocalizationQueries,
  type LocalizationQuery,
  type LocalizationQueryUpload,
} from "./localization";
import {
  IDENTITY_ALIGNMENT,
  MEASUREMENTS_SCHEMA,
  NOTES_SCHEMA,
  parseManifest,
  parseMeasurements,
  parseNotes,
  volumePath,
  WORLD_SCHEMA,
  type Measurement,
  type MeasurementsFile,
  type NavigationGraph,
  type NotesFile,
  type WorldManifest,
  type WorldNote,
} from "./world-manifest";
import type { GraphValidation, NavmeshProposal } from "./navmesh";

/** Error with an HTTP status the route handler can pass through (404, 409, 413, 502…). */
export class WorldsApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Splat formats the viewer can open; other uploads (mesh, thumbnail, vps map) are listed separately. */
export const SPLAT_EXTENSIONS = new Set([".spz", ".ply", ".splat", ".ksplat", ".sog"]);
const UPLOAD_EXTENSIONS = new Set([...SPLAT_EXTENSIONS, ".glb", ".png", ".jpg", ".jpeg", ".webp", ".bin"]);
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
/** Filenames the backend registers under `assets` when uploaded into the current version. */
export const MESH_FILENAME = "mesh.glb";
const CONVENTIONAL_ASSETS: Record<string, "mesh" | "vpsMap" | "thumbnail" | undefined> = {
  [MESH_FILENAME]: "mesh",
  "vps-map.bin": "vpsMap",
  "thumbnail.png": "thumbnail",
};

/**
 * Data access for worlds stored on the Modal Volume.
 *
 * - With `WANDER_API_URL` set, every call goes to the FastAPI service that
 *   fronts the volume (see shared/contracts/README.md for the endpoints).
 * - Without it, the same `worlds/<id>/...` layout is read from a local
 *   directory (default `maps/assets` at the repo root, git-ignored) so the
 *   viewer works offline with Scaniverse exports copied by hand.
 */

const API_URL = process.env.WANDER_API_URL?.replace(/\/+$/, "");
const API_KEY = process.env.WANDER_API_KEY;
// Dev-only fallback outside the app dir; tell Turbopack not to trace it into the server bundle.
const ASSETS_DIR = resolve(
  /*turbopackIgnore: true*/ process.env.WANDER_ASSETS_DIR ?? join(process.cwd(), "../../maps/assets"),
);

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const worldsSource = API_URL ? ("api" as const) : ("local" as const);

/**
 * Base URL the phone should post to, for the connect QR code. The API URL is
 * public (every request still needs the key, which never leaves the server);
 * null in local mode, where the viewer offers its own origin + /api instead.
 */
export const phoneBackendUrl: string | null = API_URL ?? null;

/** Reject anything that could escape `worlds/` (dotfiles, `..`, separators). */
export function isSafeSegment(s: string): boolean {
  return SEGMENT_RE.test(s);
}

const MIME: Record<string, string> = {
  ".spz": "application/octet-stream",
  ".ply": "application/octet-stream",
  ".splat": "application/octet-stream",
  ".ksplat": "application/octet-stream",
  ".sog": "application/octet-stream",
  ".rad": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "text/plain",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bin": "application/octet-stream",
};

/** Shared-secret auth per shared/contracts/README.md; the key never leaves the server. */
function apiHeaders(): HeadersInit {
  return API_KEY ? { "X-API-Key": API_KEY } : {};
}

export async function listWorlds(): Promise<WorldManifest[]> {
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds`, { headers: apiHeaders(), cache: "no-store" });
    if (!res.ok) throw await apiError(res);
    const body: unknown = await res.json();
    const list = Array.isArray(body)
      ? body
      : ((body as { worlds?: unknown[] })?.worlds ?? []);
    return list.flatMap((m) => safeParse(m));
  }

  const root = join(ASSETS_DIR, "worlds");
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && isSafeSegment(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const manifests = await Promise.all(dirs.map((id) => readLocalManifest(id)));
  return manifests
    .filter((m): m is WorldManifest => m !== null)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.name.localeCompare(b.name));
}

export async function getWorld(id: string): Promise<WorldManifest | null> {
  if (!isSafeSegment(id)) return null;
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}`, {
      headers: apiHeaders(),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await apiError(res);
    return parseManifest(await res.json());
  }
  return readLocalManifest(id);
}

/**
 * Open a versioned asset (`worlds/<id>/<version>/<file>`) as a streaming
 * Response, ready to be returned from a route handler. `null` when missing.
 */
export async function openAsset(segments: string[]): Promise<Response | null> {
  if (segments.length < 2 || !segments.every(isSafeSegment)) return null;
  const file = segments[segments.length - 1];

  if (API_URL) {
    const url = `${API_URL}/worlds/${segments.map(encodeURIComponent).join("/")}`;
    const upstream = await fetch(url, { headers: apiHeaders(), cache: "no-store" });
    if (upstream.status === 404) return null;
    if (!upstream.ok || !upstream.body) throw await apiError(upstream);
    const headers = new Headers();
    for (const h of ["content-type", "content-length", "etag", "last-modified", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (!headers.has("content-type")) headers.set("content-type", mimeFor(file));
    headers.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(upstream.body, { status: 200, headers });
  }

  const path = join(ASSETS_DIR, "worlds", ...segments);
  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    size = s.size;
  } catch {
    return null;
  }
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": mimeFor(file),
      "content-length": String(size),
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/** Replace the world's navigation graph (stops + edges tagged in the viewer). Returns the updated manifest. */
export async function saveGraph(id: string, graph: NavigationGraph, sourceRevision?: string | null): Promise<WorldManifest | null> {
  if (!isSafeSegment(id)) return null;
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/graph`, {
      method: "PUT",
      headers: { ...apiHeaders(), "content-type": "application/json", ...(sourceRevision ? { "if-match": sourceRevision } : {}) },
      body: JSON.stringify(graph),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await apiError(res);
    return parseManifest(await res.json());
  }
  const manifest = await readLocalManifest(id);
  if (!manifest) return null;
  const next: WorldManifest = { ...manifest, navigationGraph: graph, updatedAt: new Date().toISOString() };
  await writeFile(join(ASSETS_DIR, "worlds", id, "world.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/* ------------------------------------------------------------------ navmesh */

const MESH_TOOLS_NEED_API = "Mesh tools run in the worlds backend — set WANDER_API_URL to build or validate graphs";

/** The last mesh-derived graph proposal (`worlds/<id>/navmesh.json`), or null when none was built. */
export async function getNavmesh(id: string): Promise<NavmeshProposal | null> {
  if (!isSafeSegment(id)) return null;
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/navmesh`, { headers: apiHeaders(), cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as NavmeshProposal;
  }
  try {
    return JSON.parse(await readFile(join(ASSETS_DIR, "worlds", id, "navmesh.json"), "utf8")) as NavmeshProposal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Grid the world's mesh and write a *proposed* graph for review; `navigationGraph` is untouched. */
export async function buildNavmesh(id: string, body: unknown): Promise<NavmeshProposal | null> {
  if (!isSafeSegment(id)) return null;
  if (!API_URL) throw new WorldsApiError(501, MESH_TOOLS_NEED_API);
  const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/navmesh`, {
    method: "POST",
    headers: { ...apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as NavmeshProposal;
}

/** Edge-through-wall / floor checks (and floor snapping) of a graph against the mesh; read-only. */
export async function validateGraphAgainstMesh(id: string, body: unknown): Promise<GraphValidation | null> {
  if (!isSafeSegment(id)) return null;
  if (!API_URL) throw new WorldsApiError(501, MESH_TOOLS_NEED_API);
  const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/graph/validate`, {
    method: "POST",
    headers: { ...apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as GraphValidation;
}

export async function getMeasurements(id: string): Promise<Measurement[]> {
  if (!isSafeSegment(id)) return [];
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/measurements`, {
      headers: apiHeaders(),
      cache: "no-store",
    });
    if (res.status === 404) return [];
    if (!res.ok) throw await apiError(res);
    return parseMeasurements(((await res.json()) as MeasurementsFile).measurements);
  }
  try {
    const raw = await readFile(join(ASSETS_DIR, "worlds", id, "measurements.json"), "utf8");
    return parseMeasurements((JSON.parse(raw) as MeasurementsFile).measurements);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveMeasurements(id: string, measurements: Measurement[]): Promise<MeasurementsFile | null> {
  if (!isSafeSegment(id)) return null;
  const file: MeasurementsFile = {
    schema: MEASUREMENTS_SCHEMA,
    worldId: id,
    measurements,
    updatedAt: new Date().toISOString(),
  };
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/measurements`, {
      method: "PUT",
      headers: { ...apiHeaders(), "content-type": "application/json" },
      body: JSON.stringify(file),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as MeasurementsFile;
  }
  const dir = join(ASSETS_DIR, "worlds", id);
  if (!(await readLocalManifest(id))) return null;
  await mkdir(dir, { recursive: true });
  await writeEditorFile(dir, "measurements.json", file);
  return file;
}

export async function getNotes(id: string): Promise<WorldNote[]> {
  if (!isSafeSegment(id)) return [];
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/notes`, {
      headers: apiHeaders(),
      cache: "no-store",
    });
    if (res.status === 404) return [];
    if (!res.ok) throw await apiError(res);
    return parseNotes(((await res.json()) as NotesFile).notes);
  }
  try {
    const raw = await readFile(join(ASSETS_DIR, "worlds", id, "notes.json"), "utf8");
    return parseNotes((JSON.parse(raw) as NotesFile).notes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const SCENE_DETECTION_NEEDS_API =
  "Object detection runs in the worlds backend (Astra + stored phone localization frames) — set WANDER_API_URL";

export type AutoDetectNotesResult = NotesFile & { added: number; skippedDuplicates: number; unplaced: number };

/**
 * Runs the vision annotator over the world's stored, localized VPS query frames (phone
 * walkthrough images with a recorded pose) and turns every placed finding directly into a
 * plain note pin — same shape as clicking "Add note" in the viewer, no review gate. Skips
 * anything within ~0.6 m of an existing note. Backend-only: needs stored phone localization
 * frames and OpenAI, so this throws 501 in local mode.
 */
export async function autoDetectNotes(id: string, opts: { limit?: number; floor?: number } = {}): Promise<AutoDetectNotesResult | null> {
  if (!isSafeSegment(id)) return null;
  if (!API_URL) throw new WorldsApiError(501, SCENE_DETECTION_NEEDS_API);
  const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/notes/auto-detect`, {
    method: "POST",
    headers: { ...apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify(opts),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await apiError(res);
  const parsed = (await res.json()) as NotesFile & { added: number; skippedDuplicates: number; unplaced: number };
  return { ...parsed, notes: parseNotes(parsed.notes) };
}

export async function saveNotes(id: string, notes: WorldNote[]): Promise<NotesFile | null> {
  if (!isSafeSegment(id)) return null;
  const file: NotesFile = { schema: NOTES_SCHEMA, worldId: id, notes, updatedAt: new Date().toISOString() };
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/notes`, {
      method: "PUT",
      headers: { ...apiHeaders(), "content-type": "application/json" },
      body: JSON.stringify(file),
      cache: "no-store",
    });
    if (res.status === 404 || res.status === 405) {
      // Distinguish "world missing" from "backend hasn't implemented notes yet".
      const world = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}`, { headers: apiHeaders(), cache: "no-store" });
      if (world.status === 404) return null;
      throw new WorldsApiError(
        501,
        "The worlds API has no notes endpoint yet — add GET/PUT /worlds/{id}/notes (shared/contracts/worlds-api.openapi.yaml)",
      );
    }
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as NotesFile;
  }
  const dir = join(ASSETS_DIR, "worlds", id);
  if (!(await readLocalManifest(id))) return null;
  await mkdir(dir, { recursive: true });
  await writeEditorFile(dir, "notes.json", file);
  return file;
}

/** Readers see either complete snapshot, even during a save or interrupted write. */
async function writeEditorFile(dir: string, name: string, file: NotesFile | MeasurementsFile) {
  const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`);
    await rename(temporary, join(dir, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

/* ------------------------------------------------------------ localizations */

/**
 * Recent VPS image queries for a world, newest first (`localizations/index.json`).
 * Images are plain versioned assets: `openAsset([id, "localizations", "<queryId>.jpg"])`.
 */
export async function getLocalizations(id: string, limit = 20): Promise<LocalizationQuery[]> {
  if (!isSafeSegment(id)) return [];
  const n = Math.max(1, Math.min(limit, LOCALIZATIONS_KEPT));
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/localizations?limit=${n}`, {
      headers: apiHeaders(),
      cache: "no-store",
    });
    if (res.status === 404) return [];
    if (!res.ok) throw await apiError(res);
    return parseQueries(await res.json());
  }
  return (await readLocalLocalizations(id)).queries.slice(0, n);
}

/**
 * Store one image query. With a backend the body is forwarded untouched; in
 * local mode the JPEG lands in `maps/assets/worlds/<id>/localizations/` and the
 * record is prepended to `index.json`, so a phone pointed at the dev server
 * works without Modal (graph snapping is skipped locally).
 */
export async function postLocalizationQuery(id: string, upload: unknown): Promise<LocalizationQuery | null> {
  if (!isSafeSegment(id)) return null;
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}/localize/query`, {
      method: "POST",
      headers: { ...apiHeaders(), "content-type": "application/json" },
      body: JSON.stringify(upload),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as LocalizationQuery;
  }

  const errs = validateQueryUpload(upload);
  if (errs.length) throw new WorldsApiError(400, `Invalid query: ${errs.join("; ")}`);
  const body = upload as LocalizationQueryUpload;
  const manifest = await readLocalManifest(id);
  if (!manifest) return null;
  if (!manifest.nianticSiteId || manifest.nianticSiteId !== body.nianticSiteId)
    throw new WorldsApiError(409, "Niantic site mismatch");
  const image = Buffer.from(body.imageBase64, "base64");
  if (image.length > 2 * 1024 * 1024) throw new WorldsApiError(413, "Query image exceeds 2 MiB");
  if (image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) throw new WorldsApiError(400, "Query image must be a JPEG");

  const queryId = `q-${randomUUID().replace(/-/g, "")}`;
  const { imageBase64: _drop, ...rest } = body;
  void _drop;
  const record: LocalizationQuery = {
    schema: LOCALIZATION_QUERY_SCHEMA,
    id: queryId,
    worldId: id,
    ...rest,
    receivedAt: new Date().toISOString(),
    image: { ...body.image, path: `worlds/${id}/localizations/${queryId}.jpg` },
  };
  const dir = join(ASSETS_DIR, "worlds", id, "localizations");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${queryId}.jpg`), image);
  const index = await readLocalLocalizations(id);
  const kept = index.queries.slice(0, LOCALIZATIONS_KEPT - 1);
  await Promise.all(
    index.queries.slice(LOCALIZATIONS_KEPT - 1).map((old) => rm(join(dir, `${old.id}.jpg`), { force: true })),
  );
  const next: LocalizationQueries = {
    schema: LOCALIZATIONS_SCHEMA,
    worldId: id,
    queries: [record, ...kept],
    updatedAt: record.receivedAt,
  };
  await writeFile(join(dir, "index.json"), `${JSON.stringify(next)}\n`);
  return record;
}

async function readLocalLocalizations(id: string): Promise<LocalizationQueries> {
  const empty: LocalizationQueries = { schema: LOCALIZATIONS_SCHEMA, worldId: id, queries: [] };
  try {
    const raw = await readFile(join(ASSETS_DIR, "worlds", id, "localizations", "index.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalizationQueries>;
    return { ...empty, queries: parseQueries(parsed.queries ?? []), updatedAt: parsed.updatedAt };
  } catch {
    return empty;
  }
}

/* ------------------------------------------------------------ create / upload */

export type CreateWorldInput = {
  id: string;
  name: string;
  space?: string;
  description?: string;
  nianticSiteId?: string | null;
  /** Filename the manifest should point at under v1 (default scene.spz). */
  splatFilename?: string;
};

/**
 * The deployed FastAPI stores every world's splat as `<version>/scene.spz` and
 * derives `assets.splat` itself (it rejects `splatFilename` on POST and
 * `assets` on PATCH), so through the API only `.spz` can be attached.
 */
const API_SPLAT_FILENAME = "scene.spz";
const API_SPZ_ONLY =
  "The worlds API stores splats as scene.spz — export the scan from Scaniverse as .spz (other formats work in local mode).";

/** Create `worlds/<id>/world.json` as a draft pointing at `v1/<splatFilename>`. 409 if the id is taken. */
export async function createWorld(input: CreateWorldInput): Promise<WorldManifest> {
  const splatFilename = input.splatFilename ?? "scene.spz";
  if (!isSafeSegment(input.id) || !isSafeSegment(splatFilename))
    throw new WorldsApiError(400, "Invalid world id or filename");
  if (!SPLAT_EXTENSIONS.has(extname(splatFilename).toLowerCase()))
    throw new WorldsApiError(400, `Unsupported splat format "${extname(splatFilename)}"`);

  if (API_URL) {
    if (splatFilename !== API_SPLAT_FILENAME) throw new WorldsApiError(400, API_SPZ_ONLY);
    const body: Record<string, unknown> = { id: input.id, name: input.name };
    if (input.space) body.space = input.space;
    if (input.description) body.description = input.description;
    if (input.nianticSiteId) body.nianticSiteId = input.nianticSiteId;
    const res = await fetch(`${API_URL}/worlds`, {
      method: "POST",
      headers: { ...apiHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (res.status === 409)
      throw new WorldsApiError(409, "A world with this id already exists — pick another id, or delete it from the dashboard");
    if (!res.ok) throw await apiError(res);
    return parseManifest(await res.json());
  }

  const dir = join(ASSETS_DIR, "worlds", input.id);
  if (existsSync(join(dir, "world.json")))
    throw new WorldsApiError(409, "A world with this id already exists — pick another id, or delete it from the dashboard");
  const manifest: WorldManifest = {
    schema: WORLD_SCHEMA,
    id: input.id,
    name: input.name.trim() || input.id,
    space: input.space?.trim() || undefined,
    description: input.description?.trim() || undefined,
    nianticSiteId: input.nianticSiteId?.trim() || null,
    version: "v1",
    assets: { splat: volumePath(input.id, "v1", splatFilename) },
    alignment: IDENTITY_ALIGNMENT,
    stats: { captureApp: "Scaniverse" },
    status: "draft",
    updatedAt: new Date().toISOString(),
  };
  await mkdir(join(dir, "v1"), { recursive: true });
  await writeFile(join(dir, "world.json"), `${JSON.stringify(parseManifest(manifest), null, 2)}\n`);
  return manifest;
}

export type WorldPatch = Partial<
  Pick<WorldManifest, "name" | "space" | "description" | "nianticSiteId" | "version" | "alignment" | "status" | "stats" | "assets" | "meshFrame">
>;

/** Partial manifest update (name, site id, version/assets switch, status…). */
export async function patchWorld(id: string, patch: WorldPatch): Promise<WorldManifest | null> {
  if (!isSafeSegment(id)) return null;
  if (API_URL) {
    // The API derives assets from `version`; sending `assets` is a 400 there.
    const { assets, ...rest } = patch;
    if (assets?.splat && assets.splat.split("/").pop() !== API_SPLAT_FILENAME)
      throw new WorldsApiError(400, API_SPZ_ONLY);
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...apiHeaders(), "content-type": "application/json" },
      body: JSON.stringify(rest),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await apiError(res);
    return parseManifest(await res.json());
  }
  const current = await readLocalManifest(id);
  if (!current) return null;
  const next = parseManifest({
    ...current,
    ...patch,
    assets: { ...current.assets, ...patch.assets },
    updatedAt: new Date().toISOString(),
  });
  await writeFile(join(ASSETS_DIR, "worlds", id, "world.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Delete a world and every version, asset and localization under it. Irreversible:
 * the volume has no trash. Returns false when the world is already gone, which the
 * route reports as a 404 rather than pretending to have deleted something.
 */
export async function deleteWorld(id: string): Promise<boolean> {
  if (!isSafeSegment(id)) return false;
  if (API_URL) {
    const res = await fetch(`${API_URL}/worlds/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: apiHeaders(),
      cache: "no-store",
    });
    if (res.status === 404) return false;
    if (!res.ok && res.status !== 204) throw await apiError(res);
    return true;
  }
  // Local mode: only remove a directory that actually holds a world we can read, so a
  // typo'd id can never take out an unrelated folder under the assets root.
  if (!(await readLocalManifest(id))) return false;
  await rm(join(ASSETS_DIR, "worlds", id), { recursive: true, force: true });
  return true;
}

/**
 * Where the browser should send one asset's bytes.
 *
 * A splat is far larger than the 4.5 MB request body a Vercel function accepts,
 * so in production the bytes must not pass through this app at all: the backend
 * mints a ticket scoped to exactly this path and the browser PUTs straight to
 * it. Without `WANDER_API_URL` there is no backend and the local dev server
 * writes the file itself, so the browser keeps using the same-origin route.
 */
export type UploadTarget =
  | { mode: "direct"; url: string; header: string; token: string; expiresAt: number }
  /**
   * The bytes come back through this app. `maxBytes` is set only where a platform
   * caps the request body of a route handler (Vercel: 4.5 MB), so the browser can
   * refuse a file it knows will be rejected instead of sending it and reading a 413.
   * `reason` explains why the direct path was unavailable, when we know.
   */
  | { mode: "proxy"; maxBytes?: number; reason?: string };

/** Vercel rejects request bodies over this before a route handler ever runs. */
const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;

function proxyTarget(reason?: string): UploadTarget {
  return process.env.VERCEL ? { mode: "proxy", maxBytes: VERCEL_BODY_LIMIT, reason } : { mode: "proxy", reason };
}

export async function uploadTarget(segments: string[]): Promise<UploadTarget> {
  if (segments.length !== 3 || !segments.every(isSafeSegment)) throw new WorldsApiError(400, "Invalid asset path");
  const file = segments[2];
  if (!UPLOAD_EXTENSIONS.has(extname(file).toLowerCase()))
    throw new WorldsApiError(400, `Unsupported file type "${extname(file)}"`);
  if (!API_URL) return proxyTarget();
  if (SPLAT_EXTENSIONS.has(extname(file).toLowerCase()) && file !== API_SPLAT_FILENAME)
    throw new WorldsApiError(400, API_SPZ_ONLY);

  const path = segments.map(encodeURIComponent).join("/");
  const res = await fetch(`${API_URL}/worlds/${path}/ticket`, {
    method: "POST",
    headers: apiHeaders(),
    cache: "no-store",
  });
  if (res.status === 409) throw new WorldsApiError(409, "That version already has this file — upload a new version");
  // An older backend has no ticket route; fall back to proxying, which still works below 4.5 MB.
  if (res.status === 404 || res.status === 405) return proxyTarget();
  // 503 is the backend saying direct uploads are switched off (no WANDER_WEB_ORIGINS).
  // Proxying is the only route left, so carry its reason through for the error message.
  if (res.status === 503) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    return proxyTarget(typeof body?.detail === "string" ? body.detail : undefined);
  }
  if (!res.ok) throw await apiError(res);
  const ticket = (await res.json()) as { token: string; expiresAt: number; header: string };
  return {
    mode: "direct",
    url: `${API_URL}/worlds/${path}`,
    header: ticket.header,
    token: ticket.token,
    expiresAt: ticket.expiresAt,
  };
}

/**
 * Store an uploaded asset at `worlds/<id>/<version>/<file>` from a streaming
 * body — nothing is buffered in memory. Versions are immutable, so an
 * existing file is a 409; the caller bumps the version instead.
 */
export async function uploadAsset(
  segments: string[],
  body: ReadableStream<Uint8Array>,
  contentLength: number | null,
): Promise<{ path: string; bytes: number }> {
  if (segments.length !== 3 || !segments.every(isSafeSegment)) throw new WorldsApiError(400, "Invalid asset path");
  const [id, , file] = segments;
  if (!UPLOAD_EXTENSIONS.has(extname(file).toLowerCase()))
    throw new WorldsApiError(400, `Unsupported file type "${extname(file)}"`);
  if (contentLength !== null && contentLength > MAX_UPLOAD_BYTES)
    throw new WorldsApiError(413, "File is larger than the 2 GiB upload limit");

  if (API_URL) {
    if (SPLAT_EXTENSIONS.has(extname(file).toLowerCase()) && file !== API_SPLAT_FILENAME)
      throw new WorldsApiError(400, API_SPZ_ONLY);
    const res = await fetch(`${API_URL}/worlds/${segments.map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      headers: {
        ...apiHeaders(),
        "content-type": "application/octet-stream",
        ...(contentLength !== null ? { "content-length": String(contentLength) } : {}),
      },
      body,
      // Required by undici to stream a request body without knowing it up front.
      duplex: "half",
      cache: "no-store",
    } as RequestInit & { duplex: "half" });
    if (res.status === 409) throw new WorldsApiError(409, "That version already has this file — upload a new version");
    if (res.status === 413) throw new WorldsApiError(413, "The backend rejected the file as too large");
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as { path: string; bytes: number };
  }

  const manifest = await readLocalManifest(id);
  if (!manifest) throw new WorldsApiError(404, "World not found");
  const path = join(ASSETS_DIR, "worlds", ...segments);
  if (existsSync(path)) throw new WorldsApiError(409, "That version already has this file — upload a new version");
  await mkdir(dirname(path), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(body as unknown as NodeReadableStream), createWriteStream(path, { flags: "wx" }));
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
  const { size } = await stat(path);
  const volume = `worlds/${segments.join("/")}`;
  // Conventional filenames register themselves, like the backend does on upload.
  const key = CONVENTIONAL_ASSETS[file];
  if (key && segments[1] === manifest.version && manifest.assets[key] !== volume) {
    const next = { ...manifest, assets: { ...manifest.assets, [key]: volume }, updatedAt: new Date().toISOString() };
    await writeFile(join(ASSETS_DIR, "worlds", id, "world.json"), `${JSON.stringify(next, null, 2)}\n`);
  }
  return { path: volume, bytes: size };
}

/** Turn a failed backend response into an error the UI can show, keeping FastAPI's `detail` text. */
async function apiError(res: Response): Promise<WorldsApiError> {
  const { status } = res;
  if (status === 401 || status === 403)
    return new WorldsApiError(502, "Worlds API rejected the API key — check WANDER_API_KEY matches the backend");
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const detail =
    typeof body?.detail === "string"
      ? body.detail
      : Array.isArray(body?.detail)
        ? (body.detail as { msg?: string }[]).map((d) => d.msg ?? JSON.stringify(d)).join("; ")
        : null;
  return new WorldsApiError(status >= 500 ? 502 : status, detail ? `Worlds API: ${detail}` : `Worlds API responded ${status}`);
}

function mimeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function readLocalManifest(id: string): Promise<WorldManifest | null> {
  try {
    const raw = await readFile(join(ASSETS_DIR, "worlds", id, "world.json"), "utf8");
    const manifest = parseManifest(JSON.parse(raw));
    if (manifest.id !== id) {
      console.warn(`[worlds] ${id}/world.json declares id "${manifest.id}"; skipping`);
      return null;
    }
    return manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(`[worlds] could not read ${id}/world.json:`, (err as Error).message);
    return null;
  }
}

function safeParse(input: unknown): WorldManifest[] {
  try {
    return [parseManifest(input)];
  } catch (err) {
    console.warn("[worlds] skipping invalid manifest from API:", (err as Error).message);
    return [];
  }
}
