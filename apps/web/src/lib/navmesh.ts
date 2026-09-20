/**
 * Mesh-derived navigation data — the TypeScript mirror of the backend's
 * `POST /worlds/:id/navmesh` and `POST /worlds/:id/graph/validate` responses
 * (`services/backend/app/routing/navmesh.py`). A proposal is never the live
 * graph: the reviewer accepts it in the viewer with `PUT /graph`.
 */
import type { NavigationGraph, Vec3 } from "./world-manifest";

export type NavmeshParams = {
  /** Grid cell size in metres (0.05–1). */
  cell: number;
  /** Half the width of a person; walkable space is eroded by this. */
  agentRadius: number;
  /** Anything solid between `stepHeight` and this height above the floor blocks a cell. */
  agentHeight: number;
  /** Bumps lower than this (thresholds, cables) are not obstacles. */
  stepHeight: number;
  /** Waypoint lattice spacing in metres. */
  spacing: number;
  floorSlopeDeg: number;
  seed: number;
  frame: "world" | "splat";
};

export const DEFAULT_NAVMESH_PARAMS: Omit<NavmeshParams, "frame"> = {
  cell: 0.15,
  agentRadius: 0.3,
  agentHeight: 1.8,
  stepHeight: 0.25,
  spacing: 1.5,
  floorSlopeDeg: 30,
  seed: 0,
};

/** Occupancy grid over XZ; `rows[z][x]` is '.' walkable, 'x' blocked / no floor, ' ' no data. */
export type NavmeshGrid = {
  /** [x, floorY, z] of the grid corner; cell (ix, iz) is centred at origin + (ix + 0.5, ·, iz + 0.5) · cell. */
  origin: Vec3;
  cell: number;
  width: number;
  height: number;
  floorY: number;
  rows: string[];
  walkableCells: number;
  floorCells: number;
  excludedWalkableCells?: number;
};

export type GraphIssue =
  | { kind: "node-off-floor" | "node-edge-of-floor" | "node-in-obstacle" | "node-clearance"; node: string; message: string }
  | { kind: "node-height"; node: string; offsetMetres: number; message: string }
  | { kind: "edge-through-wall" | "edge-off-floor" | "edge-clearance"; from: string; to: string; at?: Vec3; message: string };

export type NavmeshProposal = {
  schema: "wander.navmesh/v1";
  worldId: string;
  mesh: string;
  status: "proposed";
  params: NavmeshParams;
  grid: NavmeshGrid;
  graph: NavigationGraph;
  /** Problems the grid found in the world's *current* graph, for comparison. */
  currentGraphIssues: GraphIssue[];
  /** Optional for proposals cached before the generator upgrade. */
  proposalIssues?: GraphIssue[];
  sourceRevision?: string;
  places?: { id: string; name: string; connected: boolean; movedMetres: number }[];
  createdAt: string;
};

export type GraphValidation = {
  issues: GraphIssue[];
  /** The checked graph with node heights snapped onto the floor. */
  graph: NavigationGraph;
  floorY: number;
  checkedAt: string;
};

export function issueLabel(issue: GraphIssue): string {
  switch (issue.kind) {
    case "edge-through-wall":
      return "Through a wall";
    case "edge-off-floor":
      return "Leaves the floor";
    case "node-off-floor":
      return "Off the floor";
    case "node-edge-of-floor":
      return "Edge of floor";
    case "node-in-obstacle":
      return "Inside an obstacle";
    case "node-clearance":
    case "edge-clearance":
      return "Needs more clearance";
    case "node-height":
      return "Wrong height";
  }
}

export function issueTarget(issue: GraphIssue): string {
  return "node" in issue ? issue.node : `${issue.from} → ${issue.to}`;
}

/** Edges the validator flagged, keyed "from|to" both ways so the engine can colour them. */
export function badEdgeKeys(issues: GraphIssue[]): Set<string> {
  const keys = new Set<string>();
  for (const issue of issues)
    if ("from" in issue) {
      keys.add(`${issue.from}|${issue.to}`);
      keys.add(`${issue.to}|${issue.from}`);
    }
  return keys;
}
