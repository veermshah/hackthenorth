"""Keep the OpenAI tool loop grounded in the current persisted world manifest."""
from fastapi import HTTPException
from ..models import Pose, Localization
from ..integrations.elastic.client import IntegrationUnavailable
from ..integrations.openai.tools import REGISTRY
from ..routing.heading import bearing, horizontal, legacy_heading, relative, yaw
from .destinations import resolve
from .sessions import Session
from .worlds import note_targets, reviewed_landmarks, world_graph

NEARBY_NOTES_M = 10


class WorldAgentTools:
    def __init__(self, fallback, worlds, navigation, memory):
        self.fallback, self.worlds, self.navigation, self.memory = fallback, worlds, navigation, memory
        self.events = fallback.events

    def exists(self, session_id):
        return self.worlds.path('sessions', session_id + '.json').is_file()

    def refresh(self, session_id):
        if not self.exists(session_id):
            return
        data = self.worlds.session(session_id)
        if data['state'] == 'ended':
            raise ValueError('Session ended')
        session = self.memory.sessions.setdefault(session_id, Session(session_id, data['worldId']))
        session.destination_id = data.get('destination')
        session.route = [n['id'] for n in data.get('route', {}).get('nodes', [])]
        meta = self.navigation.metadata(session_id)
        session.route_index = meta.get('leg', 0)
        progress = data.get('lastProgress', {})
        session.instruction = progress.get('instruction', {}).get('text')
        session.distance_remaining_m = progress.get('remainingMetres')
        if 'lastPose' in data:
            point = data['lastPose']['position']
            facing = yaw(data['lastPose']['rotation'])
            session.pose = Pose(x=point[0], y=point[1], z=point[2],
                heading=legacy_heading(facing) if facing is not None else 0,
                localized=data['state'] not in ('lost', 'ended'), timestamp=meta.get('timestamp', 0),
                localization=Localization(provider='niantic', coordinate_frame='world',
                    provider_metadata={'heading_convention': 'legacy contract 0=+Z, converted from world heading 0=-Z',
                                       'world_heading_deg': facing}))

    def catalogue(self, session_id):
        """Destination names and nearby notes for the agent's application context; None for legacy sessions."""
        if not self.exists(session_id):
            return None
        data = self.worlds.session(session_id)
        world = self.worlds.world(data['worldId'])
        places = list(self.navigation.targets(world).values())
        localized = data.get('lastPose') is not None and data['state'] not in ('lost', 'ended')
        position = data['lastPose']['position'] if localized else None
        if position is not None:
            places.sort(key=lambda p: horizontal(position, p['position']))
        destinations = [{'id': p['id'], 'name': p.get('name') or p['id'], 'kind': p['source']} for p in places if p.get('name')][:80]
        return {'destinations': destinations, 'nearby_notes': self.nearby_notes(world, data['lastPose']) if localized else []}

    def nearby_notes(self, world, pose):
        """Pinned notes within a few metres, described relative to the traveller's heading."""
        facing = yaw(pose['rotation'])
        rows = []
        for note in note_targets(self.worlds, world):
            metres = horizontal(pose['position'], note['position'])
            if metres > NEARBY_NOTES_M:
                continue
            row = {'id': note['id'], 'name': note['name'], 'distance_m': round(metres, 1)}
            if note.get('text'):
                row['text'] = note['text']
            if facing is not None and metres > 0.3:
                row['relative_bearing_deg'] = round(relative(bearing(pose['position'], note['position']), facing))
            rows.append(row)
        rows.sort(key=lambda row: row['distance_m'])
        return rows

    def with_route_distance(self, data, world, candidates):
        """Attach the deterministic route length to each candidate when the traveller is localized."""
        for row in candidates:
            row['route_distance_m'] = None
            if data.get('lastPose') is None or data['state'] in ('lost', 'ended'):
                continue
            try:
                route = self.navigation.route(world, self.navigation.route_request(data, data['lastPose'], row['id']))
                row['route_distance_m'] = round(route['totalMetres'], 1)
            except HTTPException:
                row['unreachable'] = True
        return candidates

    async def execute(self, session, name, arguments):
        if not self.exists(session.session_id):
            return await self.fallback.execute(session, name, arguments)
        if name not in REGISTRY:
            raise ValueError('Unknown tool')
        args = REGISTRY[name][0].model_validate_json(arguments, strict=True)
        data = self.worlds.session(session.session_id)
        world = self.worlds.world(data['worldId'])
        nodes = {n['id']: n for n in world_graph(world)['nodes']}
        places = self.navigation.targets(world)
        sources, actions = [], []
        localized = session.snapshot()['localization']['localized']
        position = data['lastPose']['position'] if localized else None
        if name == 'get_current_location':
            nearest = min(nodes.values(), key=lambda n: horizontal(n['position'], position)) if localized and nodes else None
            result = {'pose': data.get('lastPose') if localized else None, 'localized': localized,
                      'frame': 'world', 'nearestNode': nearest, 'nearby_landmarks': [], 'nearby_notes': []}
            if localized:
                # Human-reviewed annotations only, described relative to the traveller's heading so the
                # assistant never has to convert image-relative or map-relative directions itself.
                pose = data['lastPose']
                facing = yaw(pose['rotation'])
                for mark in reviewed_landmarks(self.worlds, world):
                    metres = horizontal(pose['position'], mark['position'])
                    if metres > 10:
                        continue
                    entry = {'id': mark['id'], 'name': mark['name'], 'distance_m': round(metres, 1)}
                    if facing is not None and metres > 0.3:
                        entry['relative_bearing_deg'] = round(relative(bearing(pose['position'], mark['position']), facing))
                    result['nearby_landmarks'].append(entry)
                    sources.append({'type': 'map_entity', 'id': mark['id']})
                result['nearby_landmarks'].sort(key=lambda entry: entry['distance_m'])
                result['nearby_notes'] = self.nearby_notes(world, pose)
                sources.extend({'type': 'map_entity', 'id': row['id']} for row in result['nearby_notes'])
        elif name == 'get_navigation_state':
            result = {'state': data['state'], 'destination': data.get('destination'),
                      'destination_name': places.get(data.get('destination'), {}).get('name'),
                      'route': data.get('route'), 'progress': data.get('lastProgress'),
                      'localized': localized}
        elif name == 'resolve_destination':
            candidates = resolve(places.values(), args.query, position)
            for row in candidates:
                text = places[row['id']].get('text')
                if text:
                    row['text'] = text
            result = {'evidence_class': 'local_catalogue', 'candidates': self.with_route_distance(data, world, candidates)}
            sources.extend({'type': 'map_entity', 'id': row['id']} for row in candidates)
        elif name == 'search_places':
            near = {'x': position[0], 'y': position[1], 'z': position[2]} if localized else None
            try:
                hits = await self.fallback.search.search('map_entities', data['worldId'], args.query, near=near)
            except IntegrationUnavailable:
                # No search service: the same by-name matching resolve_destination uses.
                hits = None
            if hits is None:
                result = self.with_route_distance(data, world, resolve(places.values(), args.query, position))
                for row in result:
                    row['evidence_class'] = 'local_catalogue'
            else:
                result = []
                for hit in hits:
                    if hit['id'] not in nodes:
                        continue
                    record = {**nodes[hit['id']], 'route_distance_m': None}
                    # Metadata is evidence, never an alternative source for graph coordinates.
                    record['description'] = hit.get('description', '')
                    record['tags'] = hit.get('tags', [])
                    result.append(record)
                self.with_route_distance(data, world, result)
            sources.extend({'type': 'map_entity', 'id': row['id']} for row in result)
        elif name == 'set_destination':
            if not localized:
                raise ValueError('A fresh localized pose is required before navigation')
            if args.destination_id not in places:
                raise ValueError('Unknown destination id; use an id returned by resolve_destination or search_places')
            try:
                result = await self.navigation.destination(session.session_id, args.destination_id, args.accessible_only)
            except HTTPException as error:
                raise ValueError(str(error.detail)) from None
            self.refresh(session.session_id)
            actions.append({'type': 'set_destination', 'destination_id': args.destination_id,
                            'destination_name': places[args.destination_id].get('name'),
                            'accessible_only': args.accessible_only})
            sources.append({'type': 'map_entity', 'id': args.destination_id})
        elif name == 'stop_navigation':
            previous = data.get('destination')
            try:
                result = await self.navigation.clear_destination(session.session_id)
            except HTTPException as error:
                raise ValueError(str(error.detail)) from None
            self.refresh(session.session_id)
            result = {'stopped': previous is not None, 'previous_destination': previous, 'state': result['state']}
            actions.append({'type': 'stop_navigation', 'destination_id': previous})
        else:
            return await self.fallback.execute(session, name, arguments)
        return {'data': result, 'sources': sources, 'actions': actions}
