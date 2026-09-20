"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { issueLabel, issueTarget, type GraphIssue, type NavmeshParams, type NavmeshProposal } from "@/lib/navmesh";
import { graphLengthMetres, type NavigationGraph, type WorldManifest } from "@/lib/world-manifest";
import type { ViewerSelection } from "./SplatViewerEngine";
import type { MeshTools } from "./useMeshTools";

export type WaypointsTabProps = {
  manifest: WorldManifest | null;
  graph: NavigationGraph;
  tools: MeshTools;
  selection: ViewerSelection | null;
  onSelect: (sel: ViewerSelection | null) => void;
  onFocusNode: (id: string) => void;
  /** Called after a graph write (snap / accept) with the manifest the server returned. */
  onGraphSaved: (manifest: WorldManifest, text: string) => void;
  /** Opens the upload dialog — the one place a mesh is added to a world. */
  onUploadMesh?: () => void;
  /** Whether the server can run the mesh tools (needs the worlds backend). */
  source: "api" | "local";
};

/**
 * Waypoints tab: the graph validator (edges through walls, off-floor nodes,
 * floor snapping) and the review gate for graphs generated from the aligned
 * mesh. Generated geometry only becomes the world's graph when the reviewer
 * accepts it here. The mesh itself is uploaded with the world, not from here.
 */
export function WaypointsTab(p: WaypointsTabProps) {
  const { manifest, tools } = p;
  if (!manifest)
    return <p className="p-4 text-body-sm text-void-black/50">Add world.json to this world to generate waypoints.</p>;
  if (!tools.hasMesh) return <NoMesh onUploadMesh={p.onUploadMesh} />;
  if (p.source === "local")
    return (
      <p className="p-4 text-body-sm text-void-black/50">
        Graph checks and generation run in the worlds backend. Set <code>WANDER_API_URL</code> to use them here.
      </p>
    );
  return (
    <div>
      <Validator {...p} />
      <Proposal {...p} />
    </div>
  );
}

/** Nothing to work from: waypoints are derived from the aligned mesh. */
function NoMesh({ onUploadMesh }: { onUploadMesh?: () => void }) {
  return (
    <div className="p-4">
      <h3 className="text-caption font-semibold tracking-[0.01em] text-void-black/50 uppercase">Waypoints from the mesh</h3>
      <p className="mt-2 text-body-sm text-void-black/50">
        Checking and generating waypoints needs the aligned Scaniverse <code>mesh.glb</code>. It is uploaded with the
        world — add one now and it lands in this version.
      </p>
      {onUploadMesh && (
        <button type="button" className="btn-ghost mt-3 w-full" onClick={onUploadMesh}>
          <Icon name="upload" size={15} />
          Upload a mesh
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- validator */

function Validator({ graph, tools, selection, onSelect, onFocusNode, onGraphSaved }: WaypointsTabProps) {
  const { validation, validating, validate, snappedCount, saving, saveGraph, preview } = tools;
  const disabled = graph.nodes.length === 0 || validating.running || preview;

  return (
    <div className="border-b border-hairline p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-caption font-semibold tracking-[0.01em] text-void-black/50 uppercase">Check waypoints</h3>
        {validation && (
          <span className="text-caption text-void-black/40">
            {validation.issues.length === 0 ? "No issues" : `${validation.issues.length} issues`} · floor {validation.floorY.toFixed(2)} m
          </span>
        )}
      </div>
      <p className="mt-2 text-body-sm text-void-black/50">
        Flags edges that cut through walls, waypoints off the scanned floor, and heights that do not sit on it. Flagged parts
        turn pink in the scene.
      </p>
      <button type="button" className="btn-ghost mt-3 w-full" disabled={disabled} onClick={validate}>
        <Icon name="check" size={15} />
        {validating.running ? "Checking…" : graph.nodes.length === 0 ? "No waypoints to check" : "Check against the mesh"}
      </button>
      {validating.error && <Alert>{validating.error}</Alert>}

      {validation && (
        <>
          {validation.issues.length > 0 && (
            <IssueList issues={validation.issues} selection={selection} onSelect={onSelect} onFocusNode={onFocusNode} />
          )}
          {snappedCount > 0 && (
            <button
              type="button"
              className="btn-primary mt-3 w-full"
              disabled={saving.running}
              onClick={async () => {
                const manifest = await saveGraph(validation.graph);
                if (manifest) onGraphSaved(manifest, `Snapped ${snappedCount} waypoints to the floor`);
              }}
            >
              <Icon name="save" size={15} />
              {saving.running ? "Saving…" : `Snap ${snappedCount} ${snappedCount === 1 ? "waypoint" : "waypoints"} to the floor`}
            </button>
          )}
          {saving.error && <Alert>{saving.error}</Alert>}
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- proposal */

const PARAM_FIELDS: { key: keyof Omit<NavmeshParams, "frame" | "seed" | "floorSlopeDeg">; label: string; step: number; min: number; max: number }[] = [
  { key: "cell", label: "Cell size (m)", step: 0.05, min: 0.05, max: 1 },
  { key: "agentRadius", label: "Person radius (m)", step: 0.05, min: 0.1, max: 1 },
  { key: "stepHeight", label: "Step height (m)", step: 0.05, min: 0.05, max: 0.6 },
  { key: "spacing", label: "Waypoint spacing (m)", step: 0.25, min: 0.5, max: 6 },
];

function Proposal({ tools, onGraphSaved }: WaypointsTabProps) {
  const { proposal, building, build, params, setParams, preview, setPreview, discardProposal, saving, saveGraph } = tools;
  const [showParams, setShowParams] = useState(false);
  const disconnected = proposal?.places?.filter((place) => !place.connected) ?? [];
  const needsRegeneration = !!proposal && !proposal.sourceRevision;
  const hasIssues = !!proposal?.proposalIssues?.length || disconnected.length > 0;

  return (
    <div className="p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-caption font-semibold tracking-[0.01em] text-void-black/50 uppercase">Generate waypoints</h3>
        {proposal && (
          <span className="text-caption text-void-black/40">
            {proposal.graph.nodes.length} · {Math.round(graphLengthMetres(proposal.graph))} m
          </span>
        )}
      </div>
      <p className="mt-2 text-body-sm text-void-black/50">
        Finds walking paths with room around walls and furniture. Keeps your named places and simplifies
        the connections between them. Review the paths before accepting.
      </p>

      <button
        type="button"
        className="btn-text mt-2 w-full justify-between px-2"
        aria-expanded={showParams}
        onClick={() => setShowParams((v) => !v)}
      >
        <span className="text-caption text-void-black/60">Grid settings</span>
        <Icon name={showParams ? "chevronDown" : "chevronRight"} size={14} />
      </button>
      {showParams && (
        <div className="grid grid-cols-2 gap-2 px-1 pb-1">
          {PARAM_FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-caption text-void-black/60">
              {f.label}
              <input
                type="number"
                className="input px-2 py-1 text-body-sm tabular-nums"
                value={params[f.key]}
                step={f.step}
                min={f.min}
                max={f.max}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setParams({ ...params, [f.key]: v });
                }}
              />
            </label>
          ))}
        </div>
      )}

      <button type="button" className="btn-ghost mt-2 w-full" disabled={building.running} onClick={build}>
        <Icon name="route" size={15} />
        {building.running ? "Finding walking paths…" : proposal ? "Generate again" : "Generate from the mesh"}
      </button>
      {building.error && <Alert>{building.error}</Alert>}

      {proposal && (
        <div className="mt-3 rounded-xl border border-hairline bg-stellar-white p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="pill-sm bg-pink-tint text-wander-pink">Proposed · not live</span>
            <span className="text-caption text-void-black/40">{new Date(proposal.createdAt).toLocaleString()}</span>
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-sm">
            <Row label="Walkable">
              {(proposal.grid.walkableCells * proposal.grid.cell ** 2).toFixed(0)} m² of{" "}
              {(proposal.grid.floorCells * proposal.grid.cell ** 2).toFixed(0)} m² floor
            </Row>
            <Row label="Floor">{proposal.grid.floorY.toFixed(2)} m</Row>
            <Row label="Grid">
              {proposal.grid.width} × {proposal.grid.height} @ {proposal.params.cell} m
            </Row>
            {proposal.currentGraphIssues.length > 0 && (
              <Row label="Current graph">{proposal.currentGraphIssues.length} issues against this mesh</Row>
            )}
          </dl>
          <OccupancyPreview proposal={proposal} />
          <p className="mt-2 text-caption text-void-black/60">Blue paths · pink destinations · sky walking area</p>
          {!!proposal.places?.length && (
            <div className="mt-3 text-body-sm">
              <p className="font-medium text-void-black">Named places kept</p>
              <ul className="mt-1 space-y-1">
                {proposal.places.map((place) => (
                  <li key={place.id} className="flex justify-between gap-2">
                    <span className="truncate text-void-black/80">{place.name}</span>
                    <span className={place.connected ? "text-void-black/60" : "text-wander-pink"}>
                      {!place.connected ? "No walking connection" : place.movedMetres > 0.1 ? `Adjusted ${place.movedMetres.toFixed(1)} m` : "Connected"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!proposal.grid.excludedWalkableCells && (
            <p className="mt-2 text-caption text-void-black/60">
              {(proposal.grid.excludedWalkableCells * proposal.grid.cell ** 2).toFixed(1)} m² of separate floor has no connection to these paths.
            </p>
          )}
          {needsRegeneration && <Alert>This preview uses the earlier generator. Generate again to keep your named places.</Alert>}
          {hasIssues && <Alert>Some places or paths cannot be connected with enough clearance. Check their positions and the mesh, then generate again.</Alert>}

          <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 rounded-lg px-1 py-1 text-body-sm text-void-black">
            <span className="inline-flex items-center gap-2">
              <Icon name="eye" size={15} />
              Preview in the scene
            </span>
            <input type="checkbox" className="size-4 accent-wander-blue" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
          </label>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={saving.running || building.running || needsRegeneration || hasIssues}
              onClick={async () => {
                const manifest = await saveGraph(proposal.graph, proposal.sourceRevision);
                if (manifest) {
                  discardProposal();
                  onGraphSaved(manifest, `Accepted ${proposal.graph.nodes.length} waypoints and places`);
                }
              }}
            >
              <Icon name="check" size={15} />
              {saving.running ? "Saving…" : "Accept as the graph"}
            </button>
            <button type="button" className="btn-text" onClick={discardProposal}>
              Dismiss
            </button>
          </div>
          {saving.error && <Alert>{saving.error}</Alert>}
        </div>
      )}
    </div>
  );
}

/** Tiny top-down map of the occupancy grid ('.' walkable, 'x' blocked, ' ' unscanned). */
function OccupancyPreview({ proposal }: { proposal: NavmeshProposal }) {
  const { rows, origin, cell } = proposal.grid;
  const points = new Map(proposal.graph.nodes.map((node) => [node.id, {
    x: (node.position[0] - origin[0]) / cell,
    y: (node.position[2] - origin[2]) / cell,
  }]));
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (!height || !width) return null;
  const rects: ReactNode[] = [];
  // Run-length encode each row so a 200×200 grid stays a few hundred elements.
  rows.forEach((row, z) => {
    let start = 0;
    for (let x = 1; x <= row.length; x++) {
      if (x < row.length && row[x] === row[start]) continue;
      const c = row[start];
      if (c !== " ")
        rects.push(
          <rect key={`${z}-${start}`} x={start} y={z} width={x - start} height={1} fill={c === "." ? "#60baf4" : "#1e293b"} />,
        );
      start = x;
    }
  });
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Proposed walking paths and destinations over the scanned floor"
      className="mt-3 max-h-48 w-full rounded-lg border border-hairline bg-pure-white"
      shapeRendering="crispEdges"
      preserveAspectRatio="xMidYMid meet"
    >
      {rects}
      <g shapeRendering="geometricPrecision">
        {proposal.graph.edges.map((edge) => {
          const a = points.get(edge.from), b = points.get(edge.to);
          return a && b ? <line key={`${edge.from}-${edge.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke="#2e4885" strokeWidth={1.5} vectorEffect="non-scaling-stroke" /> : null;
        })}
        {proposal.graph.nodes.map((node) => {
          const point = points.get(node.id)!;
          return <circle key={node.id} cx={point.x} cy={point.y} r={node.name ? 0.8 : 0.45}
            fill={node.kind === "destination" ? "#d85598" : "#2e4885"}>
            <title>{node.name ?? node.id}</title>
          </circle>;
        })}
      </g>
    </svg>
  );
}

/* ----------------------------------------------------------------- pieces */

function IssueList({
  issues,
  selection,
  onSelect,
  onFocusNode,
}: {
  issues: GraphIssue[];
  selection: ViewerSelection | null;
  onSelect: (sel: ViewerSelection | null) => void;
  onFocusNode: (id: string) => void;
}) {
  const selected = selection?.kind === "node" ? selection.id : null;
  return (
    <ul className="mt-3 max-h-56 space-y-0.5 overflow-y-auto">
      {issues.map((issue, i) => {
        const node = "node" in issue ? issue.node : issue.from;
        const isSel = node === selected;
        return (
          <li key={i}>
            <button
              type="button"
              title={`${issue.message} · double-click to fly to`}
              onClick={() => onSelect(isSel ? null : { kind: "node", id: node })}
              onDoubleClick={() => onFocusNode(node)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body-sm transition-colors duration-200 ${
                isSel ? "bg-sky-tint text-wander-blue" : "text-void-black/80 hover:bg-void-black/5 hover:text-void-black"
              }`}
            >
              <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full bg-wander-pink" />
              <span className="flex-1 truncate">{issueTarget(issue)}</span>
              <span className="shrink-0 text-caption text-void-black/50">{issueLabel(issue)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-2 text-caption text-wander-pink">
      {children}
    </p>
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
