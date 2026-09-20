import asyncio
import base64
import binascii
import hashlib
import json
import logging
import mimetypes
import shutil
import time
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from ..routing import navmesh
from .uploads import TICKET_HEADER
from ..services.worlds import check, now, note_search_document, segment, validate_graph, world_graph, snap, node_ref, horizontal

router = APIRouter()
logger = logging.getLogger(__name__)

# Newest image queries kept per world; older JPEGs are deleted with their records.
LOCALIZATIONS_KEPT = 50
# The VPS status file is a freshness badge, not a data stream, and /localize arrives five times a
# second. Every stamp takes the world lock and writes a file, which is exactly what a query image
# upload is queued behind, so it is written at most this often.
VPS_STATUS_INTERVAL_S = 2
UPLOAD_SUFFIXES = ('.spz', '.ply', '.splat', '.ksplat', '.sog', '.glb', '.png', '.bin')
QUERY_IMAGE_MAX_BYTES = 2 * 1024 * 1024


async def stamp_vps_status(store, world_id, timestamp, site_id):
    """Record that the world localized just now, at most every VPS_STATUS_INTERVAL_S.
    True when it was written, which is also when the change is worth announcing."""
    elapsed = time.monotonic() - store.vps_stamped.get(world_id, -VPS_STATUS_INTERVAL_S)
    if elapsed < VPS_STATUS_INTERVAL_S:
        return False
    store.vps_stamped[world_id] = time.monotonic()
    async with store.lock('world:' + world_id):
        await store.write({'lastLocalizedAt': timestamp, 'nianticSiteId': site_id},
                          'worlds', world_id, 'vps-status.json')
    return True


async def body(request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 8*1024*1024:
            raise HTTPException(413, 'JSON body exceeds 8 MiB')
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, 'Invalid JSON')
    if not isinstance(data, dict):
        raise HTTPException(400, 'Expected object')
    return data


@router.get('/worlds')
async def worlds(request: Request):
    store = request.app.state.worlds
    values = []
    root = store.path('worlds')
    for path in sorted(root.glob('*/world.json')):
        try:
            values.append(store.world(path.parent.name))
        except Exception:
            logger.warning('Skipped invalid world manifest: %s', path.parent.name)
    return {'worlds': values}


@router.post('/worlds', status_code=201)
async def create_world(request: Request):
    data = await body(request)
    if not {'id', 'name'} <= data.keys() or data.keys()-{'id', 'name', 'space', 'description', 'nianticSiteId'}:
        raise HTTPException(400, 'Expected id, name and optional world metadata')
    if not isinstance(data['id'], str):
        raise HTTPException(400, 'Invalid world ID')
    segment(data['id'])
    world = check({'schema': 'wander.world/v1', **data, 'nianticSiteId': data.get('nianticSiteId'),
        'version': 'v1', 'status': 'draft', 'assets': {'splat': f"worlds/{data['id']}/v1/scene.spz"},
        'updatedAt': now()}, 'world.schema.json')
    store = request.app.state.worlds
    async with store.lock('world:' + world['id']):
        if store.path('worlds', world['id'], 'world.json').exists():
            raise HTTPException(409, 'World already exists')
        await store.write(world, 'worlds', world['id'], 'world.json')
    return world


@router.get('/worlds/{world_id}')
async def get_world(world_id: str, request: Request):
    return request.app.state.worlds.world(world_id)


@router.patch('/worlds/{world_id}')
async def patch_world(world_id: str, request: Request):
    data = await body(request)
    if data.keys()-{'name', 'space', 'description', 'nianticSiteId', 'version', 'alignment', 'status', 'stats', 'meshFrame'}:
        raise HTTPException(400, 'Unsupported manifest field')
    store = request.app.state.worlds
    async with store.lock('world:' + world_id):
        original = store.world(world_id)
        world = check({**original, **data, 'updatedAt': now()}, 'world.schema.json')
        if 'version' in data:
            directory = store.path('worlds', world_id, world['version'])
            if not directory.is_dir():
                raise HTTPException(400, 'Asset version directory does not exist')
            world['assets'] = {key: f"worlds/{world_id}/{world['version']}/{value.split('/')[-1]}"
                               for key, value in original['assets'].items()
                               if (directory / value.split('/')[-1]).is_file()}
            if 'splat' not in world['assets']:
                splats = [p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in ('.spz', '.ply', '.splat', '.ksplat', '.sog')]
                if len(splats) != 1:
                    raise HTTPException(400, 'Version needs one unambiguous splat asset')
                world['assets']['splat'] = f"worlds/{world_id}/{world['version']}/{splats[0].name}"
            for key, filename in [('mesh', 'mesh.glb'), ('vpsMap', 'vps-map.bin'), ('thumbnail', 'thumbnail.png')]:
                if (directory / filename).is_file():
                    world['assets'][key] = f"worlds/{world_id}/{world['version']}/{filename}"
        await store.write(world, 'worlds', world_id, 'world.json')
    return world


@router.delete('/worlds/{world_id}', status_code=204)
async def delete_world(world_id: str, request: Request):
    store = request.app.state.worlds
    async with store.lock('world:' + world_id):
        store.world(world_id)
        # path() verifies components, containment and absence of symlinks first.
        shutil.rmtree(store.path('worlds', world_id))
        await store.flush()
    return Response(status_code=204)


@router.put('/worlds/{world_id}/graph')
async def graph(world_id: str, request: Request):
    data = await body(request)
    validate_graph(data)
    store = request.app.state.worlds
    async with store.lock('world:' + world_id):
        world = store.world(world_id)
        revision = request.headers.get('if-match')
        if revision and revision != navmesh_revision(world):
            raise HTTPException(412, 'The graph or mesh changed. Generate again before accepting.')
        world.update(navigationGraph=data, updatedAt=now())
        await store.write(world, 'worlds', world_id, 'world.json')
    return world


def navmesh_revision(world):
    inputs = {key: world.get(key) for key in ('navigationGraph', 'assets', 'alignment', 'meshFrame')}
    return '"' + hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest() + '"'


def mesh_path(store, world):
    asset = world['assets'].get('mesh')
    if not asset:
        raise HTTPException(409, 'World has no mesh; upload mesh.glb under assets.mesh first')
    path = store.path(*asset.split('/'))
    if not path.is_file():
        raise HTTPException(409, 'Mesh asset is missing from the volume')
    return path


def occupancy_for(store, world, data):
    """Grid the world's mesh with the request's parameters (blocking; run in a thread)."""
    try:
        params = navmesh.Params.parse(data.get('params', {}))
        frame = data.get('frame', world.get('meshFrame', 'world'))
        if frame not in ('world', 'splat'):
            raise ValueError('frame must be world or splat')
        mesh = navmesh.load_mesh(mesh_path(store, world), world.get('alignment'), frame)
        return params, navmesh.Occupancy(mesh, params)
    except ValueError as error:
        raise HTTPException(422, str(error))


@router.post('/worlds/{world_id}/navmesh', status_code=201)
async def build_navmesh(world_id: str, request: Request):
    """Occupancy grid → walkable skeleton → *proposed* graph, written to navmesh.json for review.
    Nothing touches `navigationGraph`: a human accepts the proposal with PUT /graph."""
    data = await body(request)
    store = request.app.state.worlds
    world = store.world(world_id)
    params, occupancy = await asyncio.to_thread(occupancy_for, store, world, data)
    graph = await asyncio.to_thread(navmesh.build_graph, occupancy)
    if not graph['nodes']:
        raise HTTPException(422, 'No walkable floor found; check the mesh frame and cell size')
    original = world_graph(world)
    try:
        places = await asyncio.to_thread(navmesh.preserve_places, occupancy, graph, original)
    except ValueError as error:
        raise HTTPException(422, str(error))
    validate_graph(graph)
    issues, _ = navmesh.validate(occupancy, original, snap=False)
    proposal_issues, _ = navmesh.validate(occupancy, graph, snap=False)
    revision = navmesh_revision(world)
    proposal = {'schema': 'wander.navmesh/v1', 'worldId': world_id, 'mesh': world['assets']['mesh'],
                'status': 'proposed', 'params': {**params.__dict__, 'frame': data.get('frame', world.get('meshFrame', 'world'))},
                'grid': occupancy.summary(), 'graph': graph,
                'currentGraphIssues': issues, 'proposalIssues': proposal_issues,
                'places': places, 'sourceRevision': revision, 'createdAt': now()}
    async with store.lock('world:' + world_id):
        if navmesh_revision(store.world(world_id)) != revision:
            raise HTTPException(409, 'The graph or mesh changed during generation. Generate again.')
        await store.write(proposal, 'worlds', world_id, 'navmesh.json')
    return proposal


@router.get('/worlds/{world_id}/navmesh')
async def get_navmesh(world_id: str, request: Request):
    store = request.app.state.worlds
    store.world(world_id)
    return store.read('worlds', world_id, 'navmesh.json')


@router.post('/worlds/{world_id}/graph/validate')
async def validate_against_mesh(world_id: str, request: Request):
    """Edge-through-wall / off-floor checks and floor snapping for a world-frame graph (default: the
    current one). Read-only: returns the snapped copy for the editor to save with PUT /graph."""
    data = await body(request)
    store = request.app.state.worlds
    world = store.world(world_id)
    if 'graph' in data:
        validate_graph(data['graph'])
        graph = world_graph({**world, 'navigationGraph': data['graph']})
    else:
        graph = world_graph(world)
    _, occupancy = await asyncio.to_thread(occupancy_for, store, world, data)
    issues, snapped = navmesh.validate(occupancy, graph, snap=data.get('snap', True) is not False)
    return {'issues': issues, 'graph': snapped, 'floorY': occupancy.floor_y, 'checkedAt': now()}


@router.get('/worlds/{world_id}/measurements')
async def measurements(world_id: str, request: Request):
    store = request.app.state.worlds
    async with store.lock('world:' + world_id):
        store.world(world_id)
        return await store.read_editor_file(world_id, 'measurements')


@router.put('/worlds/{world_id}/measurements')
async def put_measurements(world_id: str, request: Request):
    data = check(await body(request), 'measurements.schema.json')
    if data['worldId'] != world_id:
        raise HTTPException(400, 'Measurement worldId mismatch')
    store = request.app.state.worlds
    async with store.lock('world:' + world_id):
        store.world(world_id)
        data['updatedAt'] = now()
        await store.write(data, 'worlds', world_id, 'measurements.json')
    return data


@router.get('/worlds/{world_id}/notes')
async def notes(world_id: str, request: Request):
    store = request.app.state.worlds
    async with store.lock('world:' + world_id):
        store.world(world_id)
        return await store.read_editor_file(world_id, 'notes')


@router.put('/worlds/{world_id}/notes')
async def put_notes(world_id: str, request: Request):
    data = check(await body(request), 'notes.schema.json')
    if data['worldId'] != world_id:
        raise HTTPException(400, 'Notes worldId mismatch')
    store = request.app.state.worlds
    async with store.lock('world:' + world_id):
        store.world(world_id)
        data['updatedAt'] = now()
        await store.write(data, 'worlds', world_id, 'notes.json')
        # Best-effort, matching PUT /annotations: a note pin (hand-placed or auto-detected)
        # is only useful to the assistant's search_context/search_building_knowledge tools
        # once it is searchable, so every save keeps the index current.
        try:
            await request.app.state.elastic.setup()
            await request.app.state.ingestion.context_notes(world_id, [note_search_document(n) for n in data['notes']])
        except Exception as error:
            logger.warning('Reindexing notes failed (%s); retry with POST /worlds/%s/index', type(error).__name__, world_id)
    return data


@router.post('/worlds/{world_id}/notes/auto-detect', status_code=201)
async def auto_detect_notes(world_id: str, request: Request):
    """Best-effort scene understanding: run Astra's vision annotator over stored, localized
    VPS query frames and turn every placed finding directly into a plain note pin -- same
    schema and rendering as clicking "Add note", but with no human review gate (unlike
    /annotations), since these never touch the navigation graph or become routing
    destinations; a bad pin is exactly as easy to delete as a hand-placed one. Skips
    anything within ~0.6 m of an existing note so re-running this doesn't pile up
    duplicates. Reindexes the new pins into Elasticsearch so the assistant can answer
    "what's in this room" style questions with more than the one or two hand-placed notes."""
    from ..services.annotations import candidates_to_notes, posed, propose_from_queries
    data = await body(request)
    if not set(data) <= {'limit', 'floor'}:
        raise HTTPException(400, 'Expected optional limit and floor')
    limit, floor = data.get('limit', 20), data.get('floor', 0)
    if not isinstance(limit, int) or not 1 <= limit <= LOCALIZATIONS_KEPT or not isinstance(floor, int):
        raise HTTPException(400, f'limit must be 1..{LOCALIZATIONS_KEPT} and floor an integer')
    store = request.app.state.worlds
    world = store.world(world_id)
    queries = localizations_index(store, world_id)['queries']
    images = store.path('worlds', world_id, 'localizations')
    queries = [q for q in queries if posed(q, images)][:limit]
    if not queries:
        raise HTTPException(409, 'No stored localized query frames with a pose and field of view to detect from')
    mesh = None
    if world['assets'].get('mesh'):
        try:
            mesh = await asyncio.to_thread(navmesh.load_mesh, mesh_path(store, world), world.get('alignment'),
                                           world.get('meshFrame', 'world'))
        except (HTTPException, ValueError) as error:
            logger.warning('Placing detected objects on the floor plane; mesh unavailable (%s)', error)
    try:
        batch, unplaced = await propose_from_queries(world, queries, images, store.path('worlds', world_id, 'annotation-cache'),
            request.app.state.settings, client=request.app.state.annotation_client, mesh=mesh, floor=floor)
    except ValueError as error:
        raise HTTPException(422, str(error))
    async with store.lock('world:' + world_id):
        store.world(world_id)
        current = await store.read_editor_file(world_id, 'notes')
        pairs, skipped = candidates_to_notes(batch.candidates, current['notes'])
        added = [note for note, _ in pairs]
        current = check({**current, 'notes': current['notes'] + added, 'updatedAt': now()}, 'notes.schema.json')
        await store.write(current, 'worlds', world_id, 'notes.json')
        try:
            await request.app.state.elastic.setup()
            await request.app.state.ingestion.context_notes(world_id, [
                note_search_document(note, {'category': candidate.category, 'permanence': candidate.permanence,
                    'navigation_role': candidate.navigation_role, 'visual_location': candidate.visual_location,
                    'uncertainty': candidate.uncertainty}) for note, candidate in pairs])
        except Exception as error:
            logger.warning('Indexing detected notes failed (%s); retry with POST /worlds/%s/index', type(error).__name__, world_id)
    return {**current, 'added': len(added), 'skippedDuplicates': skipped, 'unplaced': unplaced}


@router.post('/worlds/{world_id}/route')
async def route(world_id: str, request: Request):
    return request.app.state.world_navigation.route(request.app.state.worlds.world(world_id), await body(request))


@router.post('/worlds/{world_id}/annotations/propose', status_code=201)
async def propose_annotations(world_id: str, request: Request):
    """Astra as annotator: describe the stored, localized VPS query frames and place each finding
    from its camera pose onto the mesh (or floor). Writes annotation-proposals.json for review;
    the live graph only changes through PUT /annotations with a signed-off review file."""
    from ..services.annotations import posed, propose_from_queries
    data = await body(request)
    if not set(data) <= {'queryIds', 'limit', 'floor'}:
        raise HTTPException(400, 'Expected optional queryIds, limit and floor')
    limit, floor = data.get('limit', 20), data.get('floor', 0)
    if not isinstance(limit, int) or not 1 <= limit <= LOCALIZATIONS_KEPT or not isinstance(floor, int):
        raise HTTPException(400, f'limit must be 1..{LOCALIZATIONS_KEPT} and floor an integer')
    store = request.app.state.worlds
    world = store.world(world_id)
    queries = localizations_index(store, world_id)['queries']
    if 'queryIds' in data:
        wanted = data['queryIds']
        if not isinstance(wanted, list) or not all(isinstance(q, str) for q in wanted):
            raise HTTPException(400, 'queryIds must be a list of query IDs')
        missing = set(wanted) - {q['id'] for q in queries}
        if missing:
            raise HTTPException(404, 'Unknown query IDs: ' + ', '.join(sorted(missing)))
        queries = [q for q in queries if q['id'] in set(wanted)]
    images = store.path('worlds', world_id, 'localizations')
    queries = [q for q in queries if posed(q, images)][:limit]
    if not queries:
        raise HTTPException(409, 'No stored localized query frames with a pose and field of view to annotate')
    mesh = None
    if world['assets'].get('mesh'):
        try:
            mesh = await asyncio.to_thread(navmesh.load_mesh, mesh_path(store, world), world.get('alignment'),
                                           world.get('meshFrame', 'world'))
        except (HTTPException, ValueError) as error:
            logger.warning('Placing annotations on the floor plane; mesh unavailable (%s)', error)
    try:
        batch, unplaced = await propose_from_queries(world, queries, images, store.path('worlds', world_id, 'annotation-cache'), request.app.state.settings,
            client=request.app.state.annotation_client, mesh=mesh, floor=floor)
    except ValueError as error:
        raise HTTPException(422, str(error))
    proposal = {'schema': 'wander.annotation-proposals/v1', 'worldId': world_id, 'status': 'proposed',
                'model': batch.model, 'queryIds': [q['id'] for q in queries], 'placedWith': 'mesh' if mesh is not None else 'floor',
                'unplaced': unplaced, 'batch': batch.model_dump(), 'createdAt': now()}
    async with store.lock('world:' + world_id):
        store.world(world_id)
        await store.write(proposal, 'worlds', world_id, 'annotation-proposals.json')
    return proposal


@router.get('/worlds/{world_id}/annotations/proposals')
async def annotation_proposals(world_id: str, request: Request):
    store = request.app.state.worlds
    store.world(world_id)
    return store.read('worlds', world_id, 'annotation-proposals.json')


@router.put('/worlds/{world_id}/annotations')
async def annotations(world_id: str, request: Request):
    """Backend extension; canonical manifest stays compliant with main's schema."""
    from ..services.annotations import AnnotationBatch, ReviewFile, publish_world
    data = await body(request)
    if set(data) != {'batch', 'review'}:
        raise HTTPException(400, 'Expected batch and review')
    batch = AnnotationBatch.model_validate(data['batch'])
    review = ReviewFile.model_validate(data['review'])
    store = request.app.state.worlds
    async with store.lock('world:' + world_id):
        manifest, records, notes = publish_world(batch, review, store.world(world_id))
        ids = {c.id for c in batch.candidates}
        path = store.path('worlds', world_id, 'annotations.json')
        previous = store.read('worlds', world_id, 'annotations.json') if path.exists() else []
        records = [r for r in previous if r['id'] not in ids] + records
        notes_path = store.path('worlds', world_id, 'context-notes.json')
        previous_notes = store.read('worlds', world_id, 'context-notes.json') if notes_path.exists() else []
        notes = [n for n in previous_notes if n['id'] not in ids] + notes
        await store.write(records, 'worlds', world_id, 'annotations.json')
        await store.write(notes, 'worlds', world_id, 'context-notes.json')
        await store.write(manifest, 'worlds', world_id, 'world.json')
        # Reindex inline so publishing and search availability never drift apart
        # (a human previously had to remember a separate POST /index call). Best
        # effort: a temporarily unavailable Elasticsearch must not block publishing,
        # matching how live event indexing already degrades (events.py record()).
        try:
            await request.app.state.elastic.setup()
            await request.app.state.ingestion.world(manifest, records)
            await request.app.state.ingestion.context_notes(world_id, notes)
        except Exception as error:
            logger.warning('Reindex after publish failed (%s); retry with POST /worlds/%s/index',
                          type(error).__name__, world_id)
    return manifest


@router.post('/worlds/{world_id}/index')
async def index_world(world_id: str, request: Request):
    """Manual repair/backfill only; PUT /annotations and PUT /notes already reindex on save."""
    store = request.app.state.worlds
    async with store.lock('world:' + world_id):
        manifest = store.world(world_id)
        records = store.read('worlds', world_id, 'annotations.json') if store.path('worlds', world_id, 'annotations.json').exists() else []
        context_notes = store.read('worlds', world_id, 'context-notes.json') if store.path('worlds', world_id, 'context-notes.json').exists() else []
        notes = check(store.read('worlds', world_id, 'notes.json'), 'notes.schema.json')['notes'] \
            if store.path('worlds', world_id, 'notes.json').exists() else []
        await request.app.state.elastic.setup()
        await request.app.state.ingestion.world(manifest, records)
        await request.app.state.ingestion.context_notes(world_id, context_notes + [note_search_document(n) for n in notes])
    return {'indexed': len(world_graph(manifest)['nodes']), 'context_notes': len(context_notes) + len(notes)}


@router.post('/sessions', status_code=201)
async def create_session(request: Request):
    data = await body(request)
    if not {'worldId', 'deviceId'} <= data.keys() or data.keys()-{'worldId', 'deviceId', 'destination', 'accessibleOnly'}:
        raise HTTPException(400, 'Expected worldId, deviceId, optional destination and accessibleOnly')
    accessible_only = data.pop('accessibleOnly', False)
    if not isinstance(accessible_only, bool):
        raise HTTPException(400, 'accessibleOnly must be a boolean')
    if not all(isinstance(v, str) and v for v in data.values()):
        raise HTTPException(400, 'Session fields must be nonempty strings')
    return await request.app.state.world_navigation.create(data['worldId'], data['deviceId'], data.get('destination'),
                                                           accessible_only)


@router.get('/sessions/{session_id}')
async def session(session_id: str, request: Request):
    return request.app.state.worlds.session(session_id)


@router.delete('/sessions/{session_id}', status_code=204)
async def end_session(session_id: str, request: Request):
    store = request.app.state.worlds
    async with store.lock('session:' + session_id):
        data = store.session(session_id)
        data.update(state='ended', updatedAt=now())
        await store.save_session(data)
        await store.emit(data, 'ended')
    return Response(status_code=204)


@router.put('/sessions/{session_id}/destination')
async def destination(session_id: str, request: Request):
    data = await body(request)
    if not {'destination'} <= set(data) <= {'destination', 'accessibleOnly'} or not isinstance(data['destination'], str) \
            or not isinstance(data.get('accessibleOnly', False), bool):
        raise HTTPException(400, 'Expected destination node ID and optional accessibleOnly boolean')
    return await request.app.state.world_navigation.destination(session_id, data['destination'], data.get('accessibleOnly'))


@router.delete('/sessions/{session_id}/destination')
async def clear_destination(session_id: str, request: Request):
    """Stop guidance ("stop", "cancel") while keeping the session and its pose stream alive."""
    return await request.app.state.world_navigation.clear_destination(session_id)


@router.post('/sessions/{session_id}/pose')
async def pose(session_id: str, request: Request):
    # Poses are accepted before a destination exists so the voice agent can start guidance
    # server-side and the phone's stream immediately drives progress.
    return await request.app.state.world_navigation.pose(session_id, await body(request), allow_no_destination=True)


@router.post('/worlds/{world_id}/localize')
async def localize(world_id: str, request: Request):
    data = check(await body(request), 'navigation.schema.json', '#/$defs/localizationUpdate')
    store, navigation = request.app.state.worlds, request.app.state.world_navigation
    world = store.world(world_id)
    if not world['nianticSiteId'] or data['nianticSiteId'] != world['nianticSiteId']:
        raise HTTPException(409, 'Niantic site mismatch')
    # alignment is splat->world, NOT VPS->world. Do not double-transform a VPS pose.
    if world.get('alignment', {}).get('frame') != 'niantic-vps':
        raise HTTPException(409, 'VPS localization requires alignment.frame=niantic-vps; no VPS-to-world transform is defined')
    nearest, (distance, position, _, _) = snap(world_graph(world), data['pose']['position'])
    if 'sessionId' in data:
        session = store.session(data['sessionId'])
        if session['worldId'] != world_id or session['deviceId'] != data['deviceId']:
            raise HTTPException(409, 'Session world/device mismatch')
    else:
        session = await navigation.create(world_id, data['deviceId'])
    await navigation.pose(session['sessionId'], {k: data[k] for k in ('pose', 'timestamp', 'trackingState') if k in data},
                          allow_no_destination=True)
    if data.get('trackingState', 'localized') == 'localized':
        # Throttled together: re-reading the session and telling every socket "localized" five
        # times a second told nobody anything the pose stream had not already said.
        if await stamp_vps_status(store, world_id, data['timestamp'], data['nianticSiteId']):
            await store.emit(store.session(session['sessionId']), 'localized')
    return {'sessionId': session['sessionId'], 'worldId': world_id, 'pose': data['pose'],
            'nearestNode': {**node_ref(nearest), 'distanceMetres': horizontal(data['pose']['position'], nearest['position'])},
            'snappedPosition': position, 'offGraphMetres': distance}


@router.post('/worlds/{world_id}/localize/self-hosted')
async def localize_self_hosted(world_id: str, request: Request):
    """Additive alternative to Niantic VPS: runs our own hloc/COLMAP-based
    localization on Modal (services/backend/deployment/modal_localization.py)
    instead of Niantic's cloud. Existing /localize and /localize/query endpoints
    are untouched; this never runs unless the world opts in via
    alignment.frame == 'self-hosted-vps'."""
    import modal

    data = await body(request)
    required = {'deviceId', 'capturedAt', 'imageBase64', 'width', 'height'}
    if not required <= set(data):
        raise HTTPException(400, f'Expected {sorted(required)} and optional sessionId/role')
    store, navigation = request.app.state.worlds, request.app.state.world_navigation
    world = store.world(world_id)
    if world.get('alignment', {}).get('frame') != 'self-hosted-vps':
        raise HTTPException(409, "Self-hosted localization requires alignment.frame='self-hosted-vps'")
    try:
        image = base64.b64decode(data['imageBase64'], validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, 'imageBase64 is not valid base64')
    if len(image) > QUERY_IMAGE_MAX_BYTES:
        raise HTTPException(413, 'Query image exceeds 2 MiB')
    if image[:3] != b'\xff\xd8\xff':
        raise HTTPException(400, 'Query image must be a JPEG')
    if 'sessionId' in data:
        session = store.session(data['sessionId'])
        if session['worldId'] != world_id or session['deviceId'] != data['deviceId']:
            raise HTTPException(409, 'Session world/device mismatch')
    else:
        session = await navigation.create(world_id, data['deviceId'])

    localizer = modal.Cls.from_name('htn-visual-localization', 'Localizer')()
    result = await localizer.localize.remote.aio(world_id, world['version'], image, data['width'], data['height'])

    query_id = 'q-' + uuid4().hex
    record = {'id': query_id, 'worldId': world_id, 'sessionId': session['sessionId'],
              'deviceId': data['deviceId'], 'role': data.get('role', 'chest'),
              'capturedAt': data['capturedAt'], 'receivedAt': now(),
              'trackingState': result['trackingState'], 'confidence': result.get('confidence'),
              'numInliers': result.get('numInliers'),
              'pose': {'position': result['position'], 'rotation': result['rotation']}
                      if result['trackingState'] != 'lost' else None}
    if result['trackingState'] != 'lost':
        try:
            nearest, (distance, position, _, _) = snap(world_graph(world), result['position'])
            record['nearestNode'] = {**node_ref(nearest), 'distanceMetres': math.dist(result['position'], nearest['position'])}
            record['offGraphMetres'] = distance
        except HTTPException as error:
            if error.status_code != 409:  # a world without waypoints is fine here
                raise
        await navigation.pose(session['sessionId'], {'pose': {'position': result['position'], 'rotation': result['rotation']},
                              'timestamp': data['capturedAt'], 'trackingState': result['trackingState']},
                              allow_no_destination=True)
        if result['trackingState'] == 'localized':
            await store.emit(store.session(session['sessionId']), 'localized')

    # A separate file, not the Niantic-shaped worlds/{id}/localizations/index.json:
    # that schema is additionalProperties:false and requires nianticSiteId/request,
    # so a differently-shaped self-hosted record would break its own GET endpoint.
    path = ('worlds', world_id, 'localizations-self-hosted.json')
    async with store.lock('localizations-self-hosted:' + world_id):
        previous = store.read(*path) if store.path(*path).exists() else []
        await store.write(([record] + previous)[:LOCALIZATIONS_KEPT], *path)

    return {'sessionId': session['sessionId'], 'worldId': world_id, **result,
            'nearestNode': record.get('nearestNode'), 'offGraphMetres': record.get('offGraphMetres')}


@router.get('/worlds/{world_id}/localizations/self-hosted')
async def localizations_self_hosted(world_id: str, request: Request, limit: int = 20):
    store = request.app.state.worlds
    store.world(world_id)
    path = ('worlds', world_id, 'localizations-self-hosted.json')
    records = store.read(*path) if store.path(*path).exists() else []
    return {'worldId': world_id, 'queries': records[:max(1, min(limit, LOCALIZATIONS_KEPT))]}


@router.get('/worlds/{world_id}/localization-map/points.ply')
async def localization_map_ply(world_id: str, request: Request, revision: str | None = None):
    """Sparse point cloud from build_map, for the /map-viewer test page."""
    import modal
    world = request.app.state.worlds.world(world_id)
    get_ply = modal.Function.from_name('htn-visual-localization', 'get_map_ply')
    data = await get_ply.remote.aio(world_id, revision or world['version'])
    return Response(content=data, media_type='application/octet-stream')


@router.get('/worlds/{world_id}/localization-map/cameras')
async def localization_map_cameras(world_id: str, request: Request, revision: str | None = None):
    """Registered camera poses from build_map, rendered as frustums in /map-viewer."""
    import modal
    world = request.app.state.worlds.world(world_id)
    get_cameras = modal.Function.from_name('htn-visual-localization', 'get_map_cameras')
    return await get_cameras.remote.aio(world_id, revision or world['version'])


def localizations_index(store, world_id, validate=True):
    """The stored query index. `validate=False` on the upload path: re-validating the whole
    index there costs ~13 ms once it holds its 50 records (0.3 ms when the world is new), inside
    the lock and on the event loop, which is throughput the phone's next upload is waiting for.
    Every record was validated on the way in, and the readers below still validate."""
    if store.path('worlds', world_id, 'localizations', 'index.json').exists():
        index = store.read('worlds', world_id, 'localizations', 'index.json')
        return check(index, 'navigation.schema.json', '#/$defs/localizationQueries') if validate else index
    return {'schema': 'wander.localizations/v1', 'worldId': world_id, 'queries': []}


@router.post('/worlds/{world_id}/localize/query', status_code=201)
async def localize_query(world_id: str, request: Request):
    """One VPS image query mirrored from the phone: the frame the SDK sent, its request record, the pose it produced."""
    data = check(await body(request), 'navigation.schema.json', '#/$defs/localizationQueryUpload')
    store = request.app.state.worlds
    world = store.world(world_id)
    if not world['nianticSiteId'] or data['nianticSiteId'] != world['nianticSiteId']:
        raise HTTPException(409, 'Niantic site mismatch')
    try:
        image = base64.b64decode(data['imageBase64'], validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, 'imageBase64 is not valid base64')
    if len(image) > QUERY_IMAGE_MAX_BYTES:
        raise HTTPException(413, 'Query image exceeds 2 MiB')
    if image[:3] != b'\xff\xd8\xff':
        raise HTTPException(400, 'Query image must be a JPEG')
    if 'sessionId' in data:
        session = store.session(data['sessionId'])
        if session['worldId'] != world_id or session['deviceId'] != data['deviceId']:
            raise HTTPException(409, 'Session world/device mismatch')

    query_id = 'q-' + uuid4().hex
    record = {'schema': 'wander.localization-query/v1', 'id': query_id, 'worldId': world_id,
              **{k: data[k] for k in ('sessionId', 'deviceId', 'role', 'nianticSiteId', 'capturedAt', 'request', 'result') if k in data},
              'receivedAt': now(),
              'image': {**data['image'], 'path': f'worlds/{world_id}/localizations/{query_id}.jpg'}}
    pose = data['result'].get('pose')
    if pose is not None and world.get('alignment', {}).get('frame') == 'niantic-vps':
        try:
            nearest, (distance, _, _, _) = snap(world_graph(world), pose['position'])
            record['nearestNode'] = {**node_ref(nearest), 'distanceMetres': horizontal(pose['position'], nearest['position'])}
            record['offGraphMetres'] = distance
        except HTTPException as error:
            if error.status_code != 409:  # a world without waypoints is fine here
                raise
    check(record, 'navigation.schema.json', '#/$defs/localizationQuery')

    async with store.lock('localizations:' + world_id):
        await store.write_bytes(image, 'worlds', world_id, 'localizations', query_id + '.jpg')
        index = localizations_index(store, world_id, validate=False)
        kept, evicted = index['queries'][:LOCALIZATIONS_KEPT - 1], index['queries'][LOCALIZATIONS_KEPT - 1:]
        for old in evicted:
            store.path('worlds', world_id, 'localizations', old['id'] + '.jpg').unlink(missing_ok=True)
        index.update(queries=[record] + kept, updatedAt=record['receivedAt'])
        await store.write(index, 'worlds', world_id, 'localizations', 'index.json')
    if data['result']['trackingState'] == 'localized':
        await stamp_vps_status(store, world_id, data['capturedAt'], data['nianticSiteId'])
    return record


@router.get('/worlds/{world_id}/localizations')
async def localizations(world_id: str, request: Request, limit: int = 20):
    """Recent image queries, newest first. Images are served as `/worlds/{id}/localizations/{queryId}.jpg`."""
    store = request.app.state.worlds
    store.world(world_id)
    index = localizations_index(store, world_id)
    index['queries'] = index['queries'][:max(1, min(limit, LOCALIZATIONS_KEPT))]
    return index


@router.get('/worlds/{world_id}/occupancy')
async def occupancy(world_id: str, request: Request, rebuild: bool = False):
    """Static obstacle grid voxelised from the world's splat, cached per asset version.
    Phones ray-cast against it from their localised pose to find walls and furniture."""
    from ..services.occupancy import BUILDER, build_occupancy
    store = request.app.state.worlds
    world = store.world(world_id)
    cached = store.path('worlds', world_id, world['version'], 'occupancy.json')
    if cached.exists() and not rebuild:
        grid = store.read('worlds', world_id, world['version'], 'occupancy.json')
        if grid.get('builder') == BUILDER:
            return grid
    splat = store.path(*world['assets']['splat'].split('/'))
    if not splat.exists():
        raise HTTPException(404, 'World has no splat asset')
    try:
        grid = await asyncio.to_thread(build_occupancy, splat.read_bytes(), world)
    except ValueError as error:
        raise HTTPException(422, f'Cannot build occupancy: {error}')
    async with store.lock('world:' + world_id):
        await store.write(grid, 'worlds', world_id, world['version'], 'occupancy.json')
    return grid


@router.get('/worlds/{world_id}/hazards')
async def hazards(world_id: str, request: Request):
    """Annotated obstacles and potential hazards with positions, for the phone's map sensor.
    Elasticsearch first; the published files on the volume when it is unavailable."""
    from ..services.hazards import hazards_from_elastic, hazards_from_files
    store = request.app.state.worlds
    store.world(world_id)
    rows, source = [], 'files'
    if request.app.state.elastic.client is not None:
        try:
            rows, source = await hazards_from_elastic(request.app.state.elastic, world_id), 'elastic'
        except Exception as error:
            logger.warning('Hazard lookup in Elasticsearch failed (%s); using files', type(error).__name__)
    if not rows:
        rows, source = hazards_from_files(store, world_id), 'files'
    return {'worldId': world_id, 'source': source, 'hazards': rows}


@router.get('/worlds/{world_id}/vps')
async def vps(world_id: str, request: Request):
    store = request.app.state.worlds
    world = store.world(world_id)
    if not world['nianticSiteId']:
        raise HTTPException(409, 'World has no Niantic site')
    # False means not verified activated. A map export or old fix is not activation proof.
    result = {'nianticSiteId': world['nianticSiteId'], 'localizable': False, 'checkedAt': now(),
              'meshAvailable': False}
    asset = world['assets'].get('vpsMap')
    if asset:
        result['meshAvailable'] = store.path(*asset.split('/')).is_file()
    if store.path('worlds', world_id, 'vps-status.json').exists():
        status = store.read('worlds', world_id, 'vps-status.json')
        if status['nianticSiteId'] == world['nianticSiteId']:
            result['lastLocalizedAt'] = status['lastLocalizedAt']
    return result


@router.get('/worlds/{world_id}/{version}/{filename}')
async def asset(world_id: str, version: str, filename: str, request: Request):
    store = request.app.state.worlds
    store.world(world_id)
    path = store.path('worlds', world_id, version, filename)
    if not path.is_file():
        raise HTTPException(404, 'Asset not found')
    return FileResponse(path, media_type=mimetypes.guess_type(filename)[0] or 'application/octet-stream',
                        headers={'Cache-Control': 'public, max-age=31536000, immutable'})


@router.post('/worlds/{world_id}/{version}/{filename}/ticket', status_code=201)
async def upload_ticket(world_id: str, version: str, filename: str, request: Request):
    """Mint a ticket for one asset upload (API key required; the browser never sees the key).

    The caller is the web server, which then hands the ticket to the browser so the file
    itself goes straight here instead of through a proxy with a small body limit."""
    store = request.app.state.worlds
    # Only a browser ever redeems a ticket, and a browser cannot reach us without CORS.
    # Minting one anyway would hand back a target whose preflight this service rejects,
    # which surfaces as an unexplained network error in the upload dialog.
    if not request.app.state.settings.wander_web_origins.strip():
        raise HTTPException(503, 'Direct browser uploads are off: set WANDER_WEB_ORIGINS to the web app origin')
    store.world(world_id)
    path = store.path('worlds', world_id, version, filename)
    if path.suffix.lower() not in UPLOAD_SUFFIXES:
        raise HTTPException(400, 'Unsupported asset format')
    if path.exists():
        raise HTTPException(409, 'Versioned asset already exists')
    token, expires = request.app.state.upload_tickets.mint(f'worlds/{world_id}/{version}/{filename}')
    return {'token': token, 'expiresAt': expires, 'header': TICKET_HEADER.decode(),
            'path': f'worlds/{world_id}/{version}/{filename}'}


@router.put('/worlds/{world_id}/{version}/{filename}', status_code=201)
async def upload(world_id: str, version: str, filename: str, request: Request):
    store = request.app.state.worlds
    path = store.path('worlds', world_id, version, filename)
    if path.suffix.lower() not in UPLOAD_SUFFIXES:
        raise HTTPException(400, 'Unsupported asset format')
    async with store.lock('world:' + world_id):
        store.world(world_id)
        if path.exists():
            raise HTTPException(409, 'Versioned asset already exists')
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name('upload-' + uuid4().hex)
        digest, size = hashlib.sha256(), 0
        try:
            with temporary.open('xb') as file:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > request.app.state.settings.asset_max_bytes:
                        raise HTTPException(413, 'Asset exceeds configured limit')
                    digest.update(chunk)
                    file.write(chunk)
            temporary.replace(path)
            world = store.world(world_id)
            key = {'mesh.glb': 'mesh', 'vps-map.bin': 'vpsMap', 'thumbnail.png': 'thumbnail'}.get(filename)
            if key and version == world['version'] and world['assets'].get(key) != f'worlds/{world_id}/{version}/{filename}':
                world['assets'][key] = f'worlds/{world_id}/{version}/{filename}'
                world['updatedAt'] = now()
                await store.write(world, 'worlds', world_id, 'world.json')
            await store.flush()
        finally:
            temporary.unlink(missing_ok=True)
    ticket = request.headers.get(TICKET_HEADER.decode())
    if ticket:
        request.app.state.upload_tickets.spend(ticket)
    return {'path': f'worlds/{world_id}/{version}/{filename}', 'bytes': size, 'sha256': digest.hexdigest()}


@router.websocket('/ws/sessions/{session_id}')
async def events(socket: WebSocket, session_id: str):
    store = socket.app.state.worlds
    try:
        session = store.session(session_id)
    except HTTPException:
        await socket.close(code=1008)
        return
    await socket.accept()
    clients = store.sockets.setdefault(session_id, set())
    clients.add(socket)
    try:
        kind = session['state'] if session['state'] in ('arrived', 'lost', 'ended') else 'progress'
        event = {'type': kind, 'sessionId': session_id, 'timestamp': now()}
        for source, target in [('lastPose', 'pose'), ('lastProgress', 'progress'), ('route', 'route')]:
            if source in session:
                event[target] = session[source]
        await socket.send_json(event)
        while True:
            raw = await socket.receive_text()
            try:
                valid = len(raw) <= 128 and json.loads(raw) == {'type': 'ping'}
            except ValueError:
                valid = False
            if not valid:
                await socket.close(code=1008, reason='Only ping messages are supported')
                return
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(socket)
