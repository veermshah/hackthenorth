import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { type Alignment, type Measurement, type NavigationGraph, type NavNodeKind, type Vec3, type WorldNote, edgeAccessible } from "@/lib/world-manifest";
import { CameraKeyControls } from "./CameraKeyControls";
import { PlacementGesture } from "./PlacementGesture";

export type ViewerMode = "orbit" | "walk";
export type ViewerTool = "navigate" | "measure" | "note";
/** Which scan the canvas draws: the Gaussian splat or the collision mesh. Never both. */
export type ViewerLayer = "splat" | "mesh";
export type LoadStatus = "empty" | "loading" | "ready" | "error";
export type MeshStatus = "none" | "loading" | "ready" | "error";
/**
 * How the camera tracks the phone on the Live tab.
 * - `off`: free camera.
 * - `chase`: over-the-shoulder — behind and above the phone, looking the way it looks.
 * - `firstPerson`: the camera sits in the phone's pose, seeing what it saw.
 */
export type FollowMode = "off" | "chase" | "firstPerson";

export type EngineEvent =
  | { type: "status"; status: LoadStatus; error?: string }
  | { type: "progress"; loaded: number; total: number }
  | { type: "loaded"; numSplats: number }
  /** The collision mesh (`assets.mesh`) layer changed state; `triangles` on ready. */
  | { type: "mesh"; status: MeshStatus; triangles?: number; error?: string }
  /** A click landed on the scan. `point` is in world space, `graphPoint` in the graph's frame; `surface` says what was hit. */
  | { type: "pick"; tool: ViewerTool; point: Vec3; graphPoint: Vec3; surface: "mesh" | "splat" }
  /** A click landed on a navigation-graph waypoint. */
  | { type: "pick-node"; tool: ViewerTool; id: string }
  /** A click landed on a note pin. */
  | { type: "pick-note"; tool: ViewerTool; id: string }
  /** The camera stopped following the phone because the viewer took manual control. */
  | { type: "follow"; mode: FollowMode }
  /** A click hit nothing. */
  | { type: "pick-miss"; tool: ViewerTool };

export type ViewerSelection = { kind: "node" | "note"; id: string };

/**
 * Where the phone was when it sent a VPS image query, in the world frame,
 * plus the image itself so it can be drawn on the frustum's far plane.
 */
export type LocalizationMarker = {
  /** Camera position (metres) and rotation (xyzw) — ARKit camera convention: −Z forward, +Y up, +X right. */
  position: Vec3;
  rotation: [number, number, number, number];
  imageUrl: string | null;
  /** portrait: image up = camera −X, image right = camera +Y. */
  orientation: "portrait" | "landscape";
  fovDeg: { horizontal: number; vertical: number };
  /** ok = precise fix; anything else draws the marker dimmed. */
  tone: "ok" | "warn" | "bad";
};

export type EngineOptions = {
  /** Fills this element with the canvas; it is also the keyboard focus target for walk mode. */
  container: HTMLElement;
  splatUrl: string | null;
  /** Aligned collision mesh (.glb). Drawn in place of the splat when its layer is picked, and preferred over it for picking. */
  meshUrl?: string | null;
  /** Frame the mesh vertices are in: "world" (default) or "splat" (goes through `alignment` like the splat). */
  meshFrame?: "world" | "splat";
  alignment?: Alignment;
  onEvent: (event: EngineEvent) => void;
};

/* Wander palette, mirrored from globals.css. */
const NAVY = 0x1e293b;
const BLUE = 0x2e4885;
const PINK = 0xd85598;
const SKY = 0x60baf4;
const WHITE = 0xffffff;
const SLATE = 0x475569;

const NODE_RADIUS = 0.045;
/** Splat and mesh hits closer together than this describe the same surface; see `intersectScene`. */
const SURFACE_TIE_M = 0.25;

/** Waypoint click radius in pixels: the dots are drawn small, so they are picked in screen space. */
const NODE_PICK_PX = 14;
const MESH_COLOR = 0x94a3b8;
const MEASURE_RADIUS = 0.03;
/** Note pins are screen-space: fixed 28 px, coloured by distance instead of shrinking with it. */
const PIN_SIZE = 28;
const PIN_NEAR_COLOR = new THREE.Color(PINK);
const PIN_FAR_COLOR = new THREE.Color(SKY);
const PIN_NEAR_M = 1.5;
const MEASURE_LINE_RADIUS = 0.006;
const EYE_HEIGHT = 1.6;
/** Walking pace in metres per second; orbit mode scales this with distance to the pivot. */
const WALK_SPEED = 1.6;
/**
 * A press that travels further than this is an orbit/look drag, not a click. There is
 * deliberately no time limit alongside it: aiming a pin takes as long as it takes, and on a
 * heavy scan the pointerup itself can arrive late, so a stationary press stays a click
 * however long it is held.
 */
const CLICK_MAX_PX = 5;
const HOVER_THROTTLE_MS = 70;
const X_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
const ORBIT_DIRECTION = new THREE.Vector3(0.65, 0.55, 0.85).normalize();
const UP = new THREE.Vector3(0, 1, 0);
/** Distance from the phone to the drawn image plane, and the size of the phone dot. */
const FRUSTUM_DEPTH = 0.6;
/** Chase camera: how far behind / above the phone it sits, and how far ahead of it it looks. */
const CHASE_BACK = 2.6;
const CHASE_BACK_RANGE: [number, number] = [0.9, 10];
const CHASE_UP = 1.3;
const CHASE_AHEAD = 1.2;
/** Follow easing rate (1/s). Fixes land about once a second, so this glides between them. */
const FOLLOW_EASE = 3.5;
const PHONE_RADIUS = 0.06;
const TRAIL_RADIUS = 0.035;
/** Portrait phone: the three.js camera's +Y (up) must map to the device's −X (image up). */
const PORTRAIT_ROLL = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);

const LABEL_CLASS =
  "absolute left-0 top-0 whitespace-nowrap rounded-full border border-hairline bg-pure-white/95 px-2 py-0.5 text-caption font-medium text-void-black will-change-transform";
const PIN_CLASS =
  "absolute left-0 top-0 flex cursor-pointer select-none flex-col items-center gap-0.5 will-change-transform pointer-events-auto rounded-lg focus-visible:outline-2 focus-visible:outline-wander-blue";
const PIN_CHIP_CLASS =
  "whitespace-nowrap rounded-full border px-2 py-0.5 text-caption font-medium transition-colors duration-200";
const PIN_CHIP_IDLE = "border-hairline bg-pure-white/95 text-void-black";
const PIN_CHIP_SELECTED = "border-wander-blue bg-sky-tint text-wander-blue";
/** Map-pin silhouette with the tip exactly at the bottom of the 24×24 box; fill = currentColor. */
const PIN_PATH =
  "M12 24C12 24 4 15.6 4 9.6A8 8 0 0 1 20 9.6C20 15.6 12 24 12 24ZM12 12.6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z";

export function supportsWebGL2(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    // Release the probe context right away; browsers cap live WebGL contexts.
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

type Label = {
  el: HTMLDivElement;
  position: THREE.Vector3;
  offsetY: number;
  nodeId?: string;
  /** Set for note pins: they are recoloured by camera distance every frame. */
  noteId?: string;
};

/**
 * Owns the Three.js scene for one world: Spark splat rendering, orbit / walk
 * camera controls, picking for the measure and stop tools, the navigation
 * graph and measurement overlays, HTML labels, and camera framing. React owns
 * the data (graph, measurements, selection) and pushes it in through setters;
 * the engine reports user interaction back through `onEvent`.
 */
export class SplatViewerEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly spark: SparkRenderer;
  /** Alignment (splat → world) is applied here; the SplatMesh is its child. */
  private readonly root = new THREE.Group();
  private readonly graphGroup = new THREE.Group();
  private readonly measureGroup = new THREE.Group();
  private readonly grid: THREE.GridHelper;
  private readonly orbit: OrbitControls;
  private readonly keys: CameraKeyControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly labelLayer: HTMLDivElement;
  private readonly labels: Label[] = [];
  private readonly disposers: (() => void)[] = [];

  private readonly sphereGeo = new THREE.SphereGeometry(1, 20, 14);
  private readonly nodeMaterials: Record<NavNodeKind, THREE.MeshBasicMaterial> = {
    waypoint: overlayMaterial(BLUE),
    entrance: overlayMaterial(SKY),
    destination: overlayMaterial(PINK),
  };
  private readonly edgeMaterial = graphLineMaterial(BLUE);
  private readonly flaggedEdgeMaterial = graphLineMaterial(PINK);
  /** Vertical transitions: step-free (elevator / ramp) in Sky, stairs / escalators in White. */
  private readonly accessibleTransitionMaterial = graphLineMaterial(SKY);
  private readonly steppedTransitionMaterial = graphLineMaterial(WHITE);
  private readonly flagMaterial = overlayMaterial(PINK);
  private readonly measureMaterial = overlayMaterial(SKY);
  private readonly pendingMaterial = overlayMaterial(WHITE);
  private readonly selectionRing: THREE.Mesh;
  private readonly hoverMarker: THREE.Mesh;
  private readonly previewLine: THREE.Mesh;

  /** The phone: dot at the camera, frustum edges, and the query image on the far plane. */
  private readonly phoneGroup = new THREE.Group();
  private readonly phoneDot: THREE.Mesh;
  private readonly frustumLines: THREE.LineSegments;
  private readonly frustumMaterial = new THREE.LineBasicMaterial({
    color: WHITE,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  private readonly imagePlane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly trailGroup = new THREE.Group();
  private readonly trailMaterial = overlayMaterial(SKY);
  private readonly textureLoader = new THREE.TextureLoader();
  private imageTexture: THREE.Texture | null = null;
  private imageTextureUrl: string | null = null;
  private marker: LocalizationMarker | null = null;
  private follow: FollowMode = "off";
  /** Chase distance, adjustable with the wheel while following. */
  private chaseBack = CHASE_BACK;

  private mesh: SplatMesh | null = null;
  private readonly meshGroup = new THREE.Group();
  private collision: THREE.Object3D | null = null;
  private readonly collisionMeshes: THREE.Mesh[] = [];
  private layer: ViewerLayer = "splat";
  private graphMarkerMeshes = new Map<string, THREE.Mesh>();
  private nodePositions = new Map<string, THREE.Vector3>();
  private notePositions = new Map<string, THREE.Vector3>();
  private selectedNoteId: string | null = null;
  private selectedNodeId: string | null = null;
  /** Distance (m) at which pins reach the "far" colour; derived from the scene size. */
  private pinFarM = 15;
  private graphFrame: "world" | "splat" = "world";
  /** Robust (outlier-trimmed) bounds in splat-local space. */
  private localBounds: THREE.Box3 | null = null;
  private mode: ViewerMode = "orbit";
  private tool: ViewerTool = "navigate";
  private pendingPoint: THREE.Vector3 | null = null;
  private readonly placement = new PlacementGesture(CLICK_MAX_PX);
  private lastHover = 0;
  private lastTime = 0;
  private disposed = false;

  constructor(private readonly opts: EngineOptions) {
    const { container } = opts;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // per Spark guidance: MSAA costs a lot and does nothing for splats
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(NAVY, 1);
    this.renderer.domElement.className = "block h-full w-full touch-none";
    container.appendChild(this.renderer.domElement);

    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "pointer-events-none absolute inset-0 overflow-hidden";
    container.appendChild(this.labelLayer);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
    this.camera.position.set(4, 3, 6);

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark, this.root, this.measureGroup);
    this.applyAlignment(opts.alignment);
    (opts.meshFrame === "splat" ? this.root : this.scene).add(this.meshGroup);
    this.meshGroup.visible = false;
    this.meshGroup.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 8, 5);
    this.meshGroup.add(sun);

    this.grid = new THREE.GridHelper(20, 20, SLATE, 0x334155);
    this.grid.visible = !opts.splatUrl;
    this.scene.add(this.grid);

    this.selectionRing = new THREE.Mesh(
      new THREE.TorusGeometry(NODE_RADIUS * 2.4, 0.008, 10, 40),
      overlayMaterial(WHITE),
    );
    this.selectionRing.rotation.x = Math.PI / 2;
    this.selectionRing.renderOrder = 1002;
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);

    this.hoverMarker = new THREE.Mesh(this.sphereGeo, this.pendingMaterial);
    this.hoverMarker.scale.setScalar(MEASURE_RADIUS);
    this.hoverMarker.renderOrder = 1003;
    this.hoverMarker.visible = false;
    this.previewLine = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), this.pendingMaterial);
    this.previewLine.renderOrder = 1002;
    this.previewLine.visible = false;
    this.scene.add(this.hoverMarker, this.previewLine);

    // Phone marker: geometry is rebuilt per marker (FOV / orientation), the group carries the pose.
    this.phoneDot = new THREE.Mesh(this.sphereGeo, overlayMaterial(WHITE));
    this.phoneDot.scale.setScalar(PHONE_RADIUS);
    this.phoneDot.renderOrder = 1005;
    this.frustumLines = new THREE.LineSegments(new THREE.BufferGeometry(), this.frustumMaterial);
    this.frustumLines.renderOrder = 1004;
    this.imagePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: WHITE,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.imagePlane.renderOrder = 1004;
    this.phoneGroup.add(this.phoneDot, this.frustumLines, this.imagePlane);
    this.phoneGroup.visible = false;
    this.scene.add(this.phoneGroup, this.trailGroup);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.screenSpacePanning = true;
    this.orbit.maxPolarAngle = Math.PI; // splats can be viewed from below when the scan is flipped

    this.keys = new CameraKeyControls(this.camera, container, this.renderer.domElement);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const canvas = this.renderer.domElement;
    this.listen(canvas, "pointerdown", this.onPointerDown);
    this.listen(canvas, "pointerup", this.onPointerUp);
    this.listen(canvas, "pointermove", this.onPointerMove);
    this.listen(canvas, "pointercancel", this.onPointerCancel);
    this.listen(canvas, "lostpointercapture", this.onPointerCancel);
    this.listen(canvas, "pointerleave", () => this.setHover(null));
    this.listen(canvas, "wheel", this.onWheel);

    if (opts.splatUrl) this.loadSplat(opts.splatUrl);
    else {
      this.frameBox(this.worldBounds());
      opts.onEvent({ type: "status", status: "empty" });
    }
    if (opts.meshUrl) this.loadMesh(opts.meshUrl);

    this.renderer.setAnimationLoop((time) => this.tick(time));
  }

  /* ---------------------------------------------------------------- public */

  setMode(mode: ViewerMode) {
    this.releaseFollow(); // picking a camera mode by hand ends the ride-along
    this.applyMode(mode);
  }

  private applyMode(mode: ViewerMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "walk") {
      const bounds = this.worldBounds();
      if (!bounds.containsPoint(this.camera.position)) {
        // Drop in at eye height in the middle of the scan, facing the way the orbit view was looking.
        const c = bounds.getCenter(new THREE.Vector3());
        const eye = Math.min(bounds.min.y + EYE_HEIGHT, bounds.max.y);
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0);
        if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
        this.camera.position.set(c.x, eye, c.z);
        this.camera.lookAt(this.camera.position.clone().add(forward));
      }
      this.orbit.enabled = false;
      this.keys.syncFromCamera();
      this.keys.applyRotation();
      this.keys.dragLook = true;
    } else {
      this.keys.dragLook = false;
      // Put the orbit pivot a few metres ahead so the switch doesn't swing the camera.
      const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.orbit.target.copy(this.camera.position).addScaledVector(ahead, 3);
      this.orbit.enabled = true;
      this.orbit.update();
    }
    this.opts.container.focus({ preventScroll: true });
  }

  setTool(tool: ViewerTool) {
    this.tool = tool;
    this.placement.reset();
    this.renderer.domElement.style.cursor = tool === "navigate" ? "" : "crosshair";
    for (const l of this.labels) if (l.noteId) this.setPinInteraction(l.el);
    if (tool !== "measure") this.setPendingPoint(null);
    this.setHover(null);
  }

  setShowGraph(visible: boolean) {
    this.graphGroup.visible = visible;
    for (const l of this.labels) if (l.el.dataset.kind === "node") l.el.hidden = !visible;
  }

  /** Draw the splat or the collision mesh. The hidden one still catches picks, nearest surface first. */
  setLayer(layer: ViewerLayer) {
    this.layer = layer;
    this.applyLayer();
  }

  /**
   * Replace the rendered navigation graph. Cheap: graphs are tens of nodes.
   * `flags` (node ids and "from|to" edge keys the mesh validator rejected) draw in pink.
   */
  setGraph(graph: NavigationGraph, flags?: { nodes: Set<string>; edges: Set<string> }) {
    const frame = graph.frame ?? "world";
    if (frame !== this.graphFrame || !this.graphGroup.parent) {
      this.graphGroup.removeFromParent();
      (frame === "splat" ? this.root : this.scene).add(this.graphGroup);
      this.graphFrame = frame;
    }
    this.clearGroup(this.graphGroup);
    this.removeLabels("node");
    this.graphMarkerMeshes = new Map();
    this.nodePositions = new Map();

    for (const node of graph.nodes) {
      const p = new THREE.Vector3(...node.position);
      this.nodePositions.set(node.id, p);
      const m = new THREE.Mesh(
        this.sphereGeo,
        flags?.nodes.has(node.id) ? this.flagMaterial : this.nodeMaterials[node.kind ?? "waypoint"],
      );
      m.scale.setScalar(NODE_RADIUS);
      m.position.copy(p);
      m.renderOrder = 1001;
      m.userData.markerPixels = node.name || node.kind === "destination" || node.kind === "entrance" ? 5 : 3;
      this.graphGroup.add(m);
      this.graphMarkerMeshes.set(node.id, m);
      this.addLabel("node", node.name ?? node.id, this.graphGroup.localToWorld(p.clone()), NODE_RADIUS * 2.2, node.id);
      this.labels[this.labels.length - 1].el.dataset.quiet = String(!node.name && (node.kind ?? "waypoint") === "waypoint");
    }
    for (const edge of graph.edges) {
      const a = this.nodePositions.get(edge.from);
      const b = this.nodePositions.get(edge.to);
      if (!a || !b) continue;
      const flagged = flags?.edges.has(`${edge.from}|${edge.to}`) ?? false;
      const vertical = (edge.kind ?? "walk") !== "walk";
      const material = flagged
        ? this.flaggedEdgeMaterial
        : vertical
          ? edgeAccessible(edge) ? this.accessibleTransitionMaterial : this.steppedTransitionMaterial
          : this.edgeMaterial;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), material);
      line.renderOrder = 1000;
      this.graphGroup.add(line);
    }
    if (this.mesh === null && graph.nodes.length) {
      this.grid.position.y = new THREE.Box3().setFromPoints([...this.nodePositions.values()]).min.y - 0.01;
    }
  }

  /** Highlight one waypoint or note pin (or nothing). */
  setSelection(sel: ViewerSelection | null) {
    this.selectedNodeId = sel?.kind === "node" ? sel.id : null;
    let p: THREE.Vector3 | undefined;
    if (sel?.kind === "node" && this.graphGroup.visible) {
      const local = this.nodePositions.get(sel.id);
      if (local) {
        this.graphGroup.updateMatrixWorld(true);
        p = this.graphGroup.localToWorld(local.clone());
      }
    }
    // Notes are HTML pins; their selection is styled in the DOM instead of with the 3D ring.
    this.selectionRing.visible = !!p;
    if (p) this.selectionRing.position.copy(p);
    this.selectedNoteId = sel?.kind === "note" ? sel.id : null;
    for (const l of this.labels) if (l.noteId) this.stylePin(l.el, l.noteId === this.selectedNoteId);
  }

  /** Replace the note pins (world frame). Pins live in the label layer, not the 3D scene. */
  setNotes(notes: WorldNote[]) {
    this.removeLabels("note");
    this.notePositions = new Map();
    for (const note of notes) {
      const p = new THREE.Vector3(...note.position);
      this.notePositions.set(note.id, p);
      this.addPin(note.id, note.title || "Untitled note", p);
    }
  }

  /** Where the camera is currently looking from, in the world frame (same frame as notes
   * and `graph.frame === "world"` nodes) — the web dashboard's current 3D viewport, not a
   * live phone pose or localization. */
  getCameraPosition(): Vec3 {
    return [this.camera.position.x, this.camera.position.y, this.camera.position.z];
  }

  private addPin(id: string, title: string, position: THREE.Vector3) {
    const el = document.createElement("div");
    el.className = PIN_CLASS;
    el.dataset.kind = "note";
    el.title = title;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", title);
    this.setPinInteraction(el);

    const chip = document.createElement("span");
    chip.className = `${PIN_CHIP_CLASS} ${PIN_CHIP_IDLE}`;
    chip.textContent = title;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(PIN_SIZE));
    svg.setAttribute("height", String(PIN_SIZE));
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("transition-transform", "duration-200", "drop-shadow-[0_1px_2px_rgba(15,23,42,0.35)]");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", PIN_PATH);
    path.setAttribute("fill", "currentColor");
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("stroke", "#ffffff");
    path.setAttribute("stroke-width", "1.4");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);

    el.append(chip, svg);
    // Pins sit above the canvas, so they are picked in the DOM rather than by raycast.
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.tool !== "navigate") return;
      this.opts.onEvent({ type: "pick-note", tool: this.tool, id });
    });
    el.addEventListener("keydown", (e) => {
      if (this.tool !== "navigate" || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      e.stopPropagation();
      this.opts.onEvent({ type: "pick-note", tool: this.tool, id });
    });
    this.stylePin(el, id === this.selectedNoteId);
    this.labelLayer.appendChild(el);
    this.labels.push({ el, position: position.clone(), offsetY: 0, noteId: id });
  }

  private stylePin(el: HTMLDivElement, selected: boolean) {
    const chip = el.firstElementChild as HTMLSpanElement | null;
    const svg = el.lastElementChild as SVGElement | null;
    if (chip) chip.className = `${PIN_CHIP_CLASS} ${selected ? PIN_CHIP_SELECTED : PIN_CHIP_IDLE}`;
    if (svg) {
      svg.style.transformOrigin = "50% 100%"; // Keep the tip at the saved position when selected.
      svg.style.transform = selected ? "scale(1.2)" : "";
    }
    el.setAttribute("aria-pressed", String(selected));
    el.style.zIndex = selected ? "2" : "1";
  }

  private setPinInteraction(el: HTMLDivElement) {
    // Placement must reach the scan, including underneath an existing pin's label.
    el.style.pointerEvents = this.tool === "navigate" ? "auto" : "none";
    el.tabIndex = this.tool === "navigate" ? 0 : -1;
  }

  /** Replace the rendered measurements (world frame). */
  setMeasurements(list: Measurement[]) {
    this.clearGroup(this.measureGroup);
    this.removeLabels("measure");
    for (const m of list) {
      const a = new THREE.Vector3(...m.points[0]);
      const b = new THREE.Vector3(...m.points[1]);
      for (const p of [a, b]) {
        const s = new THREE.Mesh(this.sphereGeo, this.measureMaterial);
        s.scale.setScalar(MEASURE_RADIUS);
        s.position.copy(p);
        s.renderOrder = 1001;
        this.measureGroup.add(s);
      }
      this.measureGroup.add(this.tube(a, b, MEASURE_LINE_RADIUS, this.measureMaterial, 1000));
      const mid = a.clone().add(b).multiplyScalar(0.5);
      this.addLabel("measure", `${m.label ? `${m.label} · ` : ""}${formatMetres(a.distanceTo(b))}`, mid, 0.08);
    }
    this.setPendingPoint(this.pendingPoint ? this.pendingPoint.toArray() as Vec3 : null);
  }

  /** First point of an in-progress measurement (world frame), or null to cancel. */
  setPendingPoint(point: Vec3 | null) {
    this.pendingPoint = point ? new THREE.Vector3(...point) : null;
    this.removeLabels("pending");
    for (const child of [...this.measureGroup.children]) if (child.userData.pending) this.measureGroup.remove(child);
    this.previewLine.visible = false;
    if (this.pendingPoint) {
      const s = new THREE.Mesh(this.sphereGeo, this.pendingMaterial);
      s.scale.setScalar(MEASURE_RADIUS);
      s.position.copy(this.pendingPoint);
      s.renderOrder = 1003;
      s.userData.pending = true;
      this.measureGroup.add(s);
    }
  }

  /** Frame the whole scan from an elevated three-quarter angle (orbit mode). */
  resetView() {
    if (this.mode === "walk") this.setMode("orbit");
    this.frameBox(this.worldBounds());
  }

  /** Move the camera to look at a navigation node. */
  focusNode(id: string) {
    const local = this.nodePositions.get(id);
    if (!local) return;
    this.graphGroup.updateMatrixWorld(true);
    const target = this.graphGroup.localToWorld(local.clone());

    this.focusPoint(target);
  }

  /** Move the camera to look at a note pin. */
  focusNote(id: string) {
    const p = this.notePositions.get(id);
    if (p) this.focusPoint(p.clone());
  }

  /* ------------------------------------------------------- localization */

  /**
   * Show where the phone was for a VPS image query (or hide the marker). The
   * frustum is rebuilt from the image's FOV; the JPEG is textured onto its far
   * plane so the query can be compared with the splat behind it.
   */
  setLocalization(marker: LocalizationMarker | null) {
    this.marker = marker;
    this.applyPhoneVisibility();
    if (!marker) return;

    this.phoneGroup.position.set(...marker.position);
    this.phoneGroup.quaternion.set(...marker.rotation).normalize();

    // Image axes in camera space (ARKit: −Z forward). Portrait phones hold the
    // landscape sensor rotated 90° CW, so image-up is the camera's −X.
    const portrait = marker.orientation === "portrait";
    const right = portrait ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const up = portrait ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const halfW = FRUSTUM_DEPTH * Math.tan(THREE.MathUtils.degToRad(clampFov(marker.fovDeg.horizontal)) / 2);
    const halfH = FRUSTUM_DEPTH * Math.tan(THREE.MathUtils.degToRad(clampFov(marker.fovDeg.vertical)) / 2);
    const centre = new THREE.Vector3(0, 0, -FRUSTUM_DEPTH);
    const corner = (sx: number, sy: number) =>
      centre.clone().addScaledVector(right, sx * halfW).addScaledVector(up, sy * halfH);
    const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const origin = new THREE.Vector3();
    const segments: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) segments.push(origin, c[i], c[i], c[(i + 1) % 4]);
    // A short tick on the top edge so the image's "up" is readable even without the texture.
    segments.push(corner(0, 1), corner(0, 1).addScaledVector(up, halfH * 0.25));
    this.frustumLines.geometry.dispose();
    this.frustumLines.geometry = new THREE.BufferGeometry().setFromPoints(segments);

    this.imagePlane.geometry.dispose();
    this.imagePlane.geometry = new THREE.PlaneGeometry(halfW * 2, halfH * 2);
    this.imagePlane.position.copy(centre);
    // PlaneGeometry spans local X/Y facing +Z; roll it so local +X → image-right and local +Y → image-up.
    this.imagePlane.quaternion.copy(portrait ? PORTRAIT_ROLL : new THREE.Quaternion());

    this.applyMarkerOpacity();
    this.loadImage(marker.imageUrl);
  }

  /** Recent phone positions (world frame, newest first) drawn as a thin trail. */
  setLocalizationTrail(points: Vec3[]) {
    this.clearGroup(this.trailGroup);
    const list = points.map((p) => new THREE.Vector3(...p));
    for (const p of list) {
      const s = new THREE.Mesh(this.sphereGeo, this.trailMaterial);
      s.scale.setScalar(TRAIL_RADIUS);
      s.position.copy(p);
      s.renderOrder = 1001;
      this.trailGroup.add(s);
    }
    for (let i = 1; i < list.length; i++) {
      if (list[i - 1].distanceTo(list[i]) > 0.02) this.trailGroup.add(this.tube(list[i - 1], list[i], 0.008, this.trailMaterial, 1000));
    }
  }

  /**
   * Ride along with the phone. `chase` flies the camera behind and above it,
   * `firstPerson` puts the camera in its pose; both ease onto every new fix, so
   * the viewer watches the walk instead of chasing it by hand. Dragging, the
   * wheel or WASD hands control straight back (see `releaseFollow`).
   */
  setFollowMode(mode: FollowMode) {
    if (mode === this.follow) return;
    this.follow = mode;
    if (mode !== "off") {
      this.chaseBack = CHASE_BACK;
      this.applyMode(mode === "firstPerson" ? "walk" : "orbit");
    }
    // OrbitControls and drag-look stay armed throughout: `tick` simply skips
    // `orbit.update()` while following, so the drag that releases the camera is
    // the same drag that moves it, with no dead gesture in between.
    this.applyPhoneVisibility();
    this.applyMarkerOpacity();
  }

  /**
   * The phone and its trail are drawn around the camera in first person, and
   * both ignore depth, so they smear across the whole view instead of reading
   * as overlays. Hide them rather than clip through them.
   */
  private applyPhoneVisibility() {
    this.phoneGroup.visible = !!this.marker && this.follow !== "firstPerson";
    this.trailGroup.visible = this.follow !== "firstPerson";
  }

  /** Hand the camera back to the viewer and tell React, so the Live tab's toggle agrees. */
  private releaseFollow() {
    if (this.follow === "off") return;
    this.setFollowMode("off");
    this.opts.onEvent({ type: "follow", mode: "off" });
  }

  /** Fly the orbit camera to look at the phone from a few metres away. */
  focusPhone() {
    if (!this.marker) return;
    if (this.mode === "walk") this.setMode("orbit");
    this.focusPoint(new THREE.Vector3(...this.marker.position));
  }

  /**
   * Put the viewer camera exactly where the phone was, looking the way it
   * looked, so the splat can be compared against the query image side by side.
   */
  viewFromPhone() {
    if (!this.marker) return;
    this.setFollowMode("firstPerson");
  }

  /** Marker opacity: dimmed for a poor fix, and ghosted in chase view so it never blocks the walk. */
  private applyMarkerOpacity() {
    if (!this.marker) return;
    const dim = this.marker.tone === "ok" ? 1 : 0.45;
    const ghost = this.follow === "chase" ? 0.4 : 1;
    this.frustumMaterial.opacity = 0.95 * dim;
    (this.phoneDot.material as THREE.MeshBasicMaterial).opacity = 0.95 * dim;
    this.imagePlane.material.opacity = 0.92 * dim * ghost;
  }

  private loadImage(url: string | null) {
    if (url === this.imageTextureUrl) return;
    this.imageTextureUrl = url;
    this.imageTexture?.dispose();
    this.imageTexture = null;
    this.imagePlane.material.map = null;
    this.imagePlane.material.needsUpdate = true;
    if (!url) return;
    this.textureLoader.load(url, (texture) => {
      if (this.disposed || this.imageTextureUrl !== url) {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      this.imageTexture = texture;
      this.imagePlane.material.map = texture;
      this.imagePlane.material.needsUpdate = true;
    });
  }

  private focusPoint(target: THREE.Vector3) {
    if (this.mode === "walk") {
      this.camera.position.set(target.x, target.y + EYE_HEIGHT - 0.2, target.z);
      this.keys.syncFromCamera();
      return;
    }
    const offset = this.camera.position.clone().sub(this.orbit.target);
    if (offset.lengthSq() < 1e-4) offset.copy(ORBIT_DIRECTION);
    offset.setLength(4);
    this.orbit.target.copy(target);
    this.camera.position.copy(target).add(offset);
    this.orbit.update();
  }

  /** Rotate the scan 180° about X for exports that arrive upside down (kept for alignment tooling). */
  flipUp() {
    this.root.quaternion.premultiply(X_FLIP);
    this.root.updateMatrixWorld(true);
    this.refreshLabelPositions();
    this.resetView();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    for (const off of this.disposers) off();
    this.orbit.dispose();
    this.keys.dispose();
    this.mesh?.dispose();
    this.disposeCollision();
    this.spark.dispose();
    this.clearGroup(this.graphGroup);
    this.clearGroup(this.measureGroup);
    this.clearGroup(this.trailGroup);
    for (const m of [...Object.values(this.nodeMaterials), this.edgeMaterial, this.flaggedEdgeMaterial, this.accessibleTransitionMaterial, this.steppedTransitionMaterial,
      this.flagMaterial, this.measureMaterial, this.pendingMaterial, this.trailMaterial])
      m.dispose();
    this.imageTexture?.dispose();
    this.imagePlane.geometry.dispose();
    this.imagePlane.material.dispose();
    this.frustumLines.geometry.dispose();
    this.frustumMaterial.dispose();
    (this.phoneDot.material as THREE.Material).dispose();
    this.sphereGeo.dispose();
    this.selectionRing.geometry.dispose();
    (this.selectionRing.material as THREE.Material).dispose();
    this.previewLine.geometry.dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
  }

  /* --------------------------------------------------------------- picking */

  /** While following, the wheel dollies the chase seat instead of doing nothing. */
  private onWheel = (e: WheelEvent) => {
    if (this.follow === "off") return;
    if (this.follow === "firstPerson") return this.releaseFollow();
    e.preventDefault();
    const [min, max] = CHASE_BACK_RANGE;
    this.chaseBack = THREE.MathUtils.clamp(this.chaseBack * Math.exp(e.deltaY * 0.001), min, max);
  };

  private onPointerDown = (e: PointerEvent) => {
    // Any click on the scene should make the keyboard controls live.
    this.opts.container.focus({ preventScroll: true });
    this.placement.start(e);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.placement.finish(e)) this.pick(e);
  };

  private onPointerCancel = (e: PointerEvent) => {
    this.placement.cancel(e);
    this.setHover(null);
  };

  private onPointerMove = (e: PointerEvent) => {
    // A drag means "I'll take it from here"; a click (under CLICK_MAX_PX) still picks.
    if (this.placement.move(e) && this.follow !== "off") this.releaseFollow();
    if (this.tool === "navigate" || this.placement.pressed) return;
    const now = performance.now();
    if (now - this.lastHover < HOVER_THROTTLE_MS) return;
    this.lastHover = now;
    this.setHover(this.intersectScene(e)?.point ?? null);
  };

  private pick(e: PointerEvent) {
    const { onEvent } = this.opts;
    this.setRayFromEvent(e);

    // Note pins are DOM elements and handle their own clicks; waypoints are picked here.
    if (this.tool === "navigate") {
      const node = this.pickNode(e);
      return onEvent(node ? { type: "pick-node", tool: this.tool, id: node } : { type: "pick-miss", tool: this.tool });
    }

    const hit = this.intersectScene();
    if (!hit) return onEvent({ type: "pick-miss", tool: this.tool });
    this.graphGroup.updateMatrixWorld(true);
    const graphPoint = this.graphGroup.worldToLocal(hit.point.clone());
    onEvent({
      type: "pick",
      tool: this.tool,
      point: hit.point.toArray() as Vec3,
      graphPoint: graphPoint.toArray() as Vec3,
      surface: hit.surface,
    });
  }

  /**
   * Nearest waypoint within `NODE_PICK_PX` of the pointer, or null. Screen space
   * rather than a raycast against the dots: they are drawn small on purpose, and
   * a fixed pixel target keeps distant waypoints clickable. Like the dots
   * themselves, this ignores occlusion — a waypoint behind a wall still picks.
   */
  private pickNode(e: PointerEvent): string | null {
    if (!this.graphGroup.visible || !this.nodePositions.size) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.graphGroup.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    let best: { id: string; d2: number } | null = null;
    for (const [id, local] of this.nodePositions) {
      v.copy(local);
      this.graphGroup.localToWorld(v);
      v.project(this.camera);
      if (v.z < -1 || v.z > 1) continue;
      const dx = rect.left + ((v.x + 1) / 2) * rect.width - e.clientX;
      const dy = rect.top + ((1 - v.y) / 2) * rect.height - e.clientY;
      const d2 = dx * dx + dy * dy;
      if (d2 <= NODE_PICK_PX * NODE_PICK_PX && (!best || d2 < best.d2)) best = { id, d2 };
    }
    return best?.id ?? null;
  }

  private setRayFromEvent(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.camera.updateMatrixWorld(true);
    this.raycaster.near = this.camera.near;
    this.raycaster.far = this.camera.far;
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  /**
   * Nearest surface under the pointer, taking the splat and the collision mesh together.
   * The mesh is the cleaner surface, but a Scaniverse `.glb` is only the wall planes it
   * managed to reconstruct: preferring it outright dropped the pin on a slab metres behind
   * (or beside) whatever the click was aimed at, and floors have no mesh at all. So the
   * first surface the ray reaches wins, and the drawn layer only breaks a near-tie — the
   * two describe the same wall there, and the mesh gives the tidier point.
   */
  private intersectScene(e?: PointerEvent): (THREE.Intersection & { surface: "mesh" | "splat" }) | null {
    if (e) this.setRayFromEvent(e);
    const mesh = this.intersectCollision();
    const splat = this.intersectSplat();
    if (!mesh) return splat ? { ...splat, surface: "splat" } : null;
    if (!splat) return { ...mesh, surface: "mesh" };
    const tie = Math.abs(mesh.distance - splat.distance) <= SURFACE_TIE_M;
    const preferMesh = tie ? this.meshGroup.visible : mesh.distance < splat.distance;
    return preferMesh ? { ...mesh, surface: "mesh" } : { ...splat, surface: "splat" };
  }

  /** Nearest hit on the aligned collision mesh, drawn or not. */
  private intersectCollision(): THREE.Intersection | null {
    if (!this.collisionMeshes.length) return null;
    this.meshGroup.updateMatrixWorld(true);
    const hits: THREE.Intersection[] = [];
    for (const m of this.collisionMeshes) m.raycast(this.raycaster, hits);
    hits.sort((a, b) => a.distance - b.distance);
    return hits[0] ?? null;
  }

  private intersectSplat(): THREE.Intersection | null {
    if (!this.mesh?.isInitialized) return null;
    this.mesh.updateWorldMatrix(true, false);
    const hits: THREE.Intersection[] = [];
    this.mesh.raycast(this.raycaster, hits);
    hits.sort((a, b) => a.distance - b.distance);
    return hits[0] ?? null;
  }

  private setHover(point: THREE.Vector3 | null) {
    if (!point) {
      this.hoverMarker.visible = false;
      this.previewLine.visible = false;
      return;
    }
    this.hoverMarker.position.copy(point);
    this.hoverMarker.visible = true;
    if (this.tool === "measure" && this.pendingPoint) {
      this.placeTube(this.previewLine, this.pendingPoint, point, MEASURE_LINE_RADIUS);
      this.previewLine.visible = true;
    } else this.previewLine.visible = false;
  }

  /* -------------------------------------------------------------- internal */

  private loadSplat(url: string) {
    const { onEvent } = this.opts;
    onEvent({ type: "status", status: "loading" });

    const mesh = new SplatMesh({
      url,
      onProgress: (e) =>
        onEvent({ type: "progress", loaded: e.loaded, total: e.lengthComputable ? e.total : 0 }),
    });
    this.mesh = mesh;
    this.root.add(mesh);
    this.applyLayer();

    mesh.initialized
      .then((m) => {
        if (this.disposed) return;
        this.applyLayer();
        this.localBounds = robustBounds(m);
        // Following owns the camera: take the scan's scale, but don't yank the view off the phone.
        if (this.follow === "off") this.resetView();
        else this.frameScales(this.worldBounds());
        onEvent({ type: "loaded", numSplats: m.numSplats });
        onEvent({ type: "status", status: "ready" });
      })
      .catch((err: unknown) => {
        if (this.disposed) return;
        onEvent({ type: "status", status: "error", error: describeError(err) });
      });
  }

  private loadMesh(url: string) {
    const { onEvent } = this.opts;
    onEvent({ type: "mesh", status: "loading" });
    new GLTFLoader().load(
      url,
      (gltf) => {
        if (this.disposed) return;
        this.disposeCollision();
        const object = gltf.scene;
        let triangles = 0;
        object.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          const geometry = child.geometry as THREE.BufferGeometry;
          triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
          // Scaniverse exports are often single-sided and can face either way; picking must work from anywhere.
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const material of materials) {
            material.side = THREE.DoubleSide;
            if (material instanceof THREE.MeshStandardMaterial && !material.map) material.color.set(MESH_COLOR);
          }
          this.collisionMeshes.push(child);
        });
        this.collision = object;
        this.meshGroup.add(object);
        this.applyLayer();
        if (!this.mesh) {
          this.localBounds = new THREE.Box3().setFromObject(object);
          this.resetView();
        }
        onEvent({ type: "mesh", status: "ready", triangles: Math.round(triangles) });
      },
      undefined,
      (err) => {
        if (this.disposed) return;
        onEvent({ type: "mesh", status: "error", error: describeError(err).replace("splat", "mesh") });
      },
    );
  }

  private disposeCollision() {
    if (!this.collision) return;
    this.meshGroup.remove(this.collision);
    for (const m of this.collisionMeshes) {
      m.geometry.dispose();
      for (const material of Array.isArray(m.material) ? m.material : [m.material]) {
        if (material instanceof THREE.MeshStandardMaterial) material.map?.dispose();
        material.dispose();
      }
    }
    this.collisionMeshes.length = 0;
    this.collision = null;
    this.applyLayer();
  }

  /**
   * Show exactly one scan. The mesh only draws once it has actually loaded, so
   * choosing it mid-download leaves the splat up rather than blanking the
   * canvas; a world with no splat falls back to the mesh for the same reason.
   */
  private applyLayer() {
    const mesh = this.collision !== null && (this.layer === "mesh" || !this.mesh?.isInitialized);
    this.meshGroup.visible = mesh;
    if (this.mesh) this.mesh.visible = !mesh;
  }

  private applyAlignment(a: Alignment | undefined) {
    if (!a) return;
    this.root.position.set(a.position[0], a.position[1], a.position[2]);
    this.root.quaternion.set(a.rotation[0], a.rotation[1], a.rotation[2], a.rotation[3]).normalize();
    this.root.scale.setScalar(a.scale);
    this.root.updateMatrixWorld(true);
  }

  private tube(a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material, renderOrder: number) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), material);
    this.placeTube(m, a, b, radius);
    m.renderOrder = renderOrder;
    return m;
  }

  /** Stretch a unit cylinder between two points. */
  private placeTube(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, radius: number) {
    const length = Math.max(a.distanceTo(b), 1e-4);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.scale.set(radius, length, radius);
    m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  }

  private clearGroup(group: THREE.Group) {
    for (const child of [...group.children]) {
      group.remove(child);
      const geo = (child as THREE.Mesh).geometry;
      if (geo && geo !== this.sphereGeo) geo.dispose();
    }
  }

  private addLabel(
    kind: "node" | "note" | "measure" | "pending",
    text: string,
    position: THREE.Vector3,
    offsetY: number,
    nodeId?: string,
  ) {
    const el = document.createElement("div");
    el.className = LABEL_CLASS;
    el.dataset.kind = kind;
    el.textContent = text;
    el.hidden = kind === "node" && !this.graphGroup.visible;
    this.labelLayer.appendChild(el);
    this.labels.push({ el, position: position.clone(), offsetY, nodeId });
  }

  private removeLabels(kind: string) {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      if (this.labels[i].el.dataset.kind === kind) {
        this.labels[i].el.remove();
        this.labels.splice(i, 1);
      }
    }
  }

  /** After the root transform changes, node labels (stored in world space) must be recomputed. */
  private refreshLabelPositions() {
    if (this.graphFrame !== "splat") return;
    this.graphGroup.updateMatrixWorld(true);
    for (const l of this.labels) {
      const p = l.nodeId ? this.nodePositions.get(l.nodeId) : undefined;
      if (p) l.position.copy(this.graphGroup.localToWorld(p.clone()));
    }
  }

  private updateLabels() {
    const w = this.labelLayer.clientWidth;
    const h = this.labelLayer.clientHeight;
    const v = new THREE.Vector3();
    const tint = new THREE.Color();
    for (const l of this.labels) {
      if (l.nodeId) l.el.hidden = !this.graphGroup.visible || (l.el.dataset.quiet === "true" && l.nodeId !== this.selectedNodeId);
      if (l.el.hidden) continue;
      v.copy(l.position).addScaledVector(UP, l.offsetY).project(this.camera);
      const visible = v.z > -1 && v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      l.el.style.visibility = visible ? "visible" : "hidden";
      if (!visible) continue;
      const x = ((v.x + 1) / 2) * w;
      const y = ((1 - v.y) / 2) * h;
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;

      if (l.noteId) {
        // Constant on-screen size, so depth is shown by colour: pink up close, sky when far away.
        const d = this.camera.position.distanceTo(l.position);
        const t = THREE.MathUtils.clamp((d - PIN_NEAR_M) / Math.max(1, this.pinFarM - PIN_NEAR_M), 0, 1);
        tint.lerpColors(PIN_NEAR_COLOR, PIN_FAR_COLOR, t);
        l.el.style.color = `#${tint.getHexString()}`;
        l.el.style.opacity = String(1 - 0.25 * t);
      }
    }
  }

  /** Scale-dependent bits of framing (clip planes, pin fade); returns the framing distance. */
  private frameScales(bounds: THREE.Box3): number {
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.5);
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    // Pins fade to the far colour by the time you're a scene-radius away.
    this.pinFarM = Math.max(8, radius * 1.5);
    this.camera.near = Math.max(0.02, distance / 1000);
    this.camera.far = Math.max(200, distance * 40);
    this.camera.updateProjectionMatrix();
    return distance;
  }

  private frameBox(bounds: THREE.Box3) {
    const center = bounds.getCenter(new THREE.Vector3());
    const distance = this.frameScales(bounds);
    this.camera.position.copy(center).addScaledVector(ORBIT_DIRECTION, distance);
    this.orbit.target.copy(center);
    this.orbit.update();
  }

  /** Robust bounds transformed into world space (falls back to the graph / a default box). */
  private worldBounds(): THREE.Box3 {
    if (this.localBounds && this.mesh) {
      this.mesh.updateMatrixWorld(true);
      return this.localBounds.clone().applyMatrix4(this.mesh.matrixWorld);
    }
    if (this.collision) {
      this.collision.updateWorldMatrix(true, true);
      // setFromObject already returns world coordinates; don't apply alignment twice.
      return new THREE.Box3().setFromObject(this.collision);
    }
    const points = [...this.nodePositions.values()];
    if (points.length) {
      this.graphGroup.updateMatrixWorld(true);
      return new THREE.Box3()
        .setFromPoints(points.map((p) => this.graphGroup.localToWorld(p.clone())))
        .expandByScalar(2);
    }
    return new THREE.Box3(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 2.5, 4));
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.opts.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Keep close-up waypoints small enough to inspect the floor beneath them. */
  private updateGraphMarkerSizes() {
    const focal = this.opts.container.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    if (!focal) return;
    this.camera.updateMatrixWorld();
    const point = new THREE.Vector3();
    const scale = new THREE.Vector3();
    this.graphGroup.getWorldScale(scale);
    for (const [id, marker] of this.graphMarkerMeshes) {
      marker.getWorldPosition(point);
      point.applyMatrix4(this.camera.matrixWorldInverse);
      const radius = Math.max(this.camera.near, -point.z) * marker.userData.markerPixels / focal;
      marker.scale.setScalar(radius / scale.x);
      if (id === this.selectedNodeId) this.selectionRing.scale.setScalar(radius / NODE_RADIUS * 1.4);
    }
  }

  private tick(time: number) {
    const dt = this.lastTime ? (time - this.lastTime) / 1000 : 0;
    this.lastTime = time;
    if (this.keys.hasInput) {
      this.releaseFollow(); // a key press is the viewer taking the camera back
      this.applyMotion(dt);
    }
    if (this.follow !== "off" && this.marker) this.updateFollow(dt);
    else if (this.mode === "orbit") this.orbit.update();
    this.updateGraphMarkerSizes();
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  }

  /**
   * Ease the camera onto the pose the current follow mode wants. Exponential
   * smoothing keeps it frame-rate independent, and because it eases from
   * wherever the camera already is, switching modes reads as a glide rather
   * than a cut — including the first one, from across the room.
   */
  private updateFollow(dt: number) {
    const marker = this.marker;
    if (!marker) return;
    const t = 1 - Math.exp(-Math.min(dt, 0.1) * FOLLOW_EASE);
    const phone = this.phoneGroup.position;

    if (this.follow === "firstPerson") {
      const q = this.phoneGroup.quaternion.clone();
      if (marker.orientation === "portrait") q.multiply(PORTRAIT_ROLL);
      this.camera.position.lerp(phone, t);
      this.camera.quaternion.slerp(q, t);
      this.keys.syncFromCamera();
      return;
    }

    // Chase: sit behind and above, looking just past the phone. The heading is
    // flattened so pointing the phone at the floor doesn't bury the camera.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.phoneGroup.quaternion).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const seat = phone
      .clone()
      .addScaledVector(forward, -this.chaseBack)
      .addScaledVector(UP, CHASE_UP);
    this.camera.position.lerp(seat, t);
    this.orbit.target.lerp(phone.clone().addScaledVector(forward, CHASE_AHEAD), t);
    this.camera.lookAt(this.orbit.target);
  }

  /** Apply held keys: WASD moves, Q/E (R/F, Space/C) change height, arrows turn, Shift hurries. */
  private applyMotion(dt: number) {
    const m = this.keys.consume(dt);
    const sprint = m.sprint ? this.keys.sprintMultiplier : 1;

    // Camera-relative axes on the horizontal plane so "forward" never flies into the floor.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, UP).normalize();

    if (this.mode === "walk") {
      const step = WALK_SPEED * sprint * Math.min(dt, 0.1);
      this.camera.position
        .addScaledVector(forward, m.move.z * step)
        .addScaledVector(right, m.move.x * step)
        .addScaledVector(UP, m.move.y * step);
      if (m.yaw || m.pitch) this.keys.turn(m.yaw, m.pitch);
      return;
    }

    // Orbit: fly camera and pivot together; faster the further out you are.
    const distance = this.camera.position.distanceTo(this.orbit.target);
    const step = Math.max(WALK_SPEED, distance * 0.6) * sprint * Math.min(dt, 0.1);
    const delta = new THREE.Vector3()
      .addScaledVector(forward, m.move.z * step)
      .addScaledVector(right, m.move.x * step)
      .addScaledVector(UP, m.move.y * step);
    this.camera.position.add(delta);
    this.orbit.target.add(delta);

    if (m.yaw || m.pitch) {
      // Swing the camera around the pivot: yaw about world up, pitch about the camera's right axis.
      const offset = this.camera.position.clone().sub(this.orbit.target);
      offset.applyAxisAngle(UP, m.yaw);
      const pitched = offset.clone().applyAxisAngle(right, -m.pitch);
      const elevation = Math.asin(THREE.MathUtils.clamp(pitched.clone().normalize().y, -1, 1));
      if (Math.abs(elevation) < Math.PI / 2 - 0.05) offset.copy(pitched);
      this.camera.position.copy(this.orbit.target).add(offset);
      this.camera.lookAt(this.orbit.target);
    }
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ) {
    target.addEventListener(type, handler);
    this.disposers.push(() => target.removeEventListener(type, handler));
  }
}

/** Flat, always-on-top material so overlays read as UI through the splats. */
function overlayMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
}

export function formatMetres(m: number): string {
  if (m < 1) return `${Math.round(m * 100)} cm`;
  return `${m.toFixed(m < 10 ? 2 : 1)} m`;
}

/** Keep a reported FOV drawable even if the phone sent something odd. */
function clampFov(deg: number): number {
  return Number.isFinite(deg) && deg > 5 && deg < 150 ? deg : 60;
}

/**
 * Bounding box from the 3rd–97th percentile of splat centres. Trained splats
 * usually include a halo of far-away floaters that would otherwise make the
 * framed view tiny, so the raw `getBoundingBox()` is not usable for framing.
 */
function robustBounds(mesh: SplatMesh): THREE.Box3 {
  const n = mesh.numSplats;
  if (n === 0) return new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

  const stride = Math.max(1, Math.floor(n / 120_000));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  mesh.forEachSplat((i, center) => {
    if (i % stride) return;
    xs.push(center.x);
    ys.push(center.y);
    zs.push(center.z);
  });
  if (xs.length < 8) return mesh.getBoundingBox();

  const pct = (arr: number[], p: number) => {
    arr.sort((a, b) => a - b);
    return arr[Math.round(p * (arr.length - 1))];
  };
  const box = new THREE.Box3(
    new THREE.Vector3(pct(xs, 0.03), pct(ys, 0.03), pct(zs, 0.03)),
    new THREE.Vector3(pct(xs, 0.97), pct(ys, 0.97), pct(zs, 0.97)),
  );
  // Guard against degenerate boxes (e.g. a perfectly flat scan).
  const size = box.getSize(new THREE.Vector3());
  if (size.x < 0.1) box.expandByVector(new THREE.Vector3(0.5, 0, 0));
  if (size.y < 0.1) box.expandByVector(new THREE.Vector3(0, 0.5, 0));
  if (size.z < 0.1) box.expandByVector(new THREE.Vector3(0, 0, 0.5));
  return box;
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/404|not found/i.test(msg)) return "The splat file was not found on the volume.";
  if (/network|fetch|failed to load/i.test(msg)) return "Could not download the splat. Check the worlds API and try again.";
  return msg || "Failed to load the splat.";
}

/** Pixel-width lines avoid metre-sized tubes obscuring a close-up scan. */
function graphLineMaterial(color: number) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
}
