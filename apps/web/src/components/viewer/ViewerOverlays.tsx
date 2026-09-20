"use client";

import { Icon, type IconName } from "@/components/Icon";
import { LogoMark } from "@/components/Logo";
import type { WorldManifest } from "@/lib/world-manifest";
import type { ViewerApi, ViewerState } from "./useSplatViewer";

/** Centered status cards drawn over the canvas while the world isn't interactive. */
export function ViewerOverlay({
  state,
  api,
  name,
  worldId,
  manifest,
  source,
  onUpload,
}: {
  state: ViewerState;
  api: ViewerApi;
  name: string;
  worldId: string;
  manifest: WorldManifest | null;
  source: "api" | "local";
  /** Opens the upload dialog; only offered when the world has a manifest to attach the file to. */
  onUpload?: () => void;
}) {
  if (state.status === "ready" || state.mesh.status === "ready") return null;

  const version = manifest?.version ?? "v1";
  const expectedPath = manifest?.assets.splat ?? `worlds/${worldId}/${version}/scene.spz`;
  const canUpload = !!manifest && !!onUpload;

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div className="pointer-events-auto card w-full max-w-sm text-center">
        {(state.status === "booting" || state.status === "loading") && (
          <>
            <LogoMark size={36} className="mx-auto" />
            <p className="mt-4 text-body font-medium text-void-black">
              {state.status === "booting" ? "Starting the viewer" : `Loading ${name}`}
            </p>
            <ProgressBar progress={state.progress} indeterminate={state.status === "booting"} />
            <p className="mt-2 text-caption text-void-black/50">
              {state.progress && state.progress.total > 0
                ? `${formatBytes(state.progress.loaded)} of ${formatBytes(state.progress.total)}`
                : state.progress
                  ? `${formatBytes(state.progress.loaded)} downloaded`
                  : "Preparing WebGL"}
            </p>
          </>
        )}

        {state.status === "empty" && (
          <>
            <Ring icon="cube" tone="border-wander-sky text-wander-blue" />
            <p className="mt-4 text-body font-medium text-void-black">No splat uploaded yet</p>
            {canUpload ? (
              <>
                <p className="mt-1 text-body-sm text-graphite">
                  Export the scan from Scaniverse as .spz and upload it here. It lands at
                </p>
                <code className="mt-2 block rounded-sm bg-stellar-white px-2 py-1 text-caption break-all text-void-black/70">
                  {expectedPath}
                </code>
                <button type="button" className="btn-primary mt-4" onClick={onUpload}>
                  <Icon name="upload" size={15} />
                  Upload splat
                </button>
              </>
            ) : (
              <>
                <p className="mt-1 text-body-sm text-graphite">
                  {source === "api"
                    ? "Export the scan from Scaniverse and upload it to the Modal Volume at"
                    : "Export the scan from Scaniverse and copy it to maps/assets at"}
                </p>
                <code className="mt-2 block rounded-sm bg-stellar-white px-2 py-1 text-caption break-all text-void-black/70">
                  {expectedPath}
                </code>
                <p className="mt-2 text-caption text-void-black/50">
                  Then add <code>worlds/{worldId}/world.json</code> — see shared/contracts.
                </p>
              </>
            )}
          </>
        )}

        {state.status === "error" && (
          <>
            <Ring icon="x" tone="border-wander-pink text-wander-pink" />
            <p className="mt-4 text-body font-medium text-void-black">Couldn&apos;t load this world</p>
            <p className="mt-1 text-body-sm text-graphite">{state.error}</p>
            <div className="mt-4 flex justify-center gap-2">
              <button type="button" className="btn-ghost" onClick={api.retry}>
                <Icon name="refresh" size={15} />
                Try again
              </button>
              {canUpload && (
                <button type="button" className="btn-primary" onClick={onUpload}>
                  <Icon name="upload" size={15} />
                  Upload splat
                </button>
              )}
            </div>
          </>
        )}

        {state.status === "unsupported" && (
          <>
            <Ring icon="eye" tone="border-wander-navy text-wander-navy" />
            <p className="mt-4 text-body font-medium text-void-black">WebGL 2 is unavailable</p>
            <p className="mt-1 text-body-sm text-graphite">
              The splat renderer needs WebGL 2. Try a current version of Chrome, Edge, Firefox, or Safari with
              hardware acceleration enabled.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export function Ring({ icon, tone }: { icon: IconName; tone: string }) {
  return (
    <span
      className={`mx-auto inline-flex size-11 items-center justify-center rounded-full border-2 bg-pure-white ${tone}`}
    >
      <Icon name={icon} size={18} />
    </span>
  );
}

function ProgressBar({
  progress,
  indeterminate,
}: {
  progress: { loaded: number; total: number } | null;
  indeterminate: boolean;
}) {
  const pct = progress && progress.total > 0 ? Math.min(100, (progress.loaded / progress.total) * 100) : null;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={pct === null ? "Loading" : undefined}
      className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-hairline"
    >
      <div
        className={`h-full rounded-full bg-wander-blue transition-[width] duration-200 ease-out ${
          pct === null || indeterminate ? "progress-indeterminate w-1/3" : ""
        }`}
        style={pct !== null && !indeterminate ? { width: `${pct}%` } : undefined}
      />
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
