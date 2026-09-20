# Main world integration

The canonical world schema and API from main take precedence. The CLI now accepts
world.json for --graph, binding reviews to the full manifest hash and active asset
version. PUT /worlds/{id}/annotations publishes reviewed nodes and stores evidence
in a separate annotations.json; POST /worlds/{id}/index refreshes Elastic. Both
require X-API-Key. See services/backend/WORLDS_MIGRATION.md. Legacy Graph JSON
export/restart instructions below apply only to /legacy navigation.

---

# Semantic annotation handoff (implemented MVP)

The pipeline is an offline operator CLI, not an HTTP upload endpoint. No SAM,
automatic 3D projection, segmentation training, or automatic route generation is
implemented. The scan viewer/client can build a review UI around these contracts.

## Input from capture / Niantic team

- Original JPEG/PNG images or FFmpeg-decodable perspective walkthrough video.
- Site ID, floor number, immutable scan/map revision identifier.
- Existing navigation graph in the same metric coordinate frame as localization.
- A reviewed approach waypoint for every published feature. The position of a
  sign is not necessarily the position of its door or the walkable approach.
- Preserve source media. The PLY can be used for review; it is not sent to OpenAI.
- 360 videos must first be converted into perspective images externally. This
  version does not unwarp panoramas or process raw INSV containers.
- For future automatic placement: synchronized per-frame camera-to-map poses,
  intrinsics/projection convention, registered depth or usable mesh, metric
  scale, and the transform into the navigation coordinate frame.

## Artifacts

`AnnotationBatch` and `ReviewFile` schemas are in backend.schema.json. Each batch
contains candidate IDs, descriptions, visible sign text, uncertainty, image
filenames and SHA256 hashes. Sample timestamps are approximate, not pose timestamps.
Empty findings are valid. Candidates have no usable navigation position.

An operator prepares a review file and explicitly decides approve/reject/duplicate/note
for every candidate. Fill verified_by and verified_at (ISO 8601 recommended),
assign an existing waypoint_id for approvals and notes, optionally supply a complete
corrected Finding, and record notes. Duplicate decisions reference an approved
candidate in the same batch. The review binds the exact batch and graph hashes.
These are operator assertions, not cryptographic identity verification.

Publication validates the review and exports a new Graph. Approved records become
destinations with `annotation` evidence metadata (now including category, permanence,
navigation_role, visual_location and uncertainty as filterable fields, not only free
text). `note` decisions are kept as searchable, non-navigable context/hazard evidence
(see Context-only retrieval below) rather than being discarded. Rejected/duplicate
candidates are excluded. Neither model uncertainty nor designation implies
accessibility. Routes continue to use the manually surveyed edge accessibility flags.

For the world-manifest publish path (`PUT /worlds/{id}/annotations`), the backend
reindexes Elasticsearch inline as part of the same request (best-effort: a
temporarily unavailable Elasticsearch logs a warning but does not fail publication).
`POST /worlds/{id}/index` remains available as a manual repair/backfill tool, but is
no longer a required step after publishing. For the legacy flat-graph CLI path
(`annotate_scan.py` without `--api-url`), indexing is still a separate `--index` step;
index the exported graph and restart the backend with GRAPH_PATH set to it, and
preserve batch/review files for auditing.

## Posed proposals from stored VPS frames (Astra as annotator)

`POST /worlds/{id}/annotations/propose` (body: optional `queryIds`, `limit` 1..50,
`floor`) runs the annotation model over the newest stored `localize/query` frames
that localized and kept their pose + FOV. The model returns semantics plus an
`image_point` (normalised u,v where the feature meets the floor); the backend casts
a ray from the stored camera pose through that pixel and places the candidate where
it hits the aligned mesh (`assets.mesh`), else the floor plane. Each candidate keeps
`frame`/`frame_sha256`, `position`, and `placement` (`method`, `distance_metres`,
`query_id`, `image_point`, `nearest_node`, `nearest_node_metres`). Rays that hit
nothing within 15 m leave `position` null and say so in `uncertainty`. The result is
written to `annotation-proposals.json` (`GET /worlds/{id}/annotations/proposals`) and
never touches `navigationGraph`; review it with the same `ReviewFile` and publish via
`PUT /worlds/{id}/annotations`, where an approved candidate with a `position` becomes
a node at that position and one without is placed at its approach waypoint.

Published, permanent annotations (and nothing noted as a hazard or context-only) are
then used as spoken landmarks: route instructions gain a `landmarks` array (`at`
within 3 m of the turn node, `left`/`right` within 2.5 m of the leg) and the
assistant's `get_current_location` lists nearby reviewed landmarks with a
heading-relative bearing. Routes, distances and floor changes still come only from
the graph.

## Review client requirements

Display candidate evidence images with names/sign text and uncertainty. Allow
corrections, duplicate merging, rejection and waypoint selection. Never approve
by default. Validate floor/door association and reachable side of walls. Do not
expose OpenAI keys. This backend change does not implement the review frontend.
# Expanded visual annotations

Findings now cover doors, corridors/junctions, ramps/escalators, signs/directories,
floor indicators, tactile paving, handrails/buttons, emergency equipment, furniture,
windows/pillars/artwork, services, waste/storage/charging, visible obstacles, surface
changes and scene context, in addition to the original destination categories.
Each finding includes permanence (fixed/movable/temporary/unknown), navigation_role
(destination/landmark/context/potential_hazard), visual_location (image-relative,
never user-relative), navigation_relevance and uncertainty. Defaults allow older
candidate files to load; existing reviews must be regenerated if their digest changes.
These are recorded observations, not live obstacle detections or accessibility proof.
Context, potential_hazard and temporary findings remain review evidence; publishing
them as routing destinations is rejected. Permanent/movable landmarks still require
reviewed approach waypoints.

## Context-only retrieval

A `note` review decision indexes a finding as searchable evidence (`map_entities`,
`is_destination: false`) without ever making it a routing destination. The
`search_context` assistant tool runs the same hybrid (BM25 + kNN, optionally
reranked) retrieval as `search_places`, filtered to non-destination evidence and
optionally by floor, and returns terms aggregations by `category` and
`navigation_role` alongside the matches. `get_obstacle_hotspots` separately runs an
ES|QL `STATS ... BY nearest_waypoint_id, floor` aggregation over `live_events` to
surface recurring obstacle reports across sessions. Both are historical/reviewed
evidence, never a live sensor claim, and the assistant prompt is written accordingly.

Use scan_pipeline --reannotate to preserve prior output and rerun with the expanded
prompt. This invokes paid annotation again; cached pipeline output is otherwise reused.
