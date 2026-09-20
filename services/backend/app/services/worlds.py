"""Persistent implementation of the world/navigation contracts from main."""
import asyncio
import hashlib
import heapq
import json
import logging
import math
import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from ..config import ROOT
from ..routing.heading import bearing as heading, horizontal, phrase, relative, rotate, turn, yaw

__all__ = ['heading', 'horizontal', 'rotate', 'yaw']
logger = logging.getLogger(__name__)
BASE = 'https://wander.app/contracts/'
SCHEMAS = {name: json.loads((ROOT / 'shared/contracts' / name).read_text(encoding='utf-8'))
           for name in ('world.schema.json', 'navigation.schema.json', 'measurements.schema.json',
                        'notes.schema.json')}
REGISTRY = Registry().with_resources([(BASE + name, Resource.from_contents(schema))
                                      for name, schema in SCHEMAS.items()])


def now():
    return datetime.now(timezone.utc).isoformat()


def check(value, schema, pointer=''):
    validator = Draft202012Validator({'$ref': BASE + schema + pointer}, registry=REGISTRY,
                                     format_checker=FormatChecker())
    errors = list(validator.iter_errors(value))
    if errors:
        logging.getLogger(__name__).warning('Validation failed for %s%s: %s (at %s)', schema, pointer,
                                            errors[0].message, '/'.join(str(p) for p in errors[0].absolute_path))
        raise HTTPException(400, errors[0].message)
    def finite(item):
        if isinstance(item, float) and not math.isfinite(item):
            raise HTTPException(400, 'Nonfinite numbers are not allowed')
        if isinstance(item, dict):
            for key, child in item.items():
                finite(child)
                if key == 'rotation' and isinstance(child, list):
                    if abs(sum(x*x for x in child) - 1) > 0.001:
                        logging.getLogger(__name__).warning('Rejected rotation %s (norm² %.4f)', child, sum(x*x for x in child))
                        raise HTTPException(400, 'Rotation must be a unit quaternion [x,y,z,w]')
        elif isinstance(item, list):
            for child in item:
                finite(child)
    finite(value)
    return value


def segment(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', value) or '..' in value:
        raise HTTPException(400, 'Invalid path identifier')
    return value


def note_search_document(note: dict, metadata: dict | None = None) -> dict:
    """Shape a WorldNote (hand-placed or auto-detected) for Ingestion.context_notes, so
    every pin in the viewer -- not just Astra-reviewed annotations -- is searchable by
    search_building_knowledge/search_context. A hand-placed pin has no Finding evidence,
    so category/permanence/etc. default to a generic, non-navigable note."""
    metadata = metadata or {}
    x, y, z = note['position']
    return {'id': note['id'], 'name': note['title'], 'description': note.get('description', ''),
            'category': metadata.get('category', 'other'),
            'permanence': metadata.get('permanence', 'unknown'),
            'navigation_role': metadata.get('navigation_role', 'landmark'),
            'visual_location': metadata.get('visual_location', note.get('location', '')),
            'uncertainty': metadata.get('uncertainty', ''), 'x': x, 'y': y, 'z': z}


def world_graph(world):
    graph = deepcopy(world.get('navigationGraph', {'nodes': [], 'edges': []}))
    if graph.get('frame', 'world') == 'splat':
        alignment = world.get('alignment')
        if not alignment:
            raise HTTPException(409, 'Splat graph requires alignment')
        for node in graph['nodes']:
            rotated = rotate([v * alignment['scale'] for v in node['position']], alignment['rotation'])
            node['position'] = [a+b for a, b in zip(rotated, alignment['position'])]
        graph['frame'] = 'world'
        # Explicit distances are already specified in metres by the contract.
    return graph


def edge_kind(edge):
    return edge.get('kind', 'walk')


def edge_accessible(edge):
    return edge.get('accessible', edge_kind(edge) not in ('stairs', 'escalator'))


def validate_graph(graph):
    check(graph, 'world.schema.json', '#/properties/navigationGraph')
    ids = [node['id'] for node in graph['nodes']]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, 'Duplicate node IDs')
    if any(e['from'] not in ids or e['to'] not in ids or e['from'] == e['to'] for e in graph['edges']):
        raise HTTPException(400, 'Invalid graph edge')
    floors = {n['id']: n.get('floor') for n in graph['nodes']}
    for e in graph['edges']:
        a, b = floors[e['from']], floors[e['to']]
        if a is not None and b is not None and a != b and edge_kind(e) == 'walk':
            raise HTTPException(400, f"Edge {e['from']}-{e['to']} joins floors {a} and {b}; mark it stairs, escalator, elevator or ramp")


def projection(point, a, b):
    """Horizontal distance from `point` to segment ab, the 3D point on the segment, and its fraction."""
    delta = [y-x for x, y in zip(a, b)]
    denominator = delta[0]*delta[0] + delta[2]*delta[2]
    t = max(0, min(1, ((point[0]-a[0])*delta[0] + (point[2]-a[2])*delta[2])/denominator)) if denominator else 0
    projected = [x+t*d for x, d in zip(a, delta)]
    return horizontal(point, projected), projected, t


def snap(graph, position, avoid=(), accessible_only=False):
    """Nearest node and nearest walkable edge; a start is never snapped into a stairwell or shaft."""
    nodes = {n['id']: n for n in graph['nodes'] if n['id'] not in avoid}
    if not nodes:
        raise HTTPException(409, 'World has no usable navigation nodes')
    nearest = min(nodes.values(), key=lambda n: horizontal(position, n['position']))
    options = []
    for edge in graph['edges']:
        if edge_kind(edge) != 'walk' or (accessible_only and not edge_accessible(edge)):
            continue
        if edge['from'] in nodes and edge['to'] in nodes:
            d, p, t = projection(position, nodes[edge['from']]['position'], nodes[edge['to']]['position'])
            options.append((d, p, t, edge))
    # Isolated nodes remain valid starts when closer than any edge.
    fallback = (horizontal(position, nearest['position']), nearest['position'], 0, None)
    choice = min(options, key=lambda item: item[0]) if options else fallback
    if fallback[0] < choice[0]:
        choice = fallback
    return nearest, choice


def node_ref(node):
    return {k: v for k, v in node.items() if k in ('id', 'name', 'kind', 'position')}


# Web-viewer notes are routable destinations; the prefix keeps their IDs apart from graph nodes.
NOTE_PREFIX = 'note:'


def world_notes(store, world_id):
    if not store.path('worlds', world_id, 'notes.json').exists():
        return []
    return store.read('worlds', world_id, 'notes.json').get('notes', [])


def note_targets(store, world):
    """Notes as destination-like refs (world frame, per notes.schema.json), with their text for matching."""
    return [{'id': NOTE_PREFIX + note['id'], 'name': note['title'], 'kind': 'destination', 'position': note['position'],
             'source': 'note', 'text': ' '.join(part for part in (note.get('location'), note.get('description')) if part)}
            for note in world_notes(store, world['id']) if note.get('title')]


def targets(store, world):
    """Everything a destination may refer to: graph nodes first, then notes, keyed by ID."""
    items = [{**node_ref(node), 'source': 'node'} for node in world_graph(world)['nodes']] + note_targets(store, world)
    return {item['id']: item for item in items}


def target_name(store, world, target_id):
    place = targets(store, world).get(target_id)
    return (place or {}).get('name') or target_id


def vertical_phrase(kind, from_floor, to_floor):
    name = 'the ' + kind
    if to_floor is not None and to_floor != from_floor:
        return f'Take {name} to floor {to_floor}.'
    return f'Take {name} ahead.'


# Reviewed landmarks this close to a turn node are named in the cue; this close to a leg are "passed".
LANDMARK_AT_METRES = 3.0
LANDMARK_BESIDE_METRES = 2.5


def side_of(position, a, b):
    """'left' or 'right' of the directed segment ab, viewed from above."""
    angle = math.radians(heading(a, b))
    right = (position[0]-a[0])*math.cos(angle) + (position[2]-a[2])*math.sin(angle)
    return 'right' if right > 0 else 'left'


def leg_landmarks(landmarks, a, b, exclude, first):
    """Landmark refs for the leg a→b: one 'at' the turn node (not on the first leg, where the
    traveller is only near it), then anything the leg passes close by, in walking order."""
    refs, passed = [], []
    for mark in landmarks:
        if mark['id'] in exclude:
            continue
        if not first and horizontal(mark['position'], a['position']) <= LANDMARK_AT_METRES:
            if not any(r['relation'] == 'at' for r in refs):
                refs.append({'id': mark['id'], 'name': mark['name'], 'relation': 'at'})
            continue
        distance, _, fraction = projection(mark['position'], a['position'], b['position'])
        if distance <= LANDMARK_BESIDE_METRES and 0.15 <= fraction <= 0.85:
            passed.append((fraction, {'id': mark['id'], 'name': mark['name'],
                                      'relation': side_of(mark['position'], a['position'], b['position'])}))
    refs.extend(ref for _, ref in sorted(passed, key=lambda item: item[0])[:2])
    return refs


def spoken(kind, metres, refs=()):
    """`phrase` with reviewed landmarks woven in: 'Left at Reception desk, then continue 12 metres,
    passing Bottle filler on your right.'"""
    text = phrase(kind, metres)
    at = next((r for r in refs if r['relation'] == 'at'), None)
    if at is not None:
        text = text.replace(', then continue', f" at {at['name']}, then continue", 1) if ', then continue' in text \
            else text.replace('Continue straight', f"Continue straight past {at['name']}", 1)
    passing = [f"{r['name']} on your {r['relation']}" for r in refs if r['relation'] != 'at']
    if passing:
        text = text[:-1] + ', passing ' + ' and '.join(passing) + '.'
    return text


def arrival(node, landmarks):
    text = f"You have arrived at {node['name']}." if node.get('name') else 'You have arrived.'
    refs = []
    for mark in landmarks:
        if mark['id'] != node['id'] and horizontal(mark['position'], node['position']) <= LANDMARK_AT_METRES:
            refs.append({'id': mark['id'], 'name': mark['name'], 'relation': 'at'})
            text += f" {mark['name']} is right here."
            break
    return text, refs


def reviewed_landmarks(store, world):
    """Published, human-reviewed annotations with a world position: approved destinations sit on the
    graph as nodes; noted context carries its own point. Hazards and temporary observations are
    never spoken as landmarks (they are recorded evidence, not live state)."""
    world_id = world['id']
    nodes = {n['id']: n for n in world_graph(world)['nodes']}
    marks = []
    if store.path('worlds', world_id, 'annotations.json').exists():
        for record in store.read('worlds', world_id, 'annotations.json'):
            evidence = record.get('annotation') or {}
            node = nodes.get(record['id'])
            if node is None or evidence.get('permanence') == 'temporary' \
                    or evidence.get('navigation_role') in ('potential_hazard', 'context'):
                continue
            marks.append({'id': record['id'], 'name': record['name'], 'position': node['position']})
    if store.path('worlds', world_id, 'context-notes.json').exists():
        for note in store.read('worlds', world_id, 'context-notes.json'):
            if note.get('navigation_role') != 'landmark' or note.get('permanence') == 'temporary':
                continue
            marks.append({'id': note['id'], 'name': note['name'], 'position': [note['x'], note['y'], note['z']]})
    return marks


def edge_weight(nodes, edge):
    return edge.get('distance', math.dist(nodes[edge['from']]['position'], nodes[edge['to']]['position']))


def compute_route(world, request, landmarks=(), notes=()):
    """Deterministic route to a graph node or, via `notes`, to a web-viewer note: the note is reached
    at the point on the nearest walkable edge beside it, as a virtual destination node named after it."""
    check(request, 'navigation.schema.json', '#/$defs/routeRequest')
    graph = world_graph(world)
    nodes = {n['id']: node_ref(n) for n in graph['nodes']}
    destination, start = request['to'], request.get('from')
    note = next((n for n in notes if n['id'] == destination), None) if destination not in nodes else None
    if destination not in nodes and note is None:
        raise HTTPException(404, 'Destination node not found')
    if start is None:
        raise HTTPException(400, 'Specify from; a world route has no implicit session')
    avoid = set(request.get('avoid', []))
    if destination in avoid:
        raise HTTPException(422, 'Destination is avoided')
    accessible_only = request.get('accessibleOnly', False)
    adjacency = {key: [] for key in nodes}
    for edge in graph['edges']:
        a, b = edge['from'], edge['to']
        if a in avoid or b in avoid or (accessible_only and not edge_accessible(edge)):
            continue
        weight = edge_weight(nodes, edge)
        adjacency[a].append((b, weight, edge_kind(edge)))
        if edge.get('bidirectional', True):
            adjacency[b].append((a, weight, edge_kind(edge)))
    end_edge = None
    if note is not None:
        nearest, (_, point, t, edge) = snap(graph, note['position'], avoid, accessible_only)
        nodes[destination] = {'id': destination, 'name': note['name'], 'kind': 'destination', 'position': point}
        adjacency[destination] = []
        if edge is None:
            adjacency[nearest['id']].append((destination, 0, 'walk'))
        else:
            # Walk along the edge to the note's foot point; a one-way edge is only entered from its start.
            end_edge, weight = (edge, t), edge_weight(nodes, edge)
            adjacency[edge['from']].append((destination, weight*t, edge_kind(edge)))
            if edge.get('bidirectional', True):
                adjacency[edge['to']].append((destination, weight*(1-t), edge_kind(edge)))
    if isinstance(start, list):
        nearest, (_, point, t, edge) = snap(graph, start, avoid, accessible_only)
        if edge is None:
            start = nearest['id']
        elif t <= 1e-9:
            start = edge['from']
        elif t >= 1-1e-9:
            start = edge['to']
        else:
            start = 'start-' + uuid4().hex
            nodes[start] = {'id': start, 'position': point, 'kind': 'waypoint'}
            weight = edge_weight(nodes, edge)
            adjacency[start] = [(edge['to'], weight*(1-t), edge_kind(edge))]
            if edge.get('bidirectional', True):
                adjacency[start].append((edge['from'], weight*t, edge_kind(edge)))
            if end_edge is not None and end_edge[0] is edge:
                # Start and note share an edge: go straight to the foot point instead of via an endpoint.
                t_end = end_edge[1]
                if t_end >= t or edge.get('bidirectional', True):
                    adjacency[start].append((destination, weight*abs(t_end-t), edge_kind(edge)))
    if start not in nodes:
        raise HTTPException(404, 'Start node not found')
    if start in avoid:
        raise HTTPException(422, 'Start is avoided')
    costs, previous, queue = {start: 0}, {}, [(0, start)]
    while queue:
        cost, current = heapq.heappop(queue)
        if cost != costs[current]:
            continue
        if current == destination:
            break
        for target, weight, kind in adjacency[current]:
            if cost+weight < costs.get(target, float('inf')):
                costs[target] = cost+weight
                previous[target] = (current, weight, kind)
                heapq.heappush(queue, (cost+weight, target))
    if destination not in costs:
        raise HTTPException(422, 'Destination unreachable' + (' without stairs' if accessible_only else ''))
    path = [destination]
    while path[-1] != start:
        path.append(previous[path[-1]][0])
    path.reverse()
    legs = []
    for a, b in zip(path, path[1:]):
        leg = {'from': a, 'to': b, 'distanceMetres': previous[b][1],
               'headingDeg': heading(nodes[a]['position'], nodes[b]['position'])}
        if previous[b][2] != 'walk':
            leg['kind'] = previous[b][2]
        legs.append(leg)
    floors = {n['id']: n.get('floor') for n in graph['nodes']}
    for i, leg in enumerate(legs):
        # Vertical legs keep the previous heading so the turn after them is measured from the way in.
        if leg.get('kind') or horizontal(nodes[leg['from']]['position'], nodes[leg['to']]['position']) < 1e-9:
            leg['headingDeg'] = legs[i-1]['headingDeg'] if i else (request.get('headingDeg') or 0)
    instructions = []
    facing = request.get('headingDeg')
    on_path = set(path)
    for i, leg in enumerate(legs):
        # The first turn is relative to the traveller's heading when known, not to a phantom previous leg.
        reference = legs[i-1]['headingDeg'] if i else facing
        refs = []
        if leg.get('kind'):
            kind, text = leg['kind'], vertical_phrase(leg['kind'], floors.get(leg['from']), floors.get(leg['to']))
        else:
            angle = relative(leg['headingDeg'], reference) if reference is not None else 0
            refs = leg_landmarks(landmarks, nodes[leg['from']], nodes[leg['to']], on_path, i == 0)
            kind, text = turn(angle), spoken(turn(angle), leg['distanceMetres'], refs)
        instruction = {'atNode': leg['from'], 'turn': kind, 'text': text,
                       'distanceMetres': legs[i-1]['distanceMetres'] if i else 0}
        if refs:
            instruction['landmarks'] = refs
        instructions.append(instruction)
    text, refs = arrival(nodes[destination], landmarks)
    instructions.append({'atNode': destination, 'turn': 'arrive', 'text': text,
                         'distanceMetres': legs[-1]['distanceMetres'] if legs else 0, **({'landmarks': refs} if refs else {})})
    return {'nodes': [nodes[key] for key in path], 'legs': legs,
            'totalMetres': costs[destination], 'instructions': instructions}


class WorldStore:
    def __init__(self, root: Path, commit=None, commit_delay=1.0):
        self.root = root.resolve()
        self.commit = commit
        # Volume commits take seconds; coalesce a burst of writes into one
        # background commit instead of blocking every request on its own.
        self.commit_delay = commit_delay
        self._dirty = False
        self._committer = None
        self.locks = {}
        self.sockets = {}

    def lock(self, key):
        return self.locks.setdefault(key, asyncio.Lock())

    def path(self, *parts):
        path = self.root
        for part in parts:
            path = path / segment(part)
            if path.is_symlink():
                raise HTTPException(400, 'Symlink paths are not allowed')
        if not path.resolve().is_relative_to(self.root):
            raise HTTPException(400, 'Invalid storage path')
        return path

    def read(self, *parts):
        path = self.path(*parts)
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            raise HTTPException(404, 'Not found')

    async def write(self, value, *parts):
        path = self.path(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name('tmp-' + uuid4().hex)
        try:
            temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding='utf-8')
            temporary.replace(path)
            await self.flush()
        finally:
            temporary.unlink(missing_ok=True)

    async def write_bytes(self, data, *parts):
        path = self.path(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name('tmp-' + uuid4().hex)
        try:
            temporary.write_bytes(data)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    async def flush(self):
        if not self.commit:
            return
        self._dirty = True
        if self._committer is None or self._committer.done():
            self._committer = asyncio.create_task(self._commit_soon())

    async def _commit_soon(self):
        await asyncio.sleep(self.commit_delay)
        while self._dirty:
            self._dirty = False
            try:
                await asyncio.to_thread(self.commit)
            except Exception as error:  # noqa: BLE001 - keep serving; the next write retries
                self._dirty = True
                print(f'[worlds] volume commit failed: {error!r}')
                await asyncio.sleep(self.commit_delay)

    def world(self, world_id):
        world = check(self.read('worlds', world_id, 'world.json'), 'world.schema.json')
        if world['id'] != world_id:
            raise HTTPException(400, 'Manifest ID differs from its directory')
        validate_graph(world.get('navigationGraph', {'nodes': [], 'edges': []}))
        return world

    def session(self, session_id):
        return check(self.read('sessions', session_id + '.json'), 'navigation.schema.json', '#/$defs/session')

    async def save_session(self, session):
        check(session, 'navigation.schema.json', '#/$defs/session')
        await self.write(session, 'sessions', session['sessionId'] + '.json')

    async def emit(self, session, kind):
        event = {'type': kind, 'sessionId': session['sessionId'], 'timestamp': now()}
        for source, target in [('lastPose', 'pose'), ('lastProgress', 'progress'), ('route', 'route')]:
            if source in session:
                event[target] = session[source]
        async def send(socket):
            try:
                await asyncio.wait_for(socket.send_json(event), 2)
            except Exception:
                self.sockets.get(session['sessionId'], set()).discard(socket)
        await asyncio.gather(*(send(socket) for socket in tuple(self.sockets.get(session['sessionId'], ()))))
        return event


class WorldNavigation:
    def __init__(self, store):
        self.store = store

    def route(self, world, request):
        return compute_route(world, request, reviewed_landmarks(self.store, world), note_targets(self.store, world))

    def targets(self, world):
        return targets(self.store, world)

    def metadata(self, session_id):
        try:
            return self.store.read('sessions', session_id + '-state.json')
        except HTTPException as error:
            if error.status_code != 404:
                raise
            return {}

    async def create(self, world_id, device_id, destination=None, accessible_only=False):
        world = self.store.world(world_id)
        if destination is not None and destination not in self.targets(world):
            raise HTTPException(404, 'Destination node not found')
        session = {'sessionId': str(uuid4()), 'worldId': world_id, 'deviceId': device_id,
                   'state': 'localizing', 'createdAt': now(), 'updatedAt': now()}
        if destination is not None:
            session['destination'] = destination
        if accessible_only:
            session['accessibleOnly'] = True
        await self.store.save_session(session)
        return session

    def ensure_active(self, session):
        if session['state'] == 'ended':
            raise HTTPException(409, 'Session ended')

    async def clear_destination(self, session_id):
        """Stop guidance but keep the session and its pose stream; the next pose reports `localizing`."""
        async with self.store.lock('session:' + session_id):
            session = self.store.session(session_id)
            self.ensure_active(session)
            stopped = 'destination' in session
            for key in ('destination', 'route'):
                session.pop(key, None)
            if session['state'] != 'lost':
                session['state'] = 'localizing'
            session['lastProgress'] = {'state': session['state'], 'remainingMetres': 0}
            if stopped:
                session['lastProgress']['speak'] = 'Guidance stopped.'
            session['updatedAt'] = now()
            meta = self.metadata(session_id)
            meta.update(leg=0, off_since=None, last_cue=None)
            await self.store.write(meta, 'sessions', session_id + '-state.json')
            await self.store.save_session(session)
            await self.store.emit(session, 'progress')
            return session

    async def destination(self, session_id, destination, accessible_only=None):
        async with self.store.lock('session:' + session_id):
            session = self.store.session(session_id)
            self.ensure_active(session)
            world = self.store.world(session['worldId'])
            if destination not in self.targets(world):
                raise HTTPException(404, 'Destination node not found')
            if accessible_only is not None:
                if accessible_only:
                    session['accessibleOnly'] = True
                else:
                    session.pop('accessibleOnly', None)
            if 'lastPose' in session and session['state'] != 'lost':
                session['route'] = self.route(world, self.route_request(session, session['lastPose'], destination))
                session['state'] = 'navigating'
            else:
                session.pop('route', None)
            session['destination'] = destination
            session.pop('lastProgress', None)
            session['updatedAt'] = now()
            meta = self.metadata(session_id)
            meta.update(leg=0, off_since=None, graph_hash=self.graph_hash(world))
            await self.store.write(meta, 'sessions', session_id + '-state.json')
            await self.store.save_session(session)
            await self.store.emit(session, 'rerouted')
            return session

    @staticmethod
    def graph_hash(world):
        return hashlib.sha256(json.dumps(world_graph(world), sort_keys=True).encode()).hexdigest()

    @staticmethod
    def route_request(session, pose, destination):
        request = {'from': pose['position'], 'to': destination}
        facing = yaw(pose['rotation'])
        if facing is not None:
            request['headingDeg'] = facing
        if session.get('accessibleOnly'):
            request['accessibleOnly'] = True
        return request

    @staticmethod
    def reached(position, target, leg):
        """Within 1.5 m horizontally; a vertical leg also needs the traveller on the target storey."""
        if horizontal(position, target) >= 1.5:
            return False
        return not leg.get('kind') or abs(position[1]-target[1]) < 2.5

    def approach(self, world, destination, position, facing):
        """Where a note is relative to the traveller once its foot point is reached, e.g. 'Bed 1 is 2 metres on your left.'"""
        place = self.targets(world).get(destination)
        if place is None:
            return None
        metres = horizontal(position, place['position'])
        if metres < 0.5:
            return f"{place['name']} is right here."
        distance = f'{metres:.0f} metre{"s" if round(metres) != 1 else ""}' if metres >= 1 else 'less than a metre'
        if facing is None:
            return f"{place['name']} is {distance} away."
        angle = relative(heading(position, place['position']), facing)
        side = 'ahead' if abs(angle) <= 25 else 'behind you' if abs(angle) >= 155 else \
            'on your right' if angle > 0 else 'on your left'
        return f"{place['name']} is {distance} {side}."

    @staticmethod
    def live_instruction(route, index, position, facing, arrived):
        """What to do right now: the turn from the traveller's heading towards the next node."""
        if arrived or not route['legs']:
            return route['instructions'][-1], 0
        nodes = route['nodes']
        if route['legs'][index].get('kind'):
            return route['instructions'][index], 0
        target = nodes[index+1]['position']
        ahead = horizontal(position, target)
        angle = relative(heading(position, target), facing) if facing is not None and ahead > 0.3 else 0
        kind = turn(angle)
        # Only what is still ahead: the turn-node landmark was for the turn already made.
        refs = [r for r in route['instructions'][index].get('landmarks', []) if r['relation'] != 'at']
        cue = {'atNode': nodes[index]['id'], 'turn': kind, 'text': spoken(kind, ahead, refs), 'distanceMetres': ahead}
        if refs:
            cue['landmarks'] = refs
        return cue, angle

    async def pose(self, session_id, body, allow_no_destination=False):
        check(body, 'navigation.schema.json', '#/$defs/poseUpdate')
        async with self.store.lock('session:' + session_id):
            session = self.store.session(session_id)
            self.ensure_active(session)
            if 'destination' not in session and not allow_no_destination:
                raise HTTPException(409, 'Session has no destination yet')
            timestamp = datetime.fromisoformat(body['timestamp'].replace('Z', '+00:00')).timestamp()
            age = datetime.now(timezone.utc).timestamp()-timestamp
            if age > 15 or age < -5:
                raise HTTPException(400, 'Pose timestamp is stale or in the future')
            meta = self.metadata(session_id)
            if timestamp <= meta.get('timestamp', 0):
                raise HTTPException(400, 'Out-of-order pose')
            meta['timestamp'] = timestamp
            session['lastPose'], session['updatedAt'] = body['pose'], now()
            world = self.store.world(session['worldId'])
            rerouted = False
            if body.get('trackingState', 'localized') != 'localized':
                was_lost = session['state'] == 'lost'
                session['state'] = 'lost'
                progress = {'state': 'lost', 'remainingMetres': 0}
                if not was_lost:
                    progress['speak'] = 'Tracking lost. Navigation paused.'
                meta['off_since'] = None
            elif 'destination' not in session:
                session['state'] = 'localizing'
                progress = {'state': 'localizing', 'remainingMetres': 0}
            else:
                changed = meta.get('graph_hash') != self.graph_hash(world)
                if changed or 'route' not in session or session['state'] == 'lost':
                    session['route'] = self.route(world, self.route_request(session, body['pose'], session['destination']))
                    meta.update(leg=0, off_since=None, graph_hash=self.graph_hash(world))
                    rerouted = True
                route = session['route']
                position = body['pose']['position']
                facing = yaw(body['pose']['rotation'])
                legs, nodes = route['legs'], route['nodes']
                index = min(meta.get('leg', 0), max(0, len(legs)-1))
                # Advance only along adjacent legs; do not jump across a looping path.
                while index < len(legs)-1 and self.reached(position, nodes[index+1]['position'], legs[index]):
                    index += 1
                meta['leg'] = index
                if legs:
                    off, _, fraction = projection(position, nodes[index]['position'], nodes[index+1]['position'])
                    off_all = min(projection(position, a['position'], b['position'])[0]
                                  for a, b in zip(nodes, nodes[1:]))
                    remaining = (1-fraction)*legs[index]['distanceMetres'] + sum(l['distanceMetres'] for l in legs[index+1:])
                else:
                    off = off_all = horizontal(position, nodes[-1]['position'])
                    remaining = off
                arrived = self.reached(position, nodes[-1]['position'], legs[-1] if legs else {}) and index == max(0, len(legs)-1)
                state = 'arrived' if arrived else 'off-route' if off_all > 3 else 'navigating'
                if state == 'off-route':
                    meta['off_since'] = meta.get('off_since') or timestamp
                    if timestamp-meta['off_since'] >= 5:
                        session['route'] = self.route(world, self.route_request(session, body['pose'], session['destination']))
                        meta.update(leg=0, off_since=timestamp)
                        rerouted = True
                        route = session['route']
                        nodes, legs = route['nodes'], route['legs']
                        index, remaining = 0, route['totalMetres']
                else:
                    meta['off_since'] = None
                cue, angle = self.live_instruction(route, index, position, facing, arrived)
                progress = {'state': state, 'remainingMetres': max(0, remaining),
                    'offRouteMetres': off_all, 'instruction': cue,
                    'nextNode': nodes[min(index+1, len(nodes)-1)],
                    'distanceToNextMetres': horizontal(position, nodes[min(index+1, len(nodes)-1)]['position'])}
                if facing is not None:
                    progress['headingDeg'] = facing
                cue_id = [state, cue['atNode'], cue['turn']]
                previous = meta.get('last_cue')
                # Speak on a new leg or state; while turning, re-speak only once the correction has
                # settled into a different bucket for a moment so bucket edges do not chatter.
                changed = previous is None or cue_id[:2] != previous[:2]
                turning = previous is not None and cue_id[2] != previous[2] and \
                    abs(angle-meta.get('last_angle', 0)) >= 15 and timestamp-meta.get('last_spoken', 0) >= 3
                if changed or turning:
                    progress['speak'] = ('You are off route. Recalculating.' if state == 'off-route' else cue['text'])
                    if arrived and session['destination'].startswith(NOTE_PREFIX):
                        # The route ends on the corridor beside the note; say where the note itself is.
                        approach = self.approach(world, session['destination'], position, facing)
                        if approach:
                            progress['speak'] += ' ' + approach
                    meta.update(last_cue=cue_id, last_angle=angle, last_spoken=timestamp)
                session['state'] = state
            session['lastProgress'] = progress
            await self.store.write(meta, 'sessions', session_id + '-state.json')
            await self.store.save_session(session)
            if rerouted:
                await self.store.emit(session, 'rerouted')
            await self.store.emit(session, 'progress')
            if session['state'] in ('lost', 'arrived'):
                await self.store.emit(session, session['state'])
            return progress
