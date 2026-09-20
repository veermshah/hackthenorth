"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  badEdgeKeys,
  DEFAULT_NAVMESH_PARAMS,
  type GraphIssue,
  type GraphValidation,
  type NavmeshParams,
  type NavmeshProposal,
} from "@/lib/navmesh";
import type { NavigationGraph, WorldManifest } from "@/lib/world-manifest";

export type MeshJob = { running: boolean; error: string | null };

/**
 * Editor-side state for the mesh tools: validating the live graph against the
 * collision mesh (edges through walls, off-floor nodes, floor snapping) and
 * reviewing a graph proposal generated from the mesh. Nothing here changes the
 * world's graph until the reviewer explicitly accepts (`PUT /graph`).
 */
export function useMeshTools(worldId: string, manifest: WorldManifest | null, graph: NavigationGraph) {
  const base = `/api/worlds/${encodeURIComponent(worldId)}`;
  const hasMesh = !!manifest?.assets.mesh;

  const [validation, setValidation] = useState<GraphValidation | null>(null);
  const [validating, setValidating] = useState<MeshJob>({ running: false, error: null });
  const [proposal, setProposal] = useState<NavmeshProposal | null>(null);
  const [building, setBuilding] = useState<MeshJob>({ running: false, error: null });
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState<MeshJob>({ running: false, error: null });
  const [params, setParams] = useState<Omit<NavmeshParams, "frame">>(DEFAULT_NAVMESH_PARAMS);

  // A validation describes one particular graph; drop it when the graph changes underneath.
  const validatedGraph = useRef<NavigationGraph | null>(null);
  useEffect(() => {
    if (validatedGraph.current && validatedGraph.current !== graph) {
      setValidation(null);
      validatedGraph.current = null;
    }
  }, [graph]);

  // Pick up a proposal left by an earlier session (or a Modal job).
  useEffect(() => {
    if (!hasMesh) return;
    let cancelled = false;
    fetch(`${base}/navmesh`)
      .then((res) => (res.ok ? (res.json() as Promise<NavmeshProposal>) : null))
      .then((p) => {
        if (!cancelled && p) setProposal(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [base, hasMesh]);

  const validate = useCallback(async () => {
    setValidating({ running: true, error: null });
    try {
      const result = await postJson<GraphValidation>(`${base}/graph/validate`, { graph, snap: true });
      validatedGraph.current = graph;
      setValidation(result);
      setValidating({ running: false, error: null });
    } catch (err) {
      setValidating({ running: false, error: message(err) });
    }
  }, [base, graph]);

  const build = useCallback(async () => {
    setBuilding({ running: true, error: null });
    try {
      const result = await postJson<NavmeshProposal>(`${base}/navmesh`, { params });
      setProposal(result);
      setPreview(true);
      setBuilding({ running: false, error: null });
    } catch (err) {
      setBuilding({ running: false, error: message(err) });
    }
  }, [base, params]);

  /** Replace the world's graph (with the snapped copy or the accepted proposal); returns the new manifest. */
  const saveGraph = useCallback(
    async (next: NavigationGraph, sourceRevision?: string): Promise<WorldManifest | null> => {
      setSaving({ running: true, error: null });
      try {
        const res = await fetch(`${base}/graph`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...(sourceRevision ? { "if-match": sourceRevision } : {}) },
          body: JSON.stringify(next),
        });
        if (!res.ok) throw new Error(await readError(res, "Could not save the graph"));
        setSaving({ running: false, error: null });
        return (await res.json()) as WorldManifest;
      } catch (err) {
        setSaving({ running: false, error: message(err) });
        return null;
      }
    },
    [base],
  );

  /** Nodes / edges the validator rejected in the graph currently drawn (live or proposal). */
  const flags = useMemo(() => {
    const issues: GraphIssue[] = preview && proposal ? proposal.proposalIssues ?? [] : validation?.issues ?? [];
    if (issues.length === 0) return undefined;
    const nodes = new Set<string>();
    for (const issue of issues) if ("node" in issue) nodes.add(issue.node);
    return { nodes, edges: badEdgeKeys(issues) };
  }, [validation, preview, proposal]);

  /** Node heights the validator moved by more than a centimetre. */
  const snappedCount = useMemo(() => {
    if (!validation) return 0;
    const before = new Map(graph.nodes.map((n) => [n.id, n.position[1]]));
    return validation.graph.nodes.filter((n) => Math.abs((before.get(n.id) ?? n.position[1]) - n.position[1]) > 0.01).length;
  }, [validation, graph]);

  return {
    hasMesh,
    validation,
    validating,
    validate,
    snappedCount,
    proposal,
    building,
    build,
    params,
    setParams,
    preview: preview && !!proposal,
    setPreview,
    discardProposal: () => {
      setProposal(null);
      setPreview(false);
    },
    saving,
    saveGraph,
    flags,
  };
}

export type MeshTools = ReturnType<typeof useMeshTools>;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, "Request failed"));
  return (await res.json()) as T;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${fallback} (${res.status})`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
