from typing import Literal
from pydantic import Field
from ...models import Model


class SearchArgs(Model):
    query: str = Field(min_length=1, max_length=2000)


class EmptyArgs(Model):
    pass


class DestinationArgs(Model):
    destination_id: str = Field(min_length=1)
    accessible_only: bool


class EventArgs(Model):
    event_type: Literal['obstacle', 'destination_set', 'route_generated', 'arrived',
        'localization_acquired', 'localization_lost', 'assistant_query', 'assistant_action'] | None
    minutes: int = Field(ge=1, le=1440)


class ContextArgs(Model):
    query: str = Field(min_length=1, max_length=2000)
    # No default: OpenAI strict function-calling requires every property in
    # `required`, which Pydantic only does for fields without a default value
    # (matches the existing EventArgs.event_type pattern below).
    floor: int | None


class HazardDensityArgs(Model):
    hours: int = Field(ge=1, le=168)


REGISTRY = {
    'search_building_knowledge': (SearchArgs, 'Search site building documents with hybrid retrieval; static evidence.'),
    'search_places': (SearchArgs, 'Search real mapped places, with backend distances where localized.'),
    'resolve_destination': (SearchArgs, 'Match a spoken or typed place name ("bed one", "the elevator", "room 101") '
        'against the mapped places and pinned notes of the current world by name, without a search service. Returns '
        'ranked candidates with ids, kinds (node or note), straight-line and route distances; empty when nothing matches. '
        'Use the returned id with set_destination.'),
    'get_current_location': (EmptyArgs, 'Read current localization, pose, nearest waypoint, nearby entities and nearby notes.'),
    'get_navigation_state': (EmptyArgs, 'Read the current deterministic route, next waypoint and instruction.'),
    'set_destination': (DestinationArgs, 'Start deterministic navigation to an existing destination only when requested. '
        'Accepts graph node ids and note ids ("note:<id>") exactly as returned by resolve_destination or search_places.'),
    'stop_navigation': (EmptyArgs, 'Stop the current guidance when the user asks to stop or cancel; the session and '
        'localization continue.'),
    'get_recent_events': (EventArgs, 'Read session event history; null type includes all event types.'),
    'search_context': (ContextArgs, 'Search non-navigable context and hazard evidence recorded near an area: '
        'wet floors, obstructions, informational notes, and pinned scene objects/landmarks (furniture, beds, '
        'luggage, electronics, signage, and similar) noted in a room. Use for "what is in this room" / "what '
        'can you see" / general surroundings questions, not just hazards. Not a live sensor feed and never a '
        'destination. Returns matching evidence plus counts by category and role.'),
    'get_obstacle_hotspots': (HazardDensityArgs, 'Aggregate recent obstacle reports by location to find '
        'recurring trouble spots; historical pattern, never proof current conditions are unsafe.'),
}
TOOLS = [{'type': 'function', 'name': name, 'description': description,
          'parameters': model.model_json_schema(), 'strict': True}
         for name, (model, description) in REGISTRY.items()]
