"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import {
  createWorldWithSplat,
  formatBytes,
  uploadMeshForWorld,
  uploadSplatForWorld,
  type UploadProgress,
} from "@/lib/upload-client";
import { SPLAT_FILE_EXTENSIONS, slugifyWorldId, type WorldManifest } from "@/lib/world-manifest";
import { worldHref } from "@/lib/worlds";

export type UploadDialogMode =
  /** Create a world (file optional — without one the world opens as a draft). */
  | { kind: "new" }
  /** Add / replace the splat of an existing world; bumps the version when needed. */
  | { kind: "existing"; manifest: WorldManifest };

type Props = {
  open: boolean;
  mode: UploadDialogMode;
  onClose: () => void;
  /** Called after a successful upload; the default navigates to the world. */
  onDone?: (manifest: WorldManifest) => void;
};

const ACCEPT = SPLAT_FILE_EXTENSIONS.join(",");
const MESH_ACCEPT = ".glb,model/gltf-binary";
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type Phase = { kind: "idle" } | { kind: "busy"; stage: string; progress: UploadProgress | null } | { kind: "error"; message: string };

/** Modal for importing a Scaniverse export (.spz / .ply / .splat / .ksplat / .sog). */
export function UploadSplatDialog({ open, mode, onClose, onDone }: Props) {
  const router = useRouter();
  const titleId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [space, setSpace] = useState("");
  /** Aligned collision mesh; optional, but waypoint generation needs it. */
  const [mesh, setMesh] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const busy = phase.kind === "busy";
  const existing = mode.kind === "existing" ? mode.manifest : null;
  const derivedId = idTouched ? id : slugifyWorldId(name);
  const idValid = ID_RE.test(derivedId);
  const canSubmit = existing ? !!file || !!mesh : name.trim().length > 0 && idValid;

  // Reset when (re)opened.
  const openedRef = useRef(false);
  useEffect(() => {
    if (open && !openedRef.current) {
      setFile(null);
      setName("");
      setId("");
      setIdTouched(false);
      setSpace("");
      setMesh(null);
      setPhase({ kind: "idle" });
    }
    openedRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  function pickFile(f: File | undefined) {
    if (!f) return;
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (!(SPLAT_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
      setPhase({ kind: "error", message: `"${f.name}" isn't a splat. Use ${SPLAT_FILE_EXTENSIONS.join(", ")}.` });
      return;
    }
    setPhase({ kind: "idle" });
    setFile(f);
    if (!existing && !name) setName(f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "));
  }

  function pickMesh(f: File | undefined) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".glb")) {
      setPhase({ kind: "error", message: `"${f.name}" isn't a mesh. Export the Scaniverse mesh as .glb.` });
      return;
    }
    setPhase({ kind: "idle" });
    setMesh(f);
  }

  /** The drop zone takes both files: .glb is the mesh, everything else the splat. */
  function dropFiles(list: FileList) {
    for (const f of list) (f.name.toLowerCase().endsWith(".glb") ? pickMesh : pickFile)(f);
  }

  async function submit() {
    if (!canSubmit || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    const onProgress = (progress: UploadProgress) =>
      setPhase((p) => (p.kind === "busy" ? { ...p, progress } : p));
    const onStage = (stage: string) => setPhase({ kind: "busy", stage, progress: null });
    try {
      let manifest: WorldManifest;
      if (existing) {
        manifest = file ? await uploadSplatForWorld(existing, file, onProgress, onStage, controller.signal) : existing;
        if (mesh) {
          onStage("Uploading mesh");
          await uploadMeshForWorld(manifest, mesh, onProgress, controller.signal);
        }
      } else {
        manifest = await createWorldWithSplat(
          { id: derivedId, name: name.trim(), space: space.trim(), file, mesh },
          onProgress,
          onStage,
          controller.signal,
        );
      }
      setPhase({ kind: "idle" });
      onClose();
      if (onDone) onDone(manifest);
      else router.push(worldHref(manifest.id));
    } catch (err) {
      if (controller.signal.aborted) setPhase({ kind: "idle" });
      else setPhase({ kind: "error", message: err instanceof Error ? err.message : "Upload failed" });
    } finally {
      abort.current = null;
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="card w-full max-w-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-heading-sm font-bold text-void-black">
              {existing ? `Upload to ${existing.name}` : "New world"}
            </h2>
            <p className="mt-1 text-body-sm text-graphite">
              {existing
                ? `The splat goes to ${existing.version} if that version is still empty, otherwise to a new version; the mesh follows it.`
                : "Export the scan from Scaniverse as .spz, and the collision mesh as .glb. You can also create the world now and add the files later."}
            </p>
          </div>
          <button type="button" className="btn-icon" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Drop zone */}
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            dropFiles(e.dataTransfer.files);
          }}
          className={`mt-5 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors duration-200 ${
            dragging ? "border-wander-blue bg-sky-tint" : "border-void-black/20 bg-stellar-white hover:border-void-black/40"
          } ${busy ? "pointer-events-none opacity-60" : ""}`}
        >
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            disabled={busy}
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
          <span className="inline-flex size-10 items-center justify-center rounded-full border-2 border-wander-sky bg-pure-white text-wander-blue">
            <Icon name={file ? "check" : "upload"} size={18} />
          </span>
          {file ? (
            <>
              <span className="text-body-sm font-medium text-void-black">{file.name}</span>
              <span className="text-caption text-void-black/50">{formatBytes(file.size)} · click to change</span>
            </>
          ) : (
            <>
              <span className="text-body-sm font-medium text-void-black">Drop a splat here or click to browse</span>
              <span className="text-caption text-void-black/50">{SPLAT_FILE_EXTENSIONS.join(" · ")} · up to 2 GB</span>
            </>
          )}
        </label>

        {/* Mesh: optional here, required before waypoints can be checked or generated */}
        <label
          className={`mt-3 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-3 transition-colors duration-200 ${
            mesh ? "border-wander-sky bg-sky-tint/40" : "border-void-black/20 bg-stellar-white hover:border-void-black/40"
          } ${busy ? "pointer-events-none opacity-60" : ""}`}
        >
          <input
            type="file"
            accept={MESH_ACCEPT}
            className="sr-only"
            disabled={busy}
            onChange={(e) => pickMesh(e.target.files?.[0])}
          />
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-wander-sky bg-pure-white text-wander-blue">
            <Icon name={mesh ? "check" : "layers"} size={15} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-body-sm font-medium text-void-black">
              {mesh ? mesh.name : "Add the aligned mesh (.glb)"}
            </span>
            <span className="block text-caption text-void-black/50">
              {mesh
                ? `${formatBytes(mesh.size)} · click to change`
                : "Optional · waypoints are checked and generated from it"}
            </span>
          </span>
        </label>

        {/* World fields (new worlds only) */}
        {!existing && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="World name" htmlFor={`${titleId}-name`} className="sm:col-span-2">
              <input
                id={`${titleId}-name`}
                className="input"
                value={name}
                placeholder="E7 Atrium — ground floor"
                autoFocus
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field
              label="World id"
              htmlFor={`${titleId}-id`}
              hint={derivedId && !idValid ? "Lowercase letters, numbers, . _ -" : "Folder name on the volume"}
              invalid={!!derivedId && !idValid}
            >
              <input
                id={`${titleId}-id`}
                className="input font-mono text-body-sm"
                value={derivedId}
                placeholder="e7-atrium"
                disabled={busy}
                onChange={(e) => {
                  setIdTouched(true);
                  setId(e.target.value.toLowerCase());
                }}
              />
            </Field>
            <Field label="Space" htmlFor={`${titleId}-space`} hint="Optional group, e.g. Engineering 7">
              <input
                id={`${titleId}-space`}
                className="input"
                value={space}
                placeholder="Engineering 7"
                disabled={busy}
                onChange={(e) => setSpace(e.target.value)}
              />
            </Field>
          </div>
        )}

        {/* Progress / errors */}
        {phase.kind === "busy" && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-caption text-void-black/60">
              <span>{phase.stage}…</span>
              {phase.progress && (
                <span>
                  {formatBytes(phase.progress.loaded)} of {formatBytes(phase.progress.total)}
                </span>
              )}
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-hairline" role="progressbar">
              <div
                className={`h-full rounded-full bg-wander-blue transition-[width] duration-200 ease-out ${
                  phase.progress ? "" : "progress-indeterminate w-1/3"
                }`}
                style={
                  phase.progress
                    ? { width: `${Math.min(100, (phase.progress.loaded / Math.max(1, phase.progress.total)) * 100)}%` }
                    : undefined
                }
              />
            </div>
          </div>
        )}
        {phase.kind === "error" && (
          <p role="alert" className="mt-4 rounded-lg bg-pink-tint px-3 py-2 text-body-sm text-wander-pink">
            {phase.message}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          {busy ? (
            <button type="button" className="btn-text" onClick={() => abort.current?.abort()}>
              Cancel upload
            </button>
          ) : (
            <button type="button" className="btn-text" onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="button" className="btn-primary" disabled={!canSubmit || busy} onClick={submit}>
            <Icon name="upload" size={15} />
            {existing ? "Upload" : file || mesh ? "Create & upload" : "Create draft"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  invalid,
  className = "",
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  invalid?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint && <p className={`mt-1 text-caption ${invalid ? "text-wander-pink" : "text-void-black/50"}`}>{hint}</p>}
    </div>
  );
}
