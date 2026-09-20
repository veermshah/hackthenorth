"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { AssistantPanel } from "./AssistantPanel";
import {
  formatSplatCount,
  graphLengthMetres,
  measurementLength,
  type Measurement,
  type NavigationGraph,
  type NavNodeKind,
  type Vec3,
  type WorldManifest,
  type WorldNote,
} from "@/lib/world-manifest";
import { STATUS_META, type WorldStatus } from "@/lib/worlds";
import { LiveTab, type LiveTabProps } from "./LiveTab";
import { WaypointsTab, type WaypointsTabProps } from "./WaypointsTab";
import { formatMetres, type ViewerSelection } from "./SplatViewerEngine";
import { PHONE_ONLINE_MS, useNow } from "./useLocalizationFeed";

export type PanelTab = "live" | "ask" | "notes" | "measure" | "waypoints" | "details";

export const NODE_TONE: Record<NavNodeKind, string> = {
  waypoint: "bg-wander-blue",
  entrance: "bg-wander-sky",
  destination: "bg-wander-pink",
};

const TABS: { id: PanelTab; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "ask", label: "Ask" },
  { id: "notes", label: "Pins" },
  { id: "measure", label: "Measure" },
  { id: "waypoints", label: "Waypoints" },
  { id: "details", label: "Details" },
];

type Props = {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  worldId: string;
  /** Phone localization feed shown in the Live tab. */
  live: LiveTabProps;
  /** Graph validator and generated-graph review shown in the Waypoints tab. */
  waypoints: WaypointsTabProps;
  name: string;
  status: WorldStatus;
  manifest: WorldManifest | null;
  splatUrl: string | null;
  numSplats: number | null;
  graph: NavigationGraph;
  notes: WorldNote[];
  measurements: Measurement[];
  selection: ViewerSelection | null;
  /** Current camera position (world frame), for the Ask tab's "what's in view" context. */
  getCameraPosition: () => Vec3 | null;
  onSelect: (sel: ViewerSelection | null) => void;
  onFocusNode: (id: string) => void;
  onFocusNote: (id: string) => void;
  onUpdateNote: (id: string, patch: Partial<Pick<WorldNote, "title" | "location" | "description">>) => void;
  onDeleteNote: (id: string) => void;
  /** Replaces the pin list after POST /api/worlds/:id/notes/auto-detect adds new pins. */
  onNotesDetected: (notes: WorldNote[]) => void;
  onStartNote: () => void;
  onStartMeasure: () => void;
  onLabelMeasurement: (id: string, label: string) => void;
  onDeleteMeasurement: (id: string) => void;
  onClearMeasurements: () => void;
  /** Opens the upload dialog for a new splat version (only when the world has a manifest). */
  onUploadSplat?: () => void;
  /** Saves the Niantic Site ID from the Details tab; resolves once the manifest is written. */
  onSaveSiteId?: (siteId: string | null) => Promise<void>;
};

/** Right-hand panel: write pins, review measurements, read the manifest and waypoints. */
export function InspectorPanel(p: Props) {
  const now = useNow(5000);
  return (
    <aside
      aria-label="World inspector"
      className="card pointer-events-auto flex max-h-full flex-col overflow-hidden p-0"
    >
      <div className="flex items-center gap-1 border-b border-hairline p-2">
        <div
          role="tablist"
          aria-label="Inspector"
          className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {TABS.map((t) => {
            const count = t.id === "notes" ? p.notes.length : t.id === "measure" ? p.measurements.length : 0;
            const latest = t.id === "live" ? p.live.feed.queries[0] : undefined;
            const phoneOnline = !!latest && now - Date.parse(latest.capturedAt) < PHONE_ONLINE_MS;
            return (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={p.tab === t.id}
                onClick={() => p.onTab(t.id)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-body-sm font-medium whitespace-nowrap transition-colors duration-200 ${
                  p.tab === t.id ? "bg-sky-tint text-wander-blue" : "text-void-black/60 hover:text-void-black"
                }`}
              >
                {t.id === "live" && (
                  <span
                    aria-hidden="true"
                    className={`inline-block size-1.5 rounded-full ${phoneOnline ? "bg-wander-blue" : "bg-void-black/20"}`}
                  />
                )}
                {t.label}
                {count > 0 && <span className="text-caption text-void-black/40">{count}</span>}
              </button>
            );
          })}
        </div>
        <button type="button" className="btn-icon size-7 shrink-0" aria-label="Close panel" onClick={p.onClose}>
          <Icon name="x" size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {p.tab === "live" && <LiveTab {...p.live} />}
        {p.tab === "ask" && (
          <AssistantPanel
            worldId={p.worldId}
            name={p.name}
            status={p.status}
            graph={p.graph}
            notes={p.notes}
            selection={p.selection}
            getCameraPosition={p.getCameraPosition}
          />
        )}
        {p.tab === "notes" && <NotesTab {...p} />}
        {p.tab === "measure" && <MeasureTab {...p} />}
        {p.tab === "waypoints" && <WaypointsTab {...p.waypoints} />}
        {p.tab === "details" && <DetailsTab {...p} />}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ notes */

function NotesTab(p: Props) {
  const selectedId = p.selection?.kind === "note" ? p.selection.id : null;
  const [detecting, setDetecting] = useState(false);
  const [detectMessage, setDetectMessage] = useState<string | null>(null);

  async function detectObjects() {
    setDetecting(true);
    setDetectMessage(null);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(p.worldId)}/notes/auto-detect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as {
        notes?: WorldNote[];
        added?: number;
        skippedDuplicates?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Could not detect objects");
      p.onNotesDetected(body.notes ?? []);
      const added = body.added ?? 0;
      setDetectMessage(
        added === 0
          ? "No new objects found — try scanning more of the room with the phone first."
          : `Added ${added} pin${added === 1 ? "" : "s"}${body.skippedDuplicates ? ` (skipped ${body.skippedDuplicates} already-known)` : ""}.`,
      );
    } catch (err) {
      setDetectMessage(err instanceof Error ? err.message : "Could not detect objects");
    } finally {
      setDetecting(false);
    }
  }

  return (
    <div className="p-3">
      <button type="button" className="btn-ghost w-full" onClick={p.onStartNote}>
        <Icon name="pin" size={15} />
        Add a pin on the scan
      </button>
      <button type="button" className="btn-ghost mt-1.5 w-full" onClick={detectObjects} disabled={detecting}>
        <Icon name="sparkle" size={15} />
        {detecting ? "Detecting objects…" : "Detect objects automatically"}
      </button>
      {detectMessage && <p className="mt-1.5 px-1 text-caption text-void-black/60">{detectMessage}</p>}

      {p.notes.length === 0 ? (
        <p className="mt-4 px-1 text-body-sm text-void-black/50">
          No pins yet. Pick the tool (or press <kbd className="rounded-sm border border-hairline px-1">3</kbd>) and
          click the scan where you want to drop a title, location and description. Pins save to the world
          automatically.
        </p>
      ) : (
        <ol className="mt-3 space-y-1">
          {p.notes.map((n, i) => {
            const isSel = n.id === selectedId;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => p.onSelect(isSel ? null : { kind: "note", id: n.id })}
                  onDoubleClick={() => p.onFocusNote(n.id)}
                  title="Click to open · double-click to fly to"
                  className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-200 ${
                    isSel ? "bg-sky-tint" : "hover:bg-void-black/5"
                  }`}
                >
                  <span className="mt-0.5 w-4 text-right text-caption text-void-black/40">{i + 1}</span>
                  <span aria-hidden="true" className="mt-1.5 inline-block size-2.5 shrink-0 rounded-full bg-wander-pink" />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-body-sm ${isSel ? "font-medium text-wander-blue" : "text-void-black/80"}`}>
                      {n.title || "Untitled pin"}
                    </span>
                    {(n.location || n.description) && !isSel && (
                      <span className="block truncate text-caption text-void-black/50">
                        {n.location ? `${n.location}${n.description ? " · " : ""}` : ""}
                        {n.description}
                      </span>
                    )}
                  </span>
                </button>
                {isSel && (
                  <NoteEditor
                    key={n.id}
                    note={n}
                    onChange={(patch) => p.onUpdateNote(n.id, patch)}
                    onFocus={() => p.onFocusNote(n.id)}
                    onDelete={() => p.onDeleteNote(n.id)}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function NoteEditor({
  note,
  onChange,
  onFocus,
  onDelete,
}: {
  note: WorldNote;
  onChange: (patch: Partial<Pick<WorldNote, "title" | "location" | "description">>) => void;
  onFocus: () => void;
  onDelete: () => void;
}) {
  // Keyed by note id in the parent, so a fresh editor mounts per note.
  const [title, setTitle] = useState(note.title);
  const [location, setLocation] = useState(note.location ?? "");
  const [description, setDescription] = useState(note.description ?? "");

  const commit = () =>
    onChange({
      title: title.trim() || "Untitled pin",
      location: location.trim() || undefined,
      description: description.trim() || undefined,
    });

  return (
    <div className="mx-2 mt-1 mb-2 space-y-2 rounded-lg border border-hairline bg-stellar-white p-2.5">
      <div>
        <label className="label text-caption text-void-black/60" htmlFor="note-title">
          Title
        </label>
        <input
          id="note-title"
          className="input mt-1 py-1 text-body-sm"
          value={title}
          placeholder="e.g. Broken handrail"
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <div>
        <label className="label text-caption text-void-black/60" htmlFor="note-location">
          Location
        </label>
        <input
          id="note-location"
          className="input mt-1 py-1 text-body-sm"
          value={location}
          placeholder="e.g. 2nd floor, outside room 204"
          onChange={(e) => setLocation(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <div>
        <label className="label text-caption text-void-black/60" htmlFor="note-description">
          Description
        </label>
        <textarea
          id="note-description"
          className="input mt-1 min-h-[72px] resize-y py-1 text-body-sm"
          value={description}
          placeholder="What should someone know at this spot?"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={commit}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-void-black/40" title="Position in the world frame (metres)">
          {note.position.map((v) => v.toFixed(2)).join(", ")}
        </span>
        <span className="flex items-center gap-1">
          <button type="button" className="btn-text px-2 py-1 text-caption" onClick={onFocus}>
            <Icon name="frame" size={13} />
            Fly to
          </button>
          <button
            type="button"
            className="btn-text px-2 py-1 text-caption text-wander-pink hover:bg-pink-tint"
            onClick={onDelete}
          >
            <Icon name="trash" size={13} />
            Delete
          </button>
        </span>
      </div>
      <p className="text-caption text-void-black/40">
        Added {new Date(note.createdAt).toLocaleString()}
        {note.updatedAt && ` · edited ${new Date(note.updatedAt).toLocaleString()}`}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- measure */

function MeasureTab(p: Props) {
  const total = p.measurements.reduce((s, m) => s + measurementLength(m), 0);
  return (
    <div className="p-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-caption text-void-black/50">
          {p.measurements.length} measurements · {formatMetres(total)} total
        </p>
        {p.measurements.length > 0 && (
          <button type="button" className="btn-text px-2 py-0.5 text-caption" onClick={p.onClearMeasurements}>
            Clear all
          </button>
        )}
      </div>
      <button type="button" className="btn-ghost mt-3 w-full" onClick={p.onStartMeasure}>
        <Icon name="ruler" size={15} />
        Measure a distance
      </button>
      {p.measurements.length === 0 ? (
        <p className="mt-4 px-1 text-body-sm text-void-black/50">
          Click two points on the scan to measure the straight-line distance between them — door widths,
          corridor lengths, step heights. Distances are in metres.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {p.measurements.map((m, i) => (
            <li key={m.id} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-void-black/5">
              <span className="w-4 text-right text-caption text-void-black/40">{i + 1}</span>
              <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-wander-sky" />
              <input
                aria-label={`Label for measurement ${i + 1}`}
                className="min-w-0 flex-1 rounded-sm bg-transparent px-1 py-0.5 text-body-sm text-void-black placeholder:text-void-black/40 focus:bg-pure-white focus:outline-none focus:ring-2 focus:ring-wander-blue/20"
                placeholder="Add a label"
                defaultValue={m.label ?? ""}
                key={`${m.id}-${m.label ?? ""}`}
                onBlur={(e) => e.target.value.trim() !== (m.label ?? "") && p.onLabelMeasurement(m.id, e.target.value.trim())}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
              <span className="text-body-sm font-medium text-void-black tabular-nums">
                {formatMetres(measurementLength(m))}
              </span>
              <button
                type="button"
                className="btn-icon size-6"
                aria-label="Delete measurement"
                onClick={() => p.onDeleteMeasurement(m.id)}
              >
                <Icon name="trash" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- details */

function DetailsTab({
  name,
  status,
  manifest,
  splatUrl,
  numSplats,
  graph,
  selection,
  onSelect,
  onFocusNode,
  onUploadSplat,
  onSaveSiteId,
}: Props) {
  const meta = STATUS_META[status];
  const splatFile = manifest?.assets.splat.split("/").pop();
  const meshFile = manifest?.assets.mesh?.split("/").pop();
  const selectedNode = selection?.kind === "node" ? selection.id : null;
  return (
    <div>
      <div className="border-b border-hairline p-4">
        <span className={`pill-sm ${meta.className}`}>{meta.label}</span>
        <h2 className="mt-2 text-heading-sm font-bold text-void-black">{name}</h2>
        {manifest?.description && <p className="mt-1 text-body-sm text-slate">{manifest.description}</p>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-b border-hairline p-4 text-body-sm">
        <Row label="Version">{manifest?.version ?? "—"}</Row>
        <Row label="Splat">
          {splatFile ? (
            <span title={manifest?.assets.splat} className="break-all">
              {splatFile}
            </span>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Splats">{formatSplatCount(numSplats ?? manifest?.stats?.splatCount)}</Row>
        <Row label="Mesh">
          {meshFile ? (
            <span title={manifest?.assets.mesh} className="break-all">
              {meshFile}
            </span>
          ) : (
            <span className="text-void-black/40">None</span>
          )}
        </Row>
        <Row label="Frame">
          {manifest?.alignment?.frame ?? <span className="text-void-black/40">Unaligned</span>}
        </Row>
        <Row label="Site ID">
          {manifest && onSaveSiteId ? (
            <SiteIdField key={manifest.nianticSiteId ?? ""} value={manifest.nianticSiteId} onSave={onSaveSiteId} />
          ) : (
            manifest?.nianticSiteId ?? <span className="text-void-black/40">Not set</span>
          )}
        </Row>
        {manifest?.stats?.captureApp && <Row label="Captured with">{manifest.stats.captureApp}</Row>}
        {manifest?.updatedAt && <Row label="Updated">{new Date(manifest.updatedAt).toLocaleString()}</Row>}
      </dl>

      <div className="p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-caption font-semibold tracking-[0.01em] text-void-black/50 uppercase">Waypoints</h3>
          {graph.nodes.length > 0 && (
            <span className="text-caption text-void-black/40">
              {graph.nodes.length} · {Math.round(graphLengthMetres(graph))} m
            </span>
          )}
        </div>
        {graph.nodes.length === 0 ? (
          <p className="mt-2 text-body-sm text-void-black/50">
            No navigation graph on this world yet. It comes from <code>navigationGraph</code> in world.json.
          </p>
        ) : (
          <ol className="mt-2 space-y-0.5">
            {graph.nodes.map((n, i) => {
              const isSel = n.id === selectedNode;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(isSel ? null : { kind: "node", id: n.id })}
                    onDoubleClick={() => onFocusNode(n.id)}
                    title="Click to select · double-click to fly to"
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-body-sm transition-colors duration-200 ${
                      isSel ? "bg-sky-tint text-wander-blue" : "text-void-black/80 hover:bg-void-black/5 hover:text-void-black"
                    }`}
                  >
                    <span className="w-4 text-right text-caption text-void-black/40">{i + 1}</span>
                    <span aria-hidden="true" className={`inline-block size-2.5 rounded-full ${NODE_TONE[n.kind ?? "waypoint"]}`} />
                    <span className="flex-1 truncate">{n.name ?? n.id}</span>
                    {n.kind && n.kind !== "waypoint" && (
                      <span className="text-caption text-void-black/40 capitalize">{n.kind}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {(splatUrl || (manifest && onUploadSplat)) && (
        <div className="flex flex-col gap-2 border-t border-hairline p-3">
          {manifest && onUploadSplat && (
            <button type="button" className="btn-ghost w-full" onClick={onUploadSplat}>
              <Icon name="upload" size={15} />
              Upload new splat version
            </button>
          )}
          {splatUrl && (
            <a href={splatUrl} download={splatFile} className="btn-text w-full">
              <Icon name="download" size={15} />
              Download {splatFile ?? "splat"}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Niantic Scaniverse Site the phone localizes against. It is what ties this world to a
 * real building, so a world without one stays "processing" and the connect QR carries no site.
 */
function SiteIdField({
  value,
  onSave,
}: {
  value: string | null;
  onSave: (siteId: string | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const trimmed = draft.trim();
  const changed = trimmed !== (value ?? "");

  const commit = async () => {
    if (!changed || state === "saving") return;
    setState("saving");
    setError(null);
    try {
      await onSave(trimmed || null);
      setState("idle");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Could not save the Site ID");
    }
  };

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input
          id="world-site-id"
          className="input min-w-0 flex-1 py-1 font-mono text-body-sm"
          value={draft}
          placeholder="Not set"
          spellCheck={false}
          autoComplete="off"
          aria-label="Niantic Site ID"
          aria-describedby="world-site-id-hint"
          disabled={state === "saving"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") setDraft(value ?? "");
          }}
        />
        {changed && (
          <button
            type="button"
            className="btn-text shrink-0 px-2 py-1 text-caption"
            onClick={() => void commit()}
            disabled={state === "saving"}
          >
            {state === "saving" ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      <p id="world-site-id-hint" className="mt-1 text-caption text-void-black/50" role={error ? "alert" : undefined}>
        {error ?? "Scaniverse Site the phone aligns to. Enter to save."}
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-void-black/50">{label}</dt>
      <dd className="min-w-0 text-void-black">{children}</dd>
    </>
  );
}
