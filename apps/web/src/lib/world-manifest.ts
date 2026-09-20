/**
 * World manifest — the `world.json` stored next to each world's assets on the
 * Modal Volume (`worlds/<id>/world.json`). It ties together the Niantic VPS
 * site, the asset version, the splat path, the navigation graph, and the
 * alignment between the splat's coordinate frame and the shared world frame.
 *
 * The canonical schema lives at `shared/contracts/world.schema.json`; keep
 * this file in sync with it.
 */
import type { WorldStatus } from "./worlds";

export const WORLD_SCHEMA = "wander.world/v1";

export type Vec3 = [number, number, number];
/** Quaternion as [x, y, z, w]. */
export type Quat = [number, number, number, number];

export type NavNodeKind = "waypoint" | "entrance" | "destination";

export type NavNode = {
  id: string;
  name?: string;
  kind?: NavNodeKind;
  /** Metres, in the frame given by `NavigationGraph.frame`. */
  position: Vec3;
  /** Storey label, e.g. "1" or "G". Nodes on different floors may only be joined by a non-walk edge. */
  floor?: string;
};

/** How an edge is traversed; anything but "walk" is a vertical transition with its own instruction. */
export type NavEdgeKind = "walk" | "stairs" | "escalator" | "elevator" | "ramp";
export const NAV_EDGE_KINDS: readonly NavEdgeKind[] = ["walk", "stairs", "escalator", "elevator", "ramp"];

export type NavEdge = {
  from: string;
  to: string;
  /** Defaults to true. */
  bidirectional?: boolean;
  /** Metres; derived from node positions when omitted. */
  distance?: number;
  /** Defaults to "walk". */
  kind?: NavEdgeKind;
  /** Step-free / wheelchair usable. Defaults to false for stairs and escalators, true otherwise. */
  accessible?: boolean;
};

/** Effective accessibility of an edge, applying the kind-based default. */
export function edgeAccessible(e: NavEdge): boolean {
  return e.accessible ?? !(e.kind === "stairs" || e.kind === "escalator");
}

export type NavigationGraph = {
  /** Which frame node positions are expressed in. Defaults to "world". */
  frame?: "world" | "splat";
  nodes: NavNode[];
  edges: NavEdge[];
};

/** Rigid transform (plus uniform scale) that maps splat-local coordinates into the world frame. */
export type Alignment = {
  /** Name of the target frame, e.g. "niantic-vps" or "arkit-session". */
  frame: string;
  position: Vec3;
  rotation: Quat;
  scale: number;
};

export type WorldAssets = {
  /** Volume-relative path to the splat (.spz / .ply / .splat / .ksplat / .sog). */
  splat: string;
  /** Optional collision / occlusion mesh (.glb); the navmesh builder and viewer raycasts prefer it over the splat. */
  mesh?: string;
  /** Optional VPS map export used by the phone for localization. */
  vpsMap?: string;
  /** Optional 16:10 preview image. */
  thumbnail?: string;
};

export type WorldManifest = {
  schema: typeof WORLD_SCHEMA;
  id: string;
  name: string;
  /** Project / space label shown in the dashboard. */
  space?: string;
  description?: string;
  /** Niantic Lightship VPS location id; null while the scan is not yet published. */
  nianticSiteId: string | null;
  /** Asset version directory, e.g. "v1". */
  version: string;
  assets: WorldAssets;
  navigationGraph?: NavigationGraph;
  /** Frame `assets.mesh` is expressed in; "world" (default) = already aligned, "splat" = goes through `alignment`. */
  meshFrame?: "world" | "splat";
  alignment?: Alignment;
  stats?: { splatCount?: number; captureApp?: string; capturedAt?: string };
  status?: WorldStatus;
  updatedAt?: string;
};

export const IDENTITY_ALIGNMENT: Alignment = {
  frame: "splat",
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: 1,
};

export const EMPTY_GRAPH: NavigationGraph = { frame: "world", nodes: [], edges: [] };

/** A saved distance measurement between two picked points (world frame, metres). */
export type Measurement = {
  id: string;
  label?: string;
  points: [Vec3, Vec3];
  createdAt?: string;
};

export const MEASUREMENTS_SCHEMA = "wander.measurements/v1";

/** `worlds/<id>/measurements.json` on the volume. */
export type MeasurementsFile = {
  schema: typeof MEASUREMENTS_SCHEMA;
  worldId: string;
  measurements: Measurement[];
  updatedAt?: string;
};

export function measurementLength(m: Measurement): number {
  const [a, b] = m.points;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** A note pinned to a point on the scan (world frame, metres). */
export type WorldNote = {
  id: string;
  title: string;
  /** Human-readable place, e.g. "2nd floor, outside room 204". */
  location?: string;
  description?: string;
  position: Vec3;
  author?: string;
  createdAt: string;
  updatedAt?: string;
};

export const NOTES_SCHEMA = "wander.notes/v1";

/** `worlds/<id>/notes.json` on the volume. */
export type NotesFile = {
  schema: typeof NOTES_SCHEMA;
  worldId: string;
  notes: WorldNote[];
  updatedAt?: string;
};

/** Splat formats the viewer can open (Spark decodes all of these). */
export const SPLAT_FILE_EXTENSIONS = [".spz", ".ply", ".splat", ".ksplat", ".sog"] as const;

/** "E7 Atrium — ground floor" → "e7-atrium-ground-floor"; a valid world id or "". */
export function slugifyWorldId(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** "v1" → "v2"; anything else gets a timestamp so versions never collide. */
export function nextVersion(current: string): string {
  const m = /^v(\d+)$/.exec(current);
  return m ? `v${Number(m[1]) + 1}` : `v${Date.now().toString(36)}`;
}

/** Volume-relative path → URL served by the Next.js proxy (`/api/worlds/...`). */
export function assetUrl(path: string): string {
  const rel = path.replace(/^\/?worlds\//, "").replace(/^\/+/, "");
  return `/api/worlds/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** Conventional path for an asset inside the volume, mirroring `worlds/<id>/<version>/<file>`. */
export function volumePath(id: string, version: string, file: string): string {
  return `worlds/${id}/${version}/${file}`;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec = (v: unknown, n: number): boolean =>
  Array.isArray(v) && v.length === n && v.every(isNum);
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Structural validation for untrusted manifest JSON. Returns a list of
 * problems; an empty list means `input` is a `WorldManifest`.
 */
export function validateManifest(input: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(input)) return ["manifest must be an object"];
  const m = input;

  if (m.schema !== WORLD_SCHEMA) errs.push(`schema must be "${WORLD_SCHEMA}"`);
  if (!isStr(m.id) || !ID_RE.test(m.id)) errs.push("id must be a lowercase slug");
  if (!isStr(m.name) || !m.name.trim()) errs.push("name is required");
  if (!(m.nianticSiteId === null || isStr(m.nianticSiteId)))
    errs.push("nianticSiteId must be a string or null");
  if (!isStr(m.version) || !ID_RE.test(m.version)) errs.push("version must be a slug like v1");

  if (!isObj(m.assets) || !isStr(m.assets.splat) || !m.assets.splat)
    errs.push("assets.splat is required");
  else
    for (const k of ["mesh", "vpsMap", "thumbnail"] as const)
      if (m.assets[k] !== undefined && !isStr(m.assets[k])) errs.push(`assets.${k} must be a string`);

  if (m.meshFrame !== undefined && m.meshFrame !== "world" && m.meshFrame !== "splat")
    errs.push('meshFrame must be "world" or "splat"');

  if (m.alignment !== undefined) {
    const a = m.alignment;
    if (
      !isObj(a) ||
      !isStr(a.frame) ||
      !isVec(a.position, 3) ||
      !isVec(a.rotation, 4) ||
      !isNum(a.scale) ||
      a.scale <= 0
    )
      errs.push("alignment must have frame, position[3], rotation[4] (xyzw), scale > 0");
  }

  if (m.navigationGraph !== undefined) errs.push(...validateGraph(m.navigationGraph, "navigationGraph"));
  return errs;
}

export function validateGraph(g: unknown, path = "graph"): string[] {
  const errs: string[] = [];
  if (!isObj(g) || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    return [`${path} must have nodes[] and edges[]`];
  }
  if (g.frame !== undefined && g.frame !== "world" && g.frame !== "splat")
    errs.push(`${path}.frame must be "world" or "splat"`);
  const ids = new Set<string>();
  g.nodes.forEach((n, i) => {
    if (!isObj(n) || !isStr(n.id) || !isVec(n.position, 3))
      errs.push(`${path}.nodes[${i}] needs id and position[3]`);
    else if (ids.has(n.id)) errs.push(`${path}.nodes[${i}] duplicate id "${n.id}"`);
    else ids.add(n.id);
    if (isObj(n) && n.kind !== undefined && !["waypoint", "entrance", "destination"].includes(n.kind as string))
      errs.push(`${path}.nodes[${i}].kind is invalid`);
  });
  const floors = new Map<string, string | undefined>();
  g.nodes.forEach((n) => {
    if (isObj(n) && isStr(n.id)) floors.set(n.id, isStr(n.floor) ? n.floor : undefined);
  });
  g.edges.forEach((e, i) => {
    if (!isObj(e) || !isStr(e.from) || !isStr(e.to)) {
      errs.push(`${path}.edges[${i}] needs from and to`);
      return;
    }
    if (!ids.has(e.from) || !ids.has(e.to)) errs.push(`${path}.edges[${i}] references an unknown node`);
    if (e.kind !== undefined && !NAV_EDGE_KINDS.includes(e.kind as NavEdgeKind)) errs.push(`${path}.edges[${i}].kind is invalid`);
    if (e.accessible !== undefined && typeof e.accessible !== "boolean") errs.push(`${path}.edges[${i}].accessible must be a boolean`);
    const a = floors.get(e.from);
    const b = floors.get(e.to);
    if (a !== undefined && b !== undefined && a !== b && (e.kind ?? "walk") === "walk")
      errs.push(`${path}.edges[${i}] joins floors ${a} and ${b}; set kind to stairs, escalator, elevator or ramp`);
  });
  return errs;
}

export function validateMeasurements(input: unknown): string[] {
  if (!Array.isArray(input)) return ["measurements must be an array"];
  const errs: string[] = [];
  input.forEach((m, i) => {
    if (!isObj(m) || !isStr(m.id) || !Array.isArray(m.points) || m.points.length !== 2 || !m.points.every((p) => isVec(p, 3)))
      errs.push(`measurements[${i}] needs id and points[2][3]`);
    else if (m.label !== undefined && !isStr(m.label)) errs.push(`measurements[${i}].label must be a string`);
  });
  return errs;
}

export function validateNotes(input: unknown): string[] {
  if (!Array.isArray(input)) return ["notes must be an array"];
  const errs: string[] = [];
  const ids = new Set<string>();
  input.forEach((n, i) => {
    if (!isObj(n) || !isStr(n.id) || !isStr(n.title) || !isVec(n.position, 3) || !isStr(n.createdAt)) {
      errs.push(`notes[${i}] needs id, title, position[3] and createdAt`);
      return;
    }
    if (ids.has(n.id)) errs.push(`notes[${i}] duplicate id "${n.id}"`);
    ids.add(n.id);
    for (const k of ["location", "description", "author", "updatedAt"] as const)
      if (n[k] !== undefined && !isStr(n[k])) errs.push(`notes[${i}].${k} must be a string`);
  });
  return errs;
}

export function parseNotes(input: unknown): WorldNote[] {
  const errs = validateNotes(input);
  if (errs.length) throw new Error(`Invalid notes: ${errs.join("; ")}`);
  return input as WorldNote[];
}

export function parseManifest(input: unknown): WorldManifest {
  const errs = validateManifest(input);
  if (errs.length) throw new Error(`Invalid world manifest: ${errs.join("; ")}`);
  return input as WorldManifest;
}

export function parseGraph(input: unknown): NavigationGraph {
  const errs = validateGraph(input);
  if (errs.length) throw new Error(`Invalid navigation graph: ${errs.join("; ")}`);
  return input as NavigationGraph;
}

export function parseMeasurements(input: unknown): Measurement[] {
  const errs = validateMeasurements(input);
  if (errs.length) throw new Error(`Invalid measurements: ${errs.join("; ")}`);
  return input as Measurement[];
}

/** Straight-line length of every edge, used for the "routes" summary in the UI. */
export function graphLengthMetres(graph: NavigationGraph | undefined): number {
  if (!graph) return 0;
  const byId = new Map(graph.nodes.map((n) => [n.id, n.position]));
  return graph.edges.reduce((sum, e) => {
    if (e.distance !== undefined) return sum + e.distance;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return sum;
    return sum + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }, 0);
}

export function formatSplatCount(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
