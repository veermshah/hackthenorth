# Shared contracts

Schemas shared by the Next.js web app, the iOS app (Niantic Lightship SDK + ARKit), and the FastAPI backend on Modal.

| File | What it defines |
| --- | --- |
| [`worlds-api.openapi.yaml`](worlds-api.openapi.yaml) | The Modal FastAPI service: worlds + assets on the Volume, graph/measurement persistence, Niantic localization, routing, live sessions (REST + WebSocket). Start here if you are building the backend. |
| [`world.schema.json`](world.schema.json) | `worlds/<id>/world.json` — a world's manifest: Niantic site id, asset version, splat path, navigation graph, alignment. |
| [`notes.schema.json`](notes.schema.json) | `worlds/<id>/notes.json` — notes pinned to the scan (title, location, description, position). |
| [`measurements.schema.json`](measurements.schema.json) | `worlds/<id>/measurements.json` — distances measured in the web viewer. |
| [`navigation.schema.json`](navigation.schema.json) | Messages between phone ⇄ backend ⇄ dashboard: `LocalizationUpdate`, `RouteRequest/Response`, `PoseUpdate`, `ProgressUpdate`, `SessionEvent`, `VpsSiteStatus`. |
| [`examples/`](examples/) | Sample documents. |

TypeScript mirrors live in `apps/web/src/lib/world-manifest.ts`. Generate Swift models for the iOS app from the JSON schemas (e.g. quicktype) rather than hand-writing them.

## Storage layout on the Modal Volume

Assets are organised by world and version. Versions are immutable: re-exporting a scan creates `v2`, it never overwrites `v1`.

```text
worlds/
└── demo-building/
    ├── world.json           # manifest (schema above) — source of truth for the navigation graph
    ├── notes.json           # notes pinned in the web viewer (optional)
    ├── measurements.json    # web-viewer measurements (optional)
    ├── navmesh.json         # graph proposal generated from mesh.glb, awaiting review (optional)
    ├── vps-status.json      # last successful phone localization against the site
    ├── localizations/       # VPS image queries mirrored by the phone (newest 50)
    │   ├── index.json       # LocalizationQuery records, newest first
    │   └── q-<id>.jpg       # the camera frame the SDK submitted for that query
    └── v1/
        ├── scene.spz        # Gaussian splat exported from Scaniverse
        ├── thumbnail.png    # optional 16:10 preview
        ├── mesh.glb         # optional aligned Scaniverse mesh (see `meshFrame`): raycast target, graph checks, graph generation
        └── vps-map.bin      # optional VPS map export for the phone
sessions/
└── <sessionId>.json         # navigation session state (a Modal Dict works too)
```

`world.json` records the Niantic VPS site id, the active asset `version`, the splat path, the `navigationGraph` used for routing, and the `alignment` that maps splat coordinates into the shared world frame. The web viewer applies `alignment` to the splat and draws the graph on top, so the displayed world is the one the phone localises against. Notes and measurements made in the viewer autosave with `PUT /worlds/{id}/notes` and `PUT /worlds/{id}/measurements`; the graph itself is edited through `PUT /worlds/{id}/graph`. When a world has `assets.mesh`, `POST /worlds/{id}/graph/validate` flags edges through walls and off-floor waypoints and returns a floor-snapped copy, and `POST /worlds/{id}/navmesh` grids the mesh into a proposed graph (`navmesh.json`); neither changes `navigationGraph` — the reviewer accepts with `PUT /graph`.

## Upload flow (web → backend)

The dashboard's **New world / Import splat** dialog and the viewer's **Upload splat** button run:

1. `POST /worlds` `{ id, name, space?, nianticSiteId?, splatFilename }` → draft manifest (skipped for existing worlds).
2. `PUT /worlds/{id}/{version}/scene.spz` with the raw bytes, streamed through the Next.js proxy (`PUT /api/worlds/...`) so the browser never sees the API key. A `409` (file already at that version) makes the web app retry at the next version.
3. `PATCH /worlds/{id}` `{ version?, assets?, status }` to point the manifest at the new file and flip `draft → processing` (or `aligned` when a Niantic site id is set).

Files stream end-to-end; nothing is held in memory. Note the Next.js proxy must run somewhere without a small request-body cap (Node host, container, `next start`) — Vercel serverless functions cap bodies at ~4.5 MB, which is far below a splat. If that becomes the deployment target, add a signed-URL upload endpoint to this contract and have the browser PUT to the backend directly.

## Frames

- **Splat frame** — raw coordinates in `scene.spz`, as exported.
- **World frame** — where routing happens. `alignment` maps splat → world: `p_world = rotation · (scale · p_splat) + position`. When a world is published to Niantic, the world frame *is* the VPS site frame (`alignment.frame: "niantic-vps"`), so poses coming from the Lightship SDK need no further transform.
- `navigationGraph.frame` says which of the two the node positions use (`world` by default). Measurements are always in the world frame.

## Backend responsibilities (Modal)

1. **Volume as the DB.** All reads/writes go through the API; nothing else mounts the volume. Writes to `world.json` are read-modify-write with a per-world lock; assets are write-once per version.
2. **Auth.** Every request carries `X-API-Key` (below).
3. **Niantic SDK bridge.** The SDK runs on the phone. The backend receives its localization results (`POST /worlds/{id}/localize`), checks the `nianticSiteId` matches the world, re-expresses poses in the world frame, and exposes site status (`GET /worlds/{id}/vps`). If a Lightship API key is configured, it also asks Niantic whether the location is activated. The phone also mirrors every VPS *image query* the SDK issued (`POST /worlds/{id}/localize/query`: the submitted camera frame as JPEG, the SDK's `Vps2LocalizationRequestRecord`, and the camera pose at capture time in the site frame); the backend keeps the newest 50 under `localizations/` and the web viewer polls `GET /worlds/{id}/localizations` to draw the phone on the splat next to the image it sent.
4. **Routing.** Dijkstra over the graph; turn instructions from leg headings, the first one relative to the traveller's `headingDeg` when given; off-route / arrival detection on every `POST /sessions/{id}/pose`; live `SessionEvent`s over `/ws/sessions/{id}` for the dashboard. Headings are degrees clockwise from above with 0 = -Z, 90 = +X (the yaw of an identity-rotation ARKit camera); every route threshold (snap, leg advance at 1.5 m, off-route at 3 m, arrival) uses horizontal XZ distance because nodes sit on the floor and the phone is at chest height. The `progressUpdate` answer to a pose carries the live heading-relative `instruction` and, when there is something new to say, `speak`. Graph edges carry `kind` (`walk` | `stairs` | `escalator` | `elevator` | `ramp`) and `accessible` (defaults false for stairs / escalators, true otherwise); nodes carry `floor`, and only a non-walk edge may join two floors. A route request or session with `accessibleOnly: true` drops inaccessible edges, so floor changes go by elevator or ramp; a vertical leg produces a `Take the elevator to floor 2.` instruction, and the leg is not advanced until the traveller is at the target storey.
5. **CPU only.** Rendering happens in the browser.

## Phone hand-off link (QR code)

The world viewer shows a QR code that configures the front phone for that world. It encodes a custom-scheme URL the iOS app registers (`CFBundleURLTypes`) and can also scan in-app:

```text
wander://connect?v=1&world=<worldId>&site=<nianticSiteId>&backend=<https://…modal.run>&name=<display name>
```

| Query param | Required | Meaning |
| --- | --- | --- |
| `v` | yes | Link version, currently `1`. Unknown versions are ignored by the phone. |
| `world` | yes | `world.json` id (`^[a-z0-9][a-z0-9._-]{0,63}$`). Becomes `CameraSettings.worldId`. |
| `site` | no | `nianticSiteId` from the manifest. Becomes `CameraSettings.nianticSiteId`; omitted when the world is not published to Niantic yet. |
| `backend` | no | Base URL of the worlds API (`WANDER_API_URL`; the Next.js origin + `/api` in local mode). Becomes `CameraSettings.backendURL`. |
| `name` | no | Human-readable world name for the confirmation toast. |

The link never carries secrets: the `X-API-Key` and the Niantic developer token stay in the phone's `LocalConfig.plist` / Settings. Scanning only fills in *which* world, site and backend to talk to.

## Authentication — API key

Every request carries a shared secret in the `X-API-Key` header:

```http
GET /worlds/demo-building HTTP/1.1
X-API-Key: <WANDER_API_KEY>
```

- The backend reads the expected value from the `WANDER_API_KEY` environment variable (a Modal Secret) and compares with a constant-time check (`secrets.compare_digest`). Missing or wrong key → `401 {"detail": "invalid api key"}`.
- The Next.js proxy sends the header from its own `WANDER_API_KEY` env var; the key never reaches the browser. The phone sends it directly.
- One key for the whole team is fine for the hackathon. Rotate by changing the secret on both sides.

## Rules

- `id`, `version`, and `filename` match `^[A-Za-z0-9][A-Za-z0-9._-]*$` (no dotfiles, no `..`); reject anything else with `400` so nothing can escape `worlds/`.
- Asset downloads set `Content-Length` and `Cache-Control: public, max-age=31536000, immutable`.
- `PUT /worlds/{id}/graph` must validate: unique node ids, every edge references a node, `kind` ∈ {waypoint, entrance, destination}.

## Local development without the backend

Leave `WANDER_API_URL` unset and the web app reads and writes the same `worlds/…` layout under `maps/assets/` (git-ignored). Use `npm run world:add` in `apps/web` to register a Scaniverse export; notes and measurements saved in the viewer land in `maps/assets/worlds/<id>/notes.json` and `measurements.json`, ready to upload with `modal volume put`.
