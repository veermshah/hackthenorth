"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { LogoMark } from "@/components/Logo";
import { ConnectPhoneDialog, type ConnectPhoneInfo } from "@/components/worlds/ConnectPhoneQR";
import { UploadSplatDialog } from "@/components/worlds/UploadSplatDialog";
import {
  formatAge,
  queryImageUrl,
  queryOutcome,
  querySucceeded,
  type LocalizationQuery,
} from "@/lib/localization";
import {
  assetUrl,
  EMPTY_GRAPH,
  formatSplatCount,
  isAutoDetectedNote,
  type Measurement,
  type NavigationGraph,
  type Vec3,
  type WorldManifest,
  type WorldNote,
} from "@/lib/world-manifest";
import { STATUS_META, type WorldStatus } from "@/lib/worlds";
import { InspectorPanel, type PanelTab } from "./InspectorPanel";
import { LayerToggle } from "./LayerToggle";
import type { FollowMode, LocalizationMarker, ViewerMode, ViewerSelection, ViewerTool } from "./SplatViewerEngine";
import { PHONE_ONLINE_MS, useLocalizationFeed, useNow } from "./useLocalizationFeed";
import { useMeshTools } from "./useMeshTools";
import { useSplatViewer, type PickHandler } from "./useSplatViewer";
import { ViewerOverlay } from "./ViewerOverlays";
import { useAutosave } from "./useAutosave";
import type { SaveState } from "@/lib/autosave";

type Props = {
  worldId: string;
  name: string;
  status: WorldStatus;
  manifest: WorldManifest | null;
  /** Same-origin URL of the splat (via /api/worlds), or null when nothing is uploaded yet. */
  splatUrl: string | null;
  initialNotes: WorldNote[];
  initialMeasurements: Measurement[];
  /** Recent VPS image queries from the phone, newest first (the client keeps polling for more). */
  initialLocalizations: LocalizationQuery[];
  /** Worlds API base URL for the connect QR code; null in local mode. */
  phoneBackendUrl: string | null;
  /** Where the server is reading worlds from; only changes the empty-state hint. */
  source: "api" | "local";
};

/** A query newer than this at page load opens the Live tab first. */
const RECENT_MS = 60_000;
const TRAIL_LENGTH = 30;

const MODES: { id: ViewerMode; label: string; icon: IconName }[] = [
  { id: "orbit", label: "Orbit", icon: "orbit" },
  { id: "walk", label: "Walk", icon: "walk" },
];

const TOOLS: { id: ViewerTool; label: string; icon: IconName; key: string }[] = [
  { id: "navigate", label: "Navigate", icon: "pointer", key: "1" },
  { id: "measure", label: "Measure", icon: "ruler", key: "2" },
  { id: "note", label: "Add pin", icon: "pin", key: "3" },
];

const isEditing = () => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
};

/**
 * Full-viewport world editor: the splat canvas fills the page; a floating
 * header, a bottom tool dock and a collapsible inspector sit on top. Pins and
 * measurements live here, are pushed into the engine via the hook, and
 * autosave to the world through /api/worlds.
 */
export function WorldViewer({
  worldId,
  name,
  status,
  manifest,
  splatUrl,
  initialNotes,
  initialMeasurements,
  initialLocalizations,
  phoneBackendUrl,
  source,
}: Props) {
  /* ------------------------------------------------------------ edit state */
  // A graph written from the Waypoints tab shows immediately; the server copy takes over on the next refresh.
  const [saved, setSaved] = useState<{ graph: NavigationGraph; over: WorldManifest | null } | null>(null);
  const graph = useMemo<NavigationGraph>(
    () => (saved && saved.over === manifest ? saved.graph : manifest?.navigationGraph ?? EMPTY_GRAPH),
    [saved, manifest],
  );
  const setSavedGraph = useCallback((next: NavigationGraph) => setSaved({ graph: next, over: manifest }), [manifest]);
  const meshTools = useMeshTools(worldId, manifest, graph);
  const meshUrl = manifest?.assets.mesh ? assetUrl(manifest.assets.mesh) : null;
  /** What the engine draws: the generated proposal while it is being previewed, else the live graph. */
  const shownGraph = meshTools.preview && meshTools.proposal ? meshTools.proposal.graph : graph;
  const [notes, setNotes] = useState(initialNotes);
  const knownNoteIds = useRef(new Set(initialNotes.map((note) => note.id)));
  /** Auto-detected pins arrive by the dozen; hiding them clears the scan without deleting them. */
  const [hideAutoNotes, setHideAutoNotes] = useState(false);
  const autoNoteCount = useMemo(() => notes.filter(isAutoDetectedNote).length, [notes]);
  /** What the engine pins to the scan — the list in the panel still shows every note. */
  const shownNotes = useMemo(
    () => (hideAutoNotes ? notes.filter((n) => !isAutoDetectedNote(n)) : notes),
    [notes, hideAutoNotes],
  );
  const [measurements, setMeasurements] = useState(initialMeasurements);
  const [selection, setSelection] = useState<ViewerSelection | null>(null);
  const [pendingPoint, setPendingPoint] = useState<Vec3 | null>(null);

  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>(() =>
    initialLocalizations[0] && Date.now() - Date.parse(initialLocalizations[0].capturedAt) < RECENT_MS ? "live" : "notes",
  );
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const router = useRouter();

  const canSave = !!manifest;
  /**
   * Write the Niantic Site ID onto the manifest. A world with a site is "aligned"; without one
   * it is still "processing", matching what the upload dialog does on create. `router.refresh()`
   * re-reads the manifest so the status pill and the connect QR pick it up.
   */
  const saveSiteId = useCallback(
    async (siteId: string | null) => {
      const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nianticSiteId: siteId, status: siteId ? "aligned" : "processing" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Could not save the Site ID (${res.status})`);
      }
      setNotice({ tone: "ok", text: siteId ? "Site ID saved" : "Site ID cleared" });
      router.refresh();
    },
    [worldId, router],
  );
  /** What the connect QR encodes; only worlds with a manifest can be handed to a phone. */
  const connectInfo = useMemo<ConnectPhoneInfo | null>(
    () => (manifest ? { worldId, name, nianticSiteId: manifest.nianticSiteId, backendUrl: phoneBackendUrl } : null),
    [manifest, worldId, name, phoneBackendUrl],
  );

  /* ---------------------------------------------------------- phone feed */
  // Only worlds with a manifest can have a phone localizing into them.
  const feed = useLocalizationFeed(worldId, initialLocalizations, !!manifest);
  /** null = pin to the newest query as it arrives; an id = the user is inspecting an older one. */
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null);
  /** null until someone picks a camera by hand (or the engine hands it back); see `followMode`. */
  const [followChoice, setFollowChoice] = useState<FollowMode | null>(null);
  const latestQuery = feed.queries[0] ?? null;
  const selectedQuery = useMemo(
    () => (selectedQueryId ? feed.queries.find((q) => q.id === selectedQueryId) ?? latestQuery : latestQuery),
    [feed.queries, selectedQueryId, latestQuery],
  );

  // The marker is the selected query's pose — or, for a failed query without one, the
  // newest localized pose so the phone never vanishes from the splat mid-walk.
  const localization = useMemo<LocalizationMarker | null>(() => {
    if (!selectedQuery) return null;
    const outcome = queryOutcome(selectedQuery);
    const poseSource = selectedQuery.result.pose
      ? selectedQuery
      : feed.queries.find((q) => q.result.pose && querySucceeded(q));
    const pose = poseSource?.result.pose;
    if (!pose) return null;
    return {
      position: pose.position,
      rotation: pose.rotation,
      imageUrl: queryImageUrl(selectedQuery),
      orientation: selectedQuery.image.orientation ?? "portrait",
      fovDeg: selectedQuery.image.fovDeg ?? { horizontal: 50, vertical: 65 },
      tone: poseSource === selectedQuery ? outcome.tone : "bad",
    };
  }, [selectedQuery, feed.queries]);

  /**
   * Opening Live while a phone is actually walking drops the camera in behind
   * it, so the tab lands on the walk in progress rather than on whatever corner
   * the viewer was last parked in. The moment anyone touches the camera —
   * a drag, the wheel, WASD, or these buttons — `followChoice` takes over for good.
   * Freshness comes off the feed's own clock, so this needs no ticking timer.
   */
  const phoneOnline =
    !!latestQuery && !!feed.fetchedAt && feed.fetchedAt - Date.parse(latestQuery.capturedAt) < PHONE_ONLINE_MS;
  const followMode: FollowMode =
    followChoice ?? (panelTab === "live" && phoneOnline && splatUrl ? "chase" : "off");

  const localizationTrail = useMemo<Vec3[]>(
    () =>
      feed.queries
        .filter(querySucceeded)
        .flatMap((q) => (q.result.pose ? [q.result.pose.position] : []))
        .slice(0, TRAIL_LENGTH),
    [feed.queries],
  );

  /* -------------------------------------------------------------- autosave */
  const notesSave = useAutosave(`/api/worlds/${encodeURIComponent(worldId)}/notes`, { notes }, canSave);
  const measureSave = useAutosave(
    `/api/worlds/${encodeURIComponent(worldId)}/measurements`,
    { measurements },
    canSave,
  );
  const save = combineSave(notesSave.state, measureSave.state);
  const dirty = save.status !== "clean" && save.status !== "saved";

  /* ------------------------------------------------------------ mutations */
  const addNote = useCallback((position: Vec3) => {
    const id = `note-${crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
    knownNoteIds.current.add(id);
    setNotes((list) => [
      ...list,
      { id, title: `Pin ${list.length + 1}`, position, createdAt: new Date().toISOString() },
    ]);
    setSelection({ kind: "note", id });
    setPanelOpen(true);
    setPanelTab("notes");
  }, []);

  const updateNote = useCallback(
    (id: string, patch: Partial<Pick<WorldNote, "title" | "location" | "description">>) =>
      setNotes((list) =>
        list.map((n) => {
          if (n.id !== id) return n;
          const next = { ...n, ...patch };
          const changed = (["title", "location", "description"] as const).some((k) => next[k] !== n[k]);
          return changed ? { ...next, updatedAt: new Date().toISOString() } : n;
        }),
      ),
    [],
  );

  const deleteNote = useCallback((id: string) => {
    setNotes((list) => list.filter((n) => n.id !== id));
    setSelection((s) => (s?.kind === "note" && s.id === id ? null : s));
  }, []);

  const addMeasurement = useCallback((a: Vec3, b: Vec3) => {
    setMeasurements((list) => [
      ...list,
      { id: `m-${crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`, points: [a, b], createdAt: new Date().toISOString() },
    ]);
    setPanelTab("measure");
  }, []);

  /* --------------------------------------------------------------- viewer */
  const onPick = useCallback<PickHandler>(
    (e) => {
      if (e.type === "pick-note") {
        setSelection((s) => (s?.kind === "note" && s.id === e.id && e.tool === "navigate" ? null : { kind: "note", id: e.id }));
        setPanelOpen(true);
        setPanelTab("notes");
        return;
      }
      if (e.type === "pick-node") {
        setSelection((s) => (s?.kind === "node" && s.id === e.id ? null : { kind: "node", id: e.id }));
        setPanelTab("details");
        return;
      }
      if (e.type === "pick-miss") {
        if (e.tool === "navigate") setSelection(null);
        else setNotice({ tone: "error", text: "Click on the scan itself — that spot has no surface." });
        return;
      }
      if (e.tool === "note") addNote(e.point);
      else if (e.tool === "measure") {
        if (pendingPoint) {
          if (Math.hypot(...pendingPoint.map((v, i) => v - e.point[i])) < 0.001) {
            setNotice({ tone: "error", text: "Choose a different second point to measure a distance." });
            return;
          }
          addMeasurement(pendingPoint, e.point);
          setPendingPoint(null);
        } else setPendingPoint(e.point);
      }
    },
    [addNote, addMeasurement, pendingPoint],
  );

  const { containerRef, state, api, focusViewer } = useSplatViewer({
    splatUrl,
    meshUrl,
    meshFrame: manifest?.meshFrame ?? "world",
    alignment: manifest?.alignment,
    graph: shownGraph,
    graphFlags: meshTools.flags,
    notes: shownNotes,
    measurements,
    selection,
    pendingPoint,
    localization,
    localizationTrail,
    followMode,
    onFollowModeChange: setFollowChoice,
    onPick,
  });

  const openLive = useCallback(() => {
    setPanelOpen(true);
    setPanelTab("live");
  }, []);


  const pickTool = useCallback(
    (tool: ViewerTool) => {
      api.setTool(tool);
      setSelection(null);
      if (tool !== "measure") setPendingPoint(null);
      if (tool === "note" || tool === "measure") {
        setPanelOpen(true);
        setPanelTab(tool === "note" ? "notes" : "measure");
        setFollowChoice("off");
      }
      focusViewer();
    },
    [api, focusViewer],
  );

  /* ------------------------------------------------------------ keyboard */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditing()) return;
      if (e.key === "Escape") {
        if (pendingPoint) setPendingPoint(null);
        else if (state.tool !== "navigate") pickTool("navigate");
        else if (selection) setSelection(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selection?.kind === "note") {
        e.preventDefault();
        deleteNote(selection.id);
        return;
      }
      const tool = TOOLS.find((t) => t.key === e.key);
      if (tool) pickTool(tool.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingPoint, selection, state.tool, pickTool, deleteNote]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.tone === "ok" ? 2500 : 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // Warn before leaving while a save is still pending.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  /* ---------------------------------------------------------------- render */
  const interactive = state.status === "ready" || state.status === "empty" || state.mesh.status === "ready";
  const meta = STATUS_META[status];
  const hint = hintFor(state.tool, state.mode, !!pendingPoint);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-wander-navy">
      <div
        ref={containerRef}
        role="application"
        aria-label={`${name} — 3D scene`}
        aria-busy={state.status === "loading" || state.status === "booting"}
        tabIndex={0}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-wander-blue"
      />

      {/* Header */}
      <header className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2">
        <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-hairline bg-pure-white p-1 pr-3">
          <Link href="/dashboard" className="btn-icon size-7" aria-label="Back to worlds">
            <Icon name="arrowLeft" size={16} />
          </Link>
          <LogoMark size={20} />
          <span className="max-w-[40vw] truncate text-body-sm font-semibold text-void-black">{name}</span>
          <span className={`pill-sm ml-1 ${meta.className}`}>{meta.label}</span>
          <SaveBadge
            save={save}
            canSave={canSave}
            onRetry={() => {
              notesSave.retry();
              measureSave.retry();
            }}
          />
          {latestQuery && <PhoneBadge query={latestQuery} onClick={openLive} />}
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          <div
            role="radiogroup"
            aria-label="Camera mode"
            className="flex items-center gap-0.5 rounded-lg border border-hairline bg-pure-white p-0.5"
          >
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={state.mode === m.id}
                disabled={!interactive}
                onClick={() => {
                  api.setMode(m.id);
                  focusViewer();
                }}
                className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-body-sm font-medium transition-colors duration-200 disabled:opacity-50 ${
                  state.mode === m.id ? "bg-sky-tint text-wander-blue" : "text-void-black/60 hover:text-void-black"
                }`}
              >
                <Icon name={m.icon} size={15} />
                <span className="hidden sm:inline">{m.label}</span>
              </button>
            ))}
          </div>
          {meshUrl && (
            <LayerToggle
              layer={state.layer}
              onLayer={(next) => {
                api.setLayer(next);
                focusViewer();
              }}
              hasSplat={!!splatUrl}
              meshReady={state.mesh.status === "ready"}
              disabled={!interactive}
              compact
            />
          )}
          <div className="flex items-center gap-0.5 rounded-lg border border-hairline bg-pure-white p-0.5">
            {connectInfo && (
              <ToolButton icon="phone" label="Connect a phone (QR code)" onClick={() => setConnectOpen(true)} />
            )}
            <ToolButton icon="frame" label="Reset view" disabled={!interactive} onClick={api.resetView} />
            {shownGraph.nodes.length > 0 && (
              <ToolButton
                icon="route"
                label={state.showGraph ? "Hide waypoints" : "Show waypoints"}
                pressed={state.showGraph}
                disabled={!interactive}
                onClick={() => api.setShowGraph(!state.showGraph)}
              />
            )}
            <ToolButton
              icon="panelRight"
              label={panelOpen ? "Hide inspector" : "Show inspector"}
              pressed={panelOpen}
              onClick={() => setPanelOpen((v) => !v)}
            />
          </div>
        </div>
      </header>

      {/* Inspector */}
      {panelOpen && (
        <div className="pointer-events-none absolute inset-x-3 top-16 bottom-20 flex justify-end lg:inset-x-auto lg:right-3">
          <div className="flex max-h-full w-full lg:w-[380px]">
            <InspectorPanel
              tab={panelTab}
              onTab={setPanelTab}
              onClose={() => setPanelOpen(false)}
              worldId={worldId}
              live={{
                feed,
                selected: selectedQuery,
                pinnedToLatest: selectedQueryId === null,
                onSelectQuery: setSelectedQueryId,
                followMode,
                onFollowMode: (mode: FollowMode) => {
                  setFollowChoice(mode);
                  focusViewer();
                },
                onFocusPhone: () => {
                  setFollowChoice("off");
                  api.focusPhone();
                  focusViewer();
                },
                hasSplat: state.status === "ready",
                connectInfo,
                onConnectPhone: () => setConnectOpen(true),
              }}
              waypoints={{
                manifest,
                graph,
                tools: meshTools,
                selection,
                onSelect: setSelection,
                onFocusNode: (id) => {
                  api.focusNode(id);
                  focusViewer();
                },
                onGraphSaved: (next, text) => {
                  setSavedGraph(next.navigationGraph ?? EMPTY_GRAPH);
                  setNotice({ tone: "ok", text });
                  router.refresh();
                },
                onUploadMesh: manifest ? () => setUploadOpen(true) : undefined,
                source,
              }}
              name={name}
              status={status}
              manifest={manifest}
              splatUrl={splatUrl}
              numSplats={state.numSplats}
              graph={shownGraph}
              notes={notes}
              autoNoteCount={autoNoteCount}
              hideAutoNotes={hideAutoNotes}
              onHideAutoNotes={setHideAutoNotes}
              measurements={measurements}
              selection={selection}
              getCameraPosition={api.getCameraPosition}
              onSelect={setSelection}
              onFocusNode={(id) => {
                api.focusNode(id);
                focusViewer();
              }}
              onFocusNote={(id) => {
                api.focusNote(id);
                focusViewer();
              }}
              onUpdateNote={updateNote}
              onDeleteNote={deleteNote}
              onBeforeDetectNotes={notesSave.flush}
              onNotesDetected={(detected) => {
                // Detection returns a server snapshot. Preserve edits and deletions made
                // while it was running, and append only previously unseen pins.
                const added = detected.filter((note) => !knownNoteIds.current.has(note.id));
                for (const note of added) knownNoteIds.current.add(note.id);
                setNotes((current) => [...current, ...added]);
                // Someone who just asked for a detection wants to see its pins, hidden or not.
                if (added.length) setHideAutoNotes(false);
              }}
              onStartNote={() => pickTool("note")}
              onStartMeasure={() => pickTool("measure")}
              onLabelMeasurement={(id, label) =>
                setMeasurements((list) => list.map((m) => (m.id === id ? { ...m, label: label || undefined } : m)))
              }
              onDeleteMeasurement={(id) => setMeasurements((list) => list.filter((m) => m.id !== id))}
              onClearMeasurements={() => {
                setMeasurements([]);
                setPendingPoint(null);
              }}
              onUploadSplat={manifest ? () => setUploadOpen(true) : undefined}
              onSaveSiteId={manifest ? saveSiteId : undefined}
            />
          </div>
        </div>
      )}

      {/* Bottom bar: hint pinned left, stats pinned right, tool dock truly centred regardless of their widths */}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-2">
        <span className="hidden max-w-[26vw] rounded-lg border border-hairline bg-pure-white/90 px-2.5 py-1 text-caption text-void-black/70 md:block">
          {interactive ? hint : "\u00a0"}
        </span>

        <div className="pointer-events-auto absolute bottom-0 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-hairline bg-pure-white p-1">
          <div role="radiogroup" aria-label="Tool" className="flex items-center gap-0.5">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={state.tool === t.id}
                aria-keyshortcuts={t.key}
                title={`${t.label} (${t.key})`}
                disabled={!interactive}
                onClick={() => pickTool(t.id)}
                className={`inline-flex flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-caption font-medium transition-colors duration-200 disabled:opacity-50 ${
                  state.tool === t.id ? "bg-sky-tint text-wander-blue" : "text-void-black/60 hover:bg-void-black/5 hover:text-void-black"
                }`}
              >
                <Icon name={t.icon} size={17} />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <span className="pill hidden bg-pure-white/90 text-void-black/80 md:inline-flex">
          {state.status === "ready" ? `${formatSplatCount(state.numSplats ?? manifest?.stats?.splatCount)} splats` : "—"}
        </span>
      </div>

      {meshTools.preview && (
        <div
          role="status"
          className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2 rounded-lg border border-transparent bg-pink-tint px-3 py-1.5 text-body-sm font-medium text-wander-pink"
        >
          Previewing generated waypoints — not saved
        </div>
      )}

      {notice && (
        <div
          role="status"
          className={`pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2 rounded-lg border px-3 py-1.5 text-body-sm font-medium ${
            notice.tone === "ok"
              ? "border-transparent bg-sky-tint text-wander-blue"
              : "border-transparent bg-wander-pink text-pure-white"
          }`}
        >
          {notice.text}
        </div>
      )}

      <ViewerOverlay
        state={state}
        api={api}
        name={name}
        worldId={worldId}
        manifest={manifest}
        source={source}
        onUpload={manifest ? () => setUploadOpen(true) : undefined}
      />

      {connectInfo && <ConnectPhoneDialog open={connectOpen} info={connectInfo} onClose={() => setConnectOpen(false)} />}

      {manifest && (
        <UploadSplatDialog
          open={uploadOpen}
          mode={{ kind: "existing", manifest }}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setNotice({ tone: "ok", text: "Upload saved — reloading the scene" });
            router.refresh(); // re-reads the manifest; a new splat / mesh path remounts the engine
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- pieces */

function SaveBadge({ save, canSave, onRetry }: { save: SaveState; canSave: boolean; onRetry: () => void }) {
  if (!canSave)
    return (
      <span className="pill-sm bg-stellar-white text-void-black/60" title="Add world.json to this world to persist pins">
        Not saved · no world.json
      </span>
    );
  switch (save.status) {
    case "dirty":
    case "saving":
      return <span className="pill-sm bg-pink-tint text-wander-pink">Saving…</span>;
    case "saved":
      return (
        <span className="pill-sm bg-sky-tint text-wander-blue">
          <Icon name="check" size={11} />
          Saved
        </span>
      );
    case "error":
      return (
        <button type="button" onClick={onRetry} className="pill-sm bg-wander-pink text-pure-white" title={save.error}>
          Save failed · retry
        </button>
      );
    default:
      return null;
  }
}

/** Header pill: is a phone localizing into this world right now, and how did its last query go? */
function PhoneBadge({ query, onClick }: { query: LocalizationQuery; onClick: () => void }) {
  const now = useNow(1000);
  const online = now - Date.parse(query.capturedAt) < PHONE_ONLINE_MS;
  const outcome = queryOutcome(query);
  const tone = !online ? "bg-stellar-white text-void-black/60" : outcome.tone === "ok" ? "bg-sky-tint text-wander-blue" : "bg-pink-tint text-wander-pink";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pill-sm ${tone} transition-colors duration-200`}
      title={`${outcome.label} · ${formatAge(query.capturedAt, now)} · open Live tab`}
    >
      <Icon name="phone" size={11} />
      {online ? outcome.label : `Phone · ${formatAge(query.capturedAt, now)}`}
    </button>
  );
}

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex size-7 items-center justify-center rounded-[6px] transition-colors duration-200 disabled:opacity-50 ${
        pressed ? "bg-sky-tint text-wander-blue" : "text-void-black/60 hover:text-void-black"
      }`}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

const MOVE_HINT = "W A S D move · Q / E height · Arrows turn · Shift hurry";

function hintFor(tool: ViewerTool, mode: ViewerMode, pending: boolean): string {
  if (tool === "measure") return pending ? "Click the second point · Esc cancels" : "Click a point on the scan to start measuring";
  if (tool === "note") return "Click the scan to drop a pin · Esc to finish";
  return mode === "walk" ? MOVE_HINT : `Drag to orbit · Scroll to zoom · ${MOVE_HINT}`;
}

/* -------------------------------------------------------------- autosave */

function combineSave(a: SaveState, b: SaveState): SaveState {
  const order: SaveState["status"][] = ["error", "saving", "dirty", "saved", "clean"];
  for (const s of order) {
    if (a.status === s) return a;
    if (b.status === s) return b;
  }
  return a;
}
