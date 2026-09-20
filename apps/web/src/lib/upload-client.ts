"use client";

import { nextVersion, type WorldManifest } from "./world-manifest";
import type { WorldStatus } from "./worlds";

/**
 * Browser-side upload flows against the Next.js proxy (/api/worlds). XHR is
 * used for the file itself because `fetch` still has no upload progress in
 * Safari.
 */

export type UploadProgress = { loaded: number; total: number };

export class UploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${fallback} (${res.status})`;
}

type UploadTarget =
  | { mode: "direct"; url: string; header: string; token: string; expiresAt: number }
  | { mode: "proxy"; maxBytes?: number; reason?: string };

const BACKEND_UNREACHABLE =
  "The browser could not reach the worlds backend. It has to allow this site's origin — set WANDER_WEB_ORIGINS on the backend and redeploy.";

/**
 * Ask the server where this file's bytes should go.
 *
 * A splat is far bigger than the 4.5 MB request body a Vercel function accepts, so in
 * production the answer is a ticket scoped to this one path and the upload goes straight
 * to the worlds backend. Running against local files there is no backend, and the answer
 * is the same-origin route.
 */
async function resolveTarget(
  worldId: string,
  version: string,
  filename: string,
  signal?: AbortSignal,
): Promise<UploadTarget> {
  const proxyUrl = assetPath(worldId, version, filename);
  const res = await fetch(`${proxyUrl}/ticket`, { method: "POST", signal });
  if (!res.ok) throw new UploadError(res.status, await readError(res, "Could not start the upload"));
  return (await res.json()) as UploadTarget;
}

function assetPath(worldId: string, version: string, filename: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}`;
}

/** PUT one file to `worlds/<id>/<version>/<filename>` with progress. Resolves to the stored path. */
export async function uploadSplatFile(
  worldId: string,
  version: string,
  file: File,
  onProgress: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<{ path: string; bytes: number }> {
  const target = await resolveTarget(worldId, version, file.name, signal);
  if (target.mode === "proxy" && target.maxBytes !== undefined && file.size > target.maxBytes) {
    // Sending it would come back as an opaque platform 413, so say what is actually wrong.
    throw new UploadError(
      413,
      target.reason
        ? `${formatBytes(file.size)} is too large to upload through this site (limit ${formatBytes(target.maxBytes)}). ${target.reason}.`
        : `${formatBytes(file.size)} is too large to upload through this site (limit ${formatBytes(target.maxBytes)}).`,
    );
  }
  const url = target.mode === "direct" ? target.url : assetPath(worldId, version, file.name);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    if (target.mode === "direct") xhr.setRequestHeader(target.header, target.token);
    xhr.upload.onprogress = (e) => onProgress({ loaded: e.loaded, total: e.lengthComputable ? e.total : file.size });
    // A direct PUT that never reaches the server is almost always the backend refusing
    // this origin: the browser blocks it at the preflight and reports nothing useful.
    xhr.onerror = () =>
      reject(new UploadError(0, target.mode === "direct" ? BACKEND_UNREACHABLE : "Network error while uploading"));
    xhr.onabort = () => reject(new UploadError(0, "Upload cancelled"));
    xhr.onload = () => {
      let body: { path?: string; bytes?: number; error?: string; detail?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.path)
        resolve({ path: body.path, bytes: body.bytes ?? file.size });
      // `error` is this app's shape, `detail` is FastAPI's when the PUT went straight to the backend.
      else reject(new UploadError(xhr.status, body.error ?? body.detail ?? `Upload failed (${xhr.status})`));
    };
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export type NewWorldInput = {
  id: string;
  name: string;
  space?: string;
  nianticSiteId?: string;
  file: File | null;
  /** Aligned collision mesh (.glb); goes into the same version as the splat. */
  mesh?: File | null;
};

/** Create the manifest, then (optionally) upload the splat and mesh and mark the world ready. */
export async function createWorldWithSplat(
  input: NewWorldInput,
  onProgress: (p: UploadProgress) => void,
  onStage: (stage: string) => void,
  signal?: AbortSignal,
): Promise<WorldManifest> {
  onStage("Creating world");
  const res = await fetch("/api/worlds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: input.id,
      name: input.name,
      space: input.space || undefined,
      nianticSiteId: input.nianticSiteId || null,
      splatFilename: input.file ? safeFilename(input.file.name) : undefined,
    }),
    signal,
  });
  if (!res.ok) throw new UploadError(res.status, await readError(res, "Could not create the world"));
  let manifest = (await res.json()) as WorldManifest;
  if (!input.file && !input.mesh) return manifest;

  if (input.file) {
    onStage("Uploading splat");
    const file = renameFile(input.file, safeFilename(input.file.name));
    try {
      await uploadSplatFile(manifest.id, manifest.version, file, onProgress, signal);
    } catch (err) {
      // Nothing landed, so the world we just made is an empty draft holding its id
      // hostage: the next attempt would fail with "a world with this id already exists"
      // and hide the real error. Take it back out and report what actually went wrong.
      await discardWorld(manifest.id);
      throw err;
    }
  }
  if (input.mesh) {
    onStage("Uploading mesh");
    // The splat is already stored by now, so a mesh failure keeps the world: losing a
    // large upload to a missing .glb would be worse than a world without a mesh.
    await uploadMeshForWorld(manifest, input.mesh, onProgress, signal);
  }

  onStage("Finishing");
  manifest = await patchWorld(manifest.id, { status: input.nianticSiteId ? "aligned" : "processing" }, signal);
  return manifest;
}

/**
 * Upload a splat for an existing world. Tries the manifest's current version
 * first (fills in a missing file); if that version already has the file, the
 * upload goes to the next version and the manifest is switched over.
 */
export async function uploadSplatForWorld(
  manifest: WorldManifest,
  rawFile: File,
  onProgress: (p: UploadProgress) => void,
  onStage: (stage: string) => void,
  signal?: AbortSignal,
): Promise<WorldManifest> {
  const file = renameFile(rawFile, safeFilename(rawFile.name));
  const currentFile = manifest.assets.splat.split("/").pop();
  let version = manifest.version;

  onStage(`Uploading to ${version}`);
  let stored: { path: string };
  try {
    stored = await uploadSplatFile(manifest.id, version, file, onProgress, signal);
  } catch (err) {
    if (!(err instanceof UploadError) || err.status !== 409) throw err;
    version = nextVersion(manifest.version);
    onStage(`Uploading to ${version}`);
    stored = await uploadSplatFile(manifest.id, version, file, onProgress, signal);
  }

  onStage("Switching version");
  const status: WorldStatus = manifest.nianticSiteId ? "aligned" : "processing";
  const needsSwitch = version !== manifest.version || file.name !== currentFile;
  return patchWorld(
    manifest.id,
    needsSwitch ? { version, assets: { ...manifest.assets, splat: stored.path }, status } : { status },
    signal,
  );
}

export const MESH_FILENAME = "mesh.glb";

/**
 * Upload the aligned collision mesh (Scaniverse .glb) into the world's current
 * version as `mesh.glb`. The server registers it under `assets.mesh` itself, so
 * no manifest patch is needed; versions are immutable, so an existing mesh is a 409.
 */
export async function uploadMeshForWorld(
  manifest: WorldManifest,
  rawFile: File,
  onProgress: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<{ path: string; bytes: number }> {
  if (!rawFile.name.toLowerCase().endsWith(".glb")) throw new UploadError(400, "The mesh must be a .glb file");
  try {
    return await uploadSplatFile(manifest.id, manifest.version, renameFile(rawFile, MESH_FILENAME), onProgress, signal);
  } catch (err) {
    if (err instanceof UploadError && err.status === 409)
      throw new UploadError(409, `${manifest.version} already has a mesh — upload a new splat version first, then add the mesh to it`);
    throw err;
  }
}

/** Best-effort rollback of a world this module just created; never masks the original failure. */
async function discardWorld(id: string): Promise<void> {
  try {
    await fetch(`/api/worlds/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    /* the upload error is the one worth reporting */
  }
}

async function patchWorld(id: string, patch: unknown, signal?: AbortSignal): Promise<WorldManifest> {
  const res = await fetch(`/api/worlds/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
    signal,
  });
  if (!res.ok) throw new UploadError(res.status, await readError(res, "Could not update the world"));
  return (await res.json()) as WorldManifest;
}

/** Keep the extension, normalise the rest to a safe, predictable `scene.<ext>`. */
export function safeFilename(name: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return `scene${ext}`;
}

function renameFile(file: File, name: string): File {
  return file.name === name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
}

export function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
