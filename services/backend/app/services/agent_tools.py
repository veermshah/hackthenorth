import json
from ..integrations.openai.tools import REGISTRY
from ..routing.graph import distance
from ..routing.astar import astar
from .destinations import resolve
from .sessions import broadcast


class AgentTools:
    def __init__(self, navigation, search, events):
        self.navigation, self.search, self.events = navigation, search, events

    def mapped(self, session, destination):
        graph = self.navigation.graph
        point = graph.point(destination.waypoint_id)
        result = {**destination.model_dump(), 'x': point.x, 'y': point.y, 'z': point.z,
                  'route_distance_m': None, 'straight_line_distance_m': None}
        if session.snapshot()['localization']['localized']:
            result['straight_line_distance_m'] = round(distance(session.pose, point), 2)
            start = graph.nearest(session.pose)
            if distance(start, session.pose) <= 3:
                try:
                    path = astar(graph, start.id, point.id)
                    result['route_distance_m'] = round(distance(session.pose, start) + sum(
                        distance(graph.point(a), graph.point(b)) for a, b in zip(path, path[1:])), 2)
                except ValueError:
                    result['unreachable_accessibly'] = True
        return result

    async def execute(self, session, name, arguments):
        if name not in REGISTRY:
            raise ValueError('Unknown tool')
        args = REGISTRY[name][0].model_validate_json(arguments, strict=True)
        sources, actions = [], []
        if name == 'search_building_knowledge':
            data = await self.search.search('building_knowledge', session.site_id, args.query)
            sources = [{'type': 'building_knowledge', 'id': row['id']} for row in data]
            data = {'evidence_class': 'retrieved_building_knowledge', 'results': data}
        elif name == 'search_places':
            near = None
            if session.snapshot()['localization']['localized']:
                near = {'x': session.pose.x, 'y': session.pose.y, 'z': session.pose.z}
            hits = await self.search.search('map_entities', session.site_id, args.query, near=near)
            ids = {row['id'] for row in hits}
            # Map file is authoritative; stale or fabricated index IDs cannot become destinations.
            data = [self.mapped(session, d) for d in self.navigation.graph.destinations if d.id in ids]
            data.sort(key=lambda row: row['route_distance_m'] if row['route_distance_m'] is not None else float('inf'))
            sources = [{'type': 'map_entity', 'id': row['id']} for row in data]
        elif name == 'resolve_destination':
            # Legacy demo graph: match destination names/aliases; positions come from their waypoints.
            graph = self.navigation.graph
            places = [{'id': d.id, 'name': d.name, 'aliases': d.aliases, 'text': d.description, 'source': 'node',
                       'position': [graph.point(d.waypoint_id).x, graph.point(d.waypoint_id).y, graph.point(d.waypoint_id).z]}
                      for d in graph.destinations]
            localized = session.snapshot()['localization']['localized']
            position = [session.pose.x, session.pose.y, session.pose.z] if localized else None
            candidates = resolve(places, args.query, position)
            for row in candidates:
                row['route_distance_m'] = self.mapped(session, graph.destination(row['id']))['route_distance_m']
            data = {'evidence_class': 'local_catalogue', 'candidates': candidates}
            sources = [{'type': 'map_entity', 'id': row['id']} for row in candidates]
        elif name == 'get_current_location':
            state = session.snapshot()
            localized = state['localization']['localized']
            nearby = sorted((self.mapped(session, d) for d in self.navigation.graph.destinations),
                key=lambda row: row['straight_line_distance_m'])[:5] if localized else []
            data = {'pose': state['pose'], 'localization': state['localization'], 'nearby_entities': nearby,
                    'nearest_waypoint': self.navigation.graph.nearest(session.pose).id if localized else None}
            sources = [{'type': 'map_entity', 'id': row['id']} for row in nearby]
        elif name == 'get_navigation_state':
            data = session.snapshot()['navigation']
            if session.destination_id:
                sources = [{'type': 'map_entity', 'id': session.destination_id}]
        elif name == 'set_destination':
            data = self.navigation.set_destination(session, args.destination_id, args.accessible_only)
            actions = [{'type': 'set_destination', 'destination_id': args.destination_id,
                        'accessible_only': args.accessible_only}]
            sources = [{'type': 'map_entity', 'id': args.destination_id}]
            await broadcast(session, {'type': 'route_update', **data})
            await broadcast(session, {'type': 'navigation_instruction', **data})
            self.events.record(session, 'destination_set', actions[0])
            self.events.record(session, 'route_generated', data)
            self.events.record(session, 'assistant_action', actions[0])
            if data['instruction'] == 'arrived':
                self.events.record(session, 'arrived', {'destination_id': args.destination_id})
        elif name == 'stop_navigation':
            previous = session.destination_id
            session.destination_id, session.route, session.route_index = None, [], 0
            session.instruction, session.distance_remaining_m = None, None
            data = {'stopped': previous is not None, 'previous_destination': previous}
            actions = [{'type': 'stop_navigation', 'destination_id': previous}]
            await broadcast(session, {'type': 'route_update', **session.snapshot()['navigation']})
            self.events.record(session, 'assistant_action', actions[0])
        elif name == 'get_recent_events':
            data = await self.events.recent(session.site_id, session.session_id, args.event_type, args.minutes)
            sources = [{'type': 'live_event', 'id': row['id']} for row in data]
        elif name == 'search_context':
            data = await self.search.context(session.site_id, args.query, args.floor)
            sources = [{'type': 'map_entity', 'id': row['id']} for row in data['results']]
        else:
            data = await self.events.hazard_density(session.site_id, args.hours)
            sources = [{'type': 'live_event', 'id': f"hotspot:{row['nearest_waypoint_id']}"} for row in data]
        return {'data': data, 'sources': sources, 'actions': actions}
