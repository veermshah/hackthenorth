"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Alignment, Measurement, NavigationGraph, Vec3, WorldNote } from "@/lib/world-manifest";
import type {
  EngineEvent,
  FollowMode,
  LoadStatus,
  LocalizationMarker,
  MeshStatus,
  SplatViewerEngine,
  ViewerLayer,
  ViewerMode,
  ViewerSelection,
  ViewerTool,
} from "./SplatViewerEngine";

export type ViewerStatus = "booting" | "unsupported" | LoadStatus;

export type ViewerState = {
  status: ViewerStatus;
  error: string | null;
  progress: { loaded: number; total: number } | null;
  numSplats: number | null;
  mode: ViewerMode;
  tool: ViewerTool;
  showGraph: boolean;
  /** Collision-mesh layer (`assets.mesh`): load state, independent of whether it is the drawn layer. */
  mesh: { status: MeshStatus; triangles: number | null; error: string | null };
  /** Which scan the canvas draws — the splat or the mesh. */
  layer: ViewerLayer;
};

export type ViewerApi = {
  setMode: (mode: ViewerMode) => void;
  setTool: (tool: ViewerTool) => void;
  setShowGraph: (visible: boolean) => void;
  setLayer: (layer: ViewerLayer) => void;
  resetView: () => void;
  focusNode: (id: string) => void;
  focusNote: (id: string) => void;
  /** Orbit the camera around the phone marker. */
  focusPhone: () => void;
  retry: () => void;
  /** Current camera position (world frame), or null before the engine has mounted —
   * for describing what's in view, independent of any phone/localization pose. */
  getCameraPosition: () => Vec3 | null;
};

/** Interaction events forwarded from the engine to whoever owns the data. */
export type PickHandler = (
  e:
    | { type: "pick"; tool: ViewerTool; point: Vec3; graphPoint: Vec3; surface: "mesh" | "splat" }
    | { type: "pick-node"; tool: ViewerTool; id: string }
    | { type: "pick-note"; tool: ViewerTool; id: string }
    | { type: "pick-miss"; tool: ViewerTool },
) => void;

type Options = {
  splatUrl: string | null;
  meshUrl?: string | null;
  meshFrame?: "world" | "splat";
  alignment?: Alignment;
  /** Data the engine renders; owned by the caller. */
  graph: NavigationGraph;
  /** Node ids and "from|to" edge keys to draw as rejected (pink). */
  graphFlags?: { nodes: Set<string>; edges: Set<string> };
  notes: WorldNote[];
  measurements: Measurement[];
  selection: ViewerSelection | null;
  pendingPoint: Vec3 | null;
  /** Phone marker for the selected VPS image query; null hides it. */
  localization: LocalizationMarker | null;
  /** Recent localized positions, newest first. */
  localizationTrail: Vec3[];
  /** How the camera rides along with the phone on the Live tab. */
  followMode: FollowMode;
  /** The engine hands the camera back (drag / wheel / WASD) by reporting "off" here. */
  onFollowModeChange: (mode: FollowMode) => void;
  onPick: PickHandler;
};

const INITIAL: ViewerState = {
  status: "booting",
  error: null,
  progress: null,
  numSplats: null,
  mode: "orbit",
  tool: "navigate",
  showGraph: true,
  mesh: { status: "none", triangles: null, error: null },
  layer: "splat",
};

/**
 * Mounts a `SplatViewerEngine` into the returned container ref and keeps it in
 * sync with the caller's graph / notes / measurement / selection state.
 * Three.js and Spark are imported lazily inside the effect so the page still
 * server-renders and the ~3 MB renderer bundle only ships to browsers that
 * open a world.
 */
export function useSplatViewer({
  splatUrl,
  meshUrl = null,
  meshFrame = "world",
  alignment,
  graph,
  graphFlags,
  notes,
  measurements,
  selection,
  pendingPoint,
  localization,
  localizationTrail,
  followMode,
  onFollowModeChange,
  onPick,
}: Options) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SplatViewerEngine | null>(null);
  // A world with a mesh but no splat has only one layer worth showing; start on it.
  const initialLayer: ViewerLayer = splatUrl ? "splat" : "mesh";
  const [state, setState] = useState<ViewerState>(() => ({ ...INITIAL, layer: initialLayer }));
  const [attempt, setAttempt] = useState(0);
  const [engineReady, setEngineReady] = useState(0);

  // Server props are plain data; key the effect on their content (not identity)
  // so a router refresh doesn't tear down the renderer and re-download the splat.
  const alignmentKey = useMemo(() => JSON.stringify(alignment ?? null), [alignment]);
  // Latest UI toggles / callbacks, read by the engine when it (re)mounts and by event handlers.
  const latest = useRef({
    mode: INITIAL.mode,
    tool: INITIAL.tool,
    showGraph: INITIAL.showGraph,
    layer: initialLayer,
    onPick,
    onFollowModeChange,
  });
  useEffect(() => {
    latest.current.onPick = onPick;
    latest.current.onFollowModeChange = onFollowModeChange;
  }, [onPick, onFollowModeChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let engine: SplatViewerEngine | null = null;
    const alignment = JSON.parse(alignmentKey) as Alignment | null;

    setState((s) => ({ ...s, status: "booting", error: null, progress: null, numSplats: null, mesh: INITIAL.mesh }));

    const onEvent = (e: EngineEvent) => {
      switch (e.type) {
        case "status":
          return setState((s) => ({ ...s, status: e.status, error: e.error ?? null }));
        case "progress":
          return setState((s) => ({ ...s, progress: { loaded: e.loaded, total: e.total } }));
        case "loaded":
          return setState((s) => ({ ...s, numSplats: e.numSplats }));
        case "mesh":
          return setState((s) => ({
            ...s,
            mesh: { status: e.status, triangles: e.triangles ?? null, error: e.error ?? null },
          }));
        case "follow":
          return latest.current.onFollowModeChange(e.mode);
        default:
          return latest.current.onPick(e);
      }
    };

    import("./SplatViewerEngine")
      .then((mod) => {
        if (cancelled) return;
        if (!mod.supportsWebGL2()) {
          setState((s) => ({ ...s, status: "unsupported" }));
          return;
        }
        engine = new mod.SplatViewerEngine({
          container,
          splatUrl,
          meshUrl,
          meshFrame,
          alignment: alignment ?? undefined,
          onEvent,
        });
        engine.setMode(latest.current.mode);
        engine.setTool(latest.current.tool);
        engine.setShowGraph(latest.current.showGraph);
        engine.setLayer(latest.current.layer);
        engineRef.current = engine;
        setEngineReady((n) => n + 1); // re-run the data sync effects below
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          status: "error",
          error: err instanceof Error ? err.message : "Failed to start the viewer.",
        }));
      });

    return () => {
      cancelled = true;
      engine?.dispose();
      engineRef.current = null;
    };
  }, [splatUrl, meshUrl, meshFrame, alignmentKey, attempt]);

  // Data → engine. Each is cheap to re-apply, so plain effects are enough.
  useEffect(() => {
    engineRef.current?.setGraph(graph, graphFlags);
  }, [graph, graphFlags, engineReady]);
  useEffect(() => {
    engineRef.current?.setNotes(notes);
  }, [notes, engineReady]);
  useEffect(() => {
    engineRef.current?.setSelection(selection);
  }, [selection, graph, notes, engineReady]);
  useEffect(() => {
    engineRef.current?.setMeasurements(measurements);
  }, [measurements, engineReady]);
  useEffect(() => {
    engineRef.current?.setPendingPoint(pendingPoint);
  }, [pendingPoint, engineReady]);
  useEffect(() => {
    engineRef.current?.setLocalization(localization);
  }, [localization, engineReady]);
  useEffect(() => {
    engineRef.current?.setLocalizationTrail(localizationTrail);
  }, [localizationTrail, engineReady]);
  useEffect(() => {
    engineRef.current?.setFollowMode(followMode);
    // Following picks the camera mode itself; remember it for the next engine mount.
    if (followMode !== "off") latest.current.mode = followMode === "firstPerson" ? "walk" : "orbit";
  }, [followMode, engineReady]);

  const api = useMemo<ViewerApi>(
    () => ({
      setMode: (mode) => {
        latest.current.mode = mode;
        engineRef.current?.setMode(mode);
        setState((s) => ({ ...s, mode }));
      },
      setTool: (tool) => {
        latest.current.tool = tool;
        engineRef.current?.setTool(tool);
        setState((s) => ({ ...s, tool }));
      },
      setShowGraph: (visible) => {
        latest.current.showGraph = visible;
        engineRef.current?.setShowGraph(visible);
        setState((s) => ({ ...s, showGraph: visible }));
      },
      setLayer: (layer) => {
        latest.current.layer = layer;
        engineRef.current?.setLayer(layer);
        setState((s) => ({ ...s, layer }));
      },
      resetView: () => {
        latest.current.mode = "orbit";
        engineRef.current?.resetView();
        setState((s) => ({ ...s, mode: "orbit" }));
      },
      focusNode: (id) => engineRef.current?.focusNode(id),
      focusNote: (id) => engineRef.current?.focusNote(id),
      focusPhone: () => {
        latest.current.mode = "orbit";
        engineRef.current?.focusPhone();
        setState((s) => ({ ...s, mode: "orbit" }));
      },
      retry: () => setAttempt((n) => n + 1),
      getCameraPosition: () => engineRef.current?.getCameraPosition() ?? null,
    }),
    [],
  );

  const focusViewer = useCallback(() => containerRef.current?.focus({ preventScroll: true }), []);

  // Chase orbits and first person walks, so the toolbar's Orbit/Walk toggle
  // reads the follow mode rather than lagging a render behind it.
  const view = useMemo<ViewerState>(() => {
    if (followMode === "off") return state;
    const mode = followMode === "firstPerson" ? "walk" : "orbit";
    return state.mode === mode ? state : { ...state, mode };
  }, [state, followMode]);

  return { containerRef, state: view, api, focusViewer };
}
