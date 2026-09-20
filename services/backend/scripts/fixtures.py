"""Explicit offline test doubles. Never selected by the application at runtime."""
import json
from types import SimpleNamespace
from pydantic import BaseModel
from ..app.integrations.openai.agent import AgentModel


class Output(BaseModel):
    type: str
    name: str | None = None
    call_id: str | None = None
    arguments: str | None = None
    # Only ever set by streaming test doubles: the real SDK's .responses.stream() adds this
    # client-side on function_call items, and it must never be resubmitted as input.
    parsed_arguments: dict | None = None


class ScriptedModel(AgentModel):
    def __init__(self, steps):
        self.steps = iter(steps)
        self.requests = []

    async def respond(self, inputs):
        self.requests.append(inputs)
        step = next(self.steps)
        if isinstance(step, str):
            return SimpleNamespace(output=[], output_text=step)
        name, arguments = step
        return SimpleNamespace(output=[Output(type='function_call', name=name,
            call_id=f'call-{len(self.requests)}', arguments=json.dumps(arguments))], output_text='')


class FixtureSearch:
    async def search(self, index, site_id, query, near=None):
        if index == 'map_entities':
            return [{'id': 'east_elevator', 'site_id': site_id}]
        return [{'id': 'accessibility-guide:fixture', 'site_id': site_id,
                 'text': 'The East Elevator provides step-free access upstairs.'}]

    async def context(self, site_id, query, floor=None):
        return {'results': [], 'counts_by_category': {}, 'counts_by_role': {}}


class FixtureEvents:
    def __init__(self):
        self.rows = []

    def record(self, session, event_type, data, location=None):
        self.rows.append({'id': str(len(self.rows)), 'site_id': session.site_id,
                          'session_id': session.session_id, 'event_type': event_type, 'data': data,
                          **(location or {})})

    async def recent(self, site_id, session_id, event_type=None, minutes=5):
        return [row for row in self.rows if row['site_id'] == site_id and row['session_id'] == session_id
                and (event_type is None or row['event_type'] == event_type)]

    async def hazard_density(self, site_id, hours=24):
        return []

    async def close(self):
        pass


def demo_model():
    return ScriptedModel([
        ('search_building_knowledge', {'query': 'step free upstairs'}),
        ('search_places', {'query': 'East Elevator'}),
        'The East Elevator provides accessible access upstairs.',
        ('get_current_location', {}), ('search_places', {'query': 'East Elevator'}),
        'The mapped route to the East Elevator is 12 metres from your position.',
        ('set_destination', {'destination_id': 'east_elevator', 'accessible_only': True}),
        'Okay. Navigating to the East Elevator.',
    ])
