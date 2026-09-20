"""Guide-to-note: name resolution without a search service, routes that end beside a pinned note,
stopping guidance, and the agent tools that tie them together."""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from ..app.config import ROOT
from ..app.integrations.elastic.client import IntegrationUnavailable
from ..app.main import create_app
from ..app.services.destinations import normalise, resolve, score, tokens
from ..app.services.worlds import compute_route
from ..scripts.fixtures import FixtureEvents, FixtureSearch, ScriptedModel

PLACES = [{'id': 'entrance', 'name': 'Front entrance', 'position': [0, 0, 0], 'source': 'node'},
          {'id': 'lobby', 'name': 'Lobby desk', 'position': [4.5, 0, -1.2], 'source': 'node'},
          {'id': 'elevators', 'name': 'Elevator bank', 'position': [9, 0, -1.5], 'source': 'node'},
          {'id': 'room-101', 'name': 'Room 101', 'position': [14, 0, 2], 'source': 'node'},
          {'id': 'room-12', 'name': 'Room 12', 'position': [24, 0, 2], 'source': 'node'},
          {'id': 'note:n1', 'name': 'Bed 1', 'position': [2, 0, 0], 'source': 'note', 'text': 'left of the window'},
          {'id': 'note:n2', 'name': 'Bed 2', 'position': [3, 0, 0], 'source': 'note'},
          {'id': 'note:n3', 'name': 'Water fountain', 'position': [0, 0, -3], 'source': 'note', 'text': 'bottle filler by the stairs'}]

GRAPH = {'nodes': [{'id': 'a', 'name': 'Start', 'position': [0, 0, 0]}, {'id': 'b', 'name': 'End', 'position': [0, 0, -10], 'kind': 'destination'}],
         'edges': [{'from': 'a', 'to': 'b'}]}
NOTES = {'schema': 'wander.notes/v1', 'worldId': 'demo-building', 'notes': [
    {'id': 'n1', 'title': 'Bed 1', 'position': [2, 0, -5], 'createdAt': '2026-09-19T12:00:00Z', 'location': 'by the window'}]}
NOTE_TARGETS = [{'id': 'note:n1', 'name': 'Bed 1', 'position': [2, 0, -5], 'source': 'note'}]


def names(rows):
    return [row['name'] for row in rows]


def test_spoken_numbers_and_stop_words():
    assert normalise('room one oh one') == ['room', '101']
    assert normalise('bed one') == ['bed', '1']
    assert normalise('room twelve') == ['room', '12']
    assert normalise('room 2 0 4') == ['room', '204']
    assert tokens('please guide me to the elevator') == ['elevator']


def test_resolve_prefers_exact_names_and_keeps_digits_decisive():
    assert names(resolve(PLACES, 'guide me to bed one')) == ['Bed 1']
    assert names(resolve(PLACES, 'bed 2')) == ['Bed 2']
    assert names(resolve(PLACES, 'take me to room one oh one')) == ['Room 101']
    assert names(resolve(PLACES, 'room 12')) == ['Room 12']
    assert names(resolve(PLACES, 'the elevator')) == ['Elevator bank']
    assert names(resolve(PLACES, 'elevators')) == ['Elevator bank']
    assert names(resolve(PLACES, 'entrance')) == ['Front entrance']          # no drift to "elevator" on letters
    assert names(resolve(PLACES, 'lobby')) == ['Lobby desk']
    assert resolve(PLACES, 'banana') == [] and resolve(PLACES, 'the lift') == []
    # Ambiguity is returned, not guessed: the model asks "Bed 1 or Bed 2?".
    assert set(names(resolve(PLACES, 'bed'))) == {'Bed 1', 'Bed 2'}
    # Note descriptions help ("bottle filler" is not in the title) but rank below name matches.
    assert names(resolve(PLACES, 'bottle filler')) == ['Water fountain']
    assert score(tokens('bottle filler'), PLACES[-1]) < score(tokens('water fountain'), PLACES[-1])
    ranked = resolve(PLACES, 'bed', position=[2.9, 0, 0])
    assert names(ranked) == ['Bed 2', 'Bed 1'] and ranked[0]['distance_m'] == 0.1 and ranked[0]['kind'] == 'note'


def world_with(graph):
    world = json.loads((ROOT / 'shared/contracts/examples/demo-building.world.json').read_text(encoding='utf-8'))
    world['navigationGraph'] = {'frame': 'world', **graph}
    return world


def test_route_ends_beside_the_note():
    world = world_with(GRAPH)
    route = compute_route(world, {'from': 'a', 'to': 'note:n1'}, notes=NOTE_TARGETS)
    assert [n['id'] for n in route['nodes']] == ['a', 'note:n1']
    assert route['nodes'][-1] == {'id': 'note:n1', 'name': 'Bed 1', 'kind': 'destination', 'position': [0, 0, -5]}
    assert route['totalMetres'] == pytest.approx(5)
    assert route['instructions'][0]['text'] == 'Continue straight for 5 metres.'
    assert route['instructions'][-1]['text'] == 'You have arrived at Bed 1.'
    # Start and note on the same edge: straight to the foot point, not via an endpoint.
    direct = compute_route(world, {'from': [0, 0, -2], 'to': 'note:n1'}, notes=NOTE_TARGETS)
    assert direct['totalMetres'] == pytest.approx(3) and direct['nodes'][-1]['id'] == 'note:n1'
    # From beyond the note the route walks back along the corridor.
    back = compute_route(world, {'from': 'b', 'to': 'note:n1'}, notes=NOTE_TARGETS)
    assert back['totalMetres'] == pytest.approx(5)
    with pytest.raises(Exception) as error:
        compute_route(world, {'from': 'a', 'to': 'note:missing'}, notes=NOTE_TARGETS)
    assert error.value.status_code == 404


def test_one_way_edges_only_reach_a_note_from_their_start():
    world = world_with({**GRAPH, 'edges': [{'from': 'a', 'to': 'b', 'bidirectional': False}]})
    assert compute_route(world, {'from': 'a', 'to': 'note:n1'}, notes=NOTE_TARGETS)['totalMetres'] == pytest.approx(5)
    with pytest.raises(Exception) as error:
        compute_route(world, {'from': 'b', 'to': 'note:n1'}, notes=NOTE_TARGETS)
    assert error.value.status_code == 422


@pytest.fixture
def client(settings):
    world = json.loads((ROOT / 'shared/contracts/examples/demo-building.world.json').read_text(encoding='utf-8'))
    path = settings.wander_data_root / 'worlds' / world['id'] / 'world.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(world), encoding='utf-8')
    model = ScriptedModel([
        ('resolve_destination', {'query': 'guide me to bed one'}),
        ('set_destination', {'destination_id': 'note:n1', 'accessible_only': False}),
        'Starting guidance to Bed 1, about 5 metres.',
        ('stop_navigation', {}), 'Guidance stopped.'])
    with TestClient(create_app(settings, model=model, events=FixtureEvents(), search=FixtureSearch()),
                    headers={'X-API-Key': settings.wander_api_key}) as value:
        value.model = model
        assert value.put('/worlds/demo-building/graph', json=GRAPH).status_code == 200
        assert value.put('/worlds/demo-building/notes', json=NOTES).status_code == 200
        yield value


def poser(client, sid):
    start = datetime.now(timezone.utc) - timedelta(seconds=10)

    def update(seconds, point, rotation=(0, 0, 0, 1), tracking='localized'):
        result = client.post(f'/sessions/{sid}/pose', json={'timestamp': (start + timedelta(seconds=seconds)).isoformat(),
            'trackingState': tracking, 'pose': {'position': point, 'rotation': list(rotation)}})
        assert result.status_code == 200, result.text
        return result.json()
    return update


def test_session_guides_to_a_note_then_stops(client):
    assert client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone', 'destination': 'note:nope'}).status_code == 404
    sid = client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone', 'destination': 'note:n1'}).json()['sessionId']
    update = poser(client, sid)
    first = update(0, [0, 0, 0])
    assert first['state'] == 'navigating' and first['remainingMetres'] == pytest.approx(5)
    assert first['speak'] == 'Continue straight for 5 metres.' and first['nextNode']['name'] == 'Bed 1'
    # Facing -Z at the foot point, the note (2 m along +X) is on the right.
    arrived = update(1, [0, 0, -5])
    assert arrived['state'] == 'arrived'
    assert arrived['speak'] == 'You have arrived at Bed 1. Bed 1 is 2 metres on your right.'
    assert client.get(f'/sessions/{sid}').json()['destination'] == 'note:n1'

    stopped = client.delete(f'/sessions/{sid}/destination')
    assert stopped.status_code == 200
    assert stopped.json()['state'] == 'localizing' and 'destination' not in stopped.json()
    assert stopped.json()['lastProgress']['speak'] == 'Guidance stopped.'
    # Poses keep flowing without a destination so server-side guidance can start any time.
    assert update(2, [0, 0, -5])['state'] == 'localizing'
    assert client.put(f'/sessions/{sid}/destination', json={'destination': 'note:missing'}).status_code == 404
    assert client.put(f'/sessions/{sid}/destination', json={'destination': 'note:n1'}).status_code == 200
    assert update(3, [0, 0, -5])['state'] == 'arrived'


def test_agent_resolves_a_spoken_note_and_stops_guidance(client):
    sid = client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone'}).json()['sessionId']
    poser(client, sid)(0, [0, 0, 0])
    result = client.post('/assistant/query', json={'session_id': sid, 'text': 'guide me to bed one'}).json()
    assert result['text'] == 'Starting guidance to Bed 1, about 5 metres.'
    assert result['actions'] == [{'type': 'set_destination', 'destination_id': 'note:n1', 'destination_name': 'Bed 1',
                                  'accessible_only': False}]
    candidates = result['tool_calls'][0]['result']['data']['candidates']
    assert candidates[0]['id'] == 'note:n1' and candidates[0]['route_distance_m'] == 5.0 and candidates[0]['text'] == 'by the window'
    assert {'type': 'map_entity', 'id': 'note:n1'} in result['sources']
    assert client.get(f'/sessions/{sid}').json()['destination'] == 'note:n1'
    # The catalogue is in the application context, so the model can pick names without a tool call.
    context = next(item['content'] for item in client.model.requests[0]
                   if isinstance(item, dict) and 'application_context' in item.get('content', ''))
    payload = json.loads(context.split('\n')[1])
    assert {'id': 'note:n1', 'name': 'Bed 1', 'kind': 'note'} in payload['destinations']
    assert payload['destinations'][0]['id'] == 'a'   # nearest first when localized
    assert payload['nearby_notes'][0]['name'] == 'Bed 1' and payload['nearby_notes'][0]['distance_m'] == 5.4

    result = client.post('/assistant/query', json={'session_id': sid, 'text': 'stop'}).json()
    assert result['actions'] == [{'type': 'stop_navigation', 'destination_id': 'note:n1'}]
    assert result['tool_calls'][0]['result']['data']['stopped'] is True
    assert 'destination' not in client.get(f'/sessions/{sid}').json()


def test_search_places_falls_back_to_name_matching_without_elastic(settings):
    class Unavailable:
        async def search(self, *args, **kwargs):
            raise IntegrationUnavailable('Elasticsearch is not configured')

        async def context(self, *args, **kwargs):
            raise IntegrationUnavailable('Elasticsearch is not configured')
    world = json.loads((ROOT / 'shared/contracts/examples/demo-building.world.json').read_text(encoding='utf-8'))
    path = settings.wander_data_root / 'worlds' / world['id'] / 'world.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(world), encoding='utf-8')
    model = ScriptedModel([('search_places', {'query': 'the elevator'}), 'The Elevator bank is about 9 metres away.'])
    with TestClient(create_app(settings, model=model, events=FixtureEvents(), search=Unavailable()),
                    headers={'X-API-Key': settings.wander_api_key}) as client:
        sid = client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone'}).json()['sessionId']
        poser(client, sid)(0, [0, 0, 0])
        result = client.post('/assistant/query', json={'session_id': sid, 'text': 'where is the elevator'}).json()
        rows = result['tool_calls'][0]['result']['data']
        assert rows[0]['id'] == 'elevators' and rows[0]['evidence_class'] == 'local_catalogue'
        assert rows[0]['route_distance_m'] == pytest.approx(9.2, abs=0.1)
        assert result['sources'] == [{'type': 'map_entity', 'id': 'elevators'}]
