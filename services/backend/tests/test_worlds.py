from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
import json
import math

import pytest
import trimesh
from fastapi.testclient import TestClient
from ..app.main import create_app
from ..app.services.worlds import check, compute_route, world_graph
from ..app.config import ROOT
from ..app.integrations.elastic.client import ElasticClient
from ..scripts.fixtures import ScriptedModel, FixtureEvents, FixtureSearch


@pytest.fixture
def world():
    return json.loads((ROOT / 'shared/contracts/examples/demo-building.world.json').read_text(encoding='utf-8'))


@pytest.fixture
def client(settings, world):
    path = settings.wander_data_root / 'worlds' / world['id'] / 'world.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(world), encoding='utf-8')
    with TestClient(create_app(settings, model=ScriptedModel([]), events=FixtureEvents(),
                              search=FixtureSearch()), headers={'X-API-Key': settings.wander_api_key}) as value:
        yield value


def test_auth_fails_closed(client):
    assert client.get('/worlds', headers={'X-API-Key': ''}).status_code == 401
    assert client.get('/worlds', headers={'X-API-Key': 'wrong'}).json() == {'detail': 'invalid api key'}


def test_world_crud_and_schema(client):
    result = client.post('/worlds', json={'id': 'test', 'name': 'Test'})
    assert result.status_code == 201
    check(result.json(), 'world.schema.json')
    assert client.post('/worlds', json={'id': 'test', 'name': 'Test'}).status_code == 409
    assert client.post('/worlds', json={'id': '..escape', 'name': 'Test'}).status_code == 400
    assert len(client.get('/worlds').json()['worlds']) == 2
    assert client.patch('/worlds/test', json={'assets': {}}).status_code == 400
    assert client.patch('/worlds/test', json={'name': 'New'}).json()['name'] == 'New'
    assert client.delete('/worlds/test').status_code == 204
    assert client.get('/worlds/test').status_code == 404


def test_graph_measurements_and_immutable_assets(client, world):
    url = '/worlds/demo-building'
    invalid = deepcopy(world['navigationGraph'])
    invalid['nodes'].append(invalid['nodes'][0])
    assert client.put(url+'/graph', json=invalid).status_code == 400
    invalid = deepcopy(world['navigationGraph'])
    invalid['edges'][0]['to'] = 'unknown'
    assert client.put(url+'/graph', json=invalid).status_code == 400
    assert client.get(url+'/measurements').json()['measurements'] == []
    measurements = {'schema': 'wander.measurements/v1', 'worldId': 'demo-building', 'measurements': [
        {'id': 'width', 'points': [[0,0,0], [1,0,0]]}]}
    assert client.put(url+'/measurements', json=measurements).status_code == 200
    check(client.get(url+'/measurements').json(), 'measurements.schema.json')
    assert client.put(url+'/v1/scene.spz', content=b'splat').status_code == 201
    assert client.put(url+'/v1/scene.spz', content=b'overwrite').status_code == 409
    asset = client.get(url+'/v1/scene.spz')
    assert asset.content == b'splat' and asset.headers['content-length'] == '5'
    assert 'immutable' in asset.headers['cache-control'] and 'etag' in asset.headers
    assert client.put(url+'/v2/scene.spz', content=b'new').status_code == 201
    updated = client.patch(url, json={'version': 'v2'})
    assert updated.json()['assets']['splat'].endswith('/v2/scene.spz')


def test_notes_round_trip(client, world):
    url = '/worlds/demo-building/notes'
    assert client.get(url).json()['notes'] == []
    notes = {'schema': 'wander.notes/v1', 'worldId': 'demo-building', 'notes': [
        {'id': 'n1', 'title': 'Broken handrail', 'location': 'Stairwell B',
         'position': [1, 0, -2], 'createdAt': '2026-09-19T12:00:00Z'}]}
    assert client.put(url, json=notes).status_code == 200
    stored = client.get(url).json()
    check(stored, 'notes.schema.json')
    assert stored['notes'][0]['title'] == 'Broken handrail' and stored['updatedAt']
    # worldId must match the path, and the payload must satisfy the contract.
    assert client.put(url, json={**notes, 'worldId': 'other'}).status_code == 400
    assert client.put(url, json={'schema': 'wander.notes/v1', 'worldId': 'demo-building',
                                 'notes': [{'title': 'no id'}]}).status_code == 400
    assert client.get('/worlds/missing/notes').status_code == 404


def test_weighted_directed_routing_and_heading(world):
    world['navigationGraph'] = {'nodes': [
        {'id': 'a', 'position': [0,0,0]}, {'id': 'b', 'position': [0,0,-10]},
        {'id': 'c', 'position': [10,0,0]}], 'edges': [
        {'from': 'a', 'to': 'b', 'distance': 1, 'bidirectional': False},
        {'from': 'a', 'to': 'c', 'distance': 5}, {'from': 'c', 'to': 'b', 'distance': 5}]}
    route = compute_route(world, {'from': [0,0,-5], 'to': 'b'})
    check(route, 'navigation.schema.json', '#/$defs/routeResponse')
    assert route['totalMetres'] == .5 and route['legs'][0]['headingDeg'] == 0
    reverse = compute_route(world, {'from': [0,0,-5], 'to': 'a'})
    assert reverse['totalMetres'] == 10.5
    avoiding = compute_route(world, {'from': 'a', 'to': 'b', 'avoid': ['c']})
    assert avoiding['totalMetres'] == 1


def test_alignment_changes_graph_but_not_vps_pose(client, world):
    world['navigationGraph']['frame'] = 'splat'
    world['alignment']['position'] = [100,0,0]
    world['alignment']['scale'] = 2
    assert world_graph(world)['nodes'][0]['position'] == [100,0,0]
    client.patch('/worlds/demo-building', json={'nianticSiteId': 'site', 'alignment': world['alignment']})
    client.put('/worlds/demo-building/graph', json=world['navigationGraph'])
    data = {'deviceId': 'phone', 'nianticSiteId': 'site', 'confidence': .9,
            'pose': {'position': [100,0,0], 'rotation': [0,0,0,1]}, 'timestamp': datetime.now(timezone.utc).isoformat()}
    result = client.post('/worlds/demo-building/localize', json=data)
    assert result.status_code == 200
    check(result.json(), 'navigation.schema.json', '#/$defs/localizationResponse')
    assert result.json()['pose']['position'] == [100,0,0]
    assert result.json()['offGraphMetres'] == 0
    data['nianticSiteId'] = 'wrong'
    assert client.post('/worlds/demo-building/localize', json=data).status_code == 409


def test_session_progress_events_and_persistence(client, settings):
    session = client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone',
                                            'destination': 'room-101'}).json()
    check(session, 'navigation.schema.json', '#/$defs/session')
    sid = session['sessionId']
    timestamp = datetime.now(timezone.utc).isoformat()
    with client.websocket_connect(f'/ws/sessions/{sid}') as ws:
        check(ws.receive_json(), 'navigation.schema.json', '#/$defs/sessionEvent')
        ws.send_json({'type': 'ping'})
        response = client.post(f'/sessions/{sid}/pose', json={'timestamp': timestamp,
            'pose': {'position': [0,0,0], 'rotation': [0,0,0,1]}, 'trackingState': 'localized'})
        assert response.status_code == 200
        check(response.json(), 'navigation.schema.json', '#/$defs/progressUpdate')
        assert ws.receive_json()['type'] == 'rerouted'
        assert ws.receive_json()['type'] == 'progress'
        assert client.post(f'/sessions/{sid}/pose', json={'timestamp': timestamp,
            'pose': {'position': [0,0,0], 'rotation': [0,0,0,1]}}).status_code == 400
    from ..app.services.worlds import WorldStore
    assert WorldStore(settings.wander_data_root).session(sid)['state'] == 'navigating'
    assert client.delete(f'/sessions/{sid}').status_code == 204
    assert client.get(f'/sessions/{sid}').json()['state'] == 'ended'


def test_invalid_quaternion_and_no_implicit_world_session(client):
    sid = client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone',
                                       'destination': 'room-101'}).json()['sessionId']
    assert client.post(f'/sessions/{sid}/pose', json={'timestamp': datetime.now(timezone.utc).isoformat(),
        'pose': {'position': [0,0,0], 'rotation': [0,0,0,0]}}).status_code == 400
    assert client.post('/worlds/demo-building/route', json={'to': 'room-101'}).status_code == 400


def test_graph_updates_are_immediate_and_splat_switch_supported(client, world):
    url = '/worlds/demo-building'
    route = client.post(url+'/route', json={'from': 'entrance', 'to': 'room-101'}).json()
    graph = deepcopy(world['navigationGraph'])
    graph['edges'] = [{'from': 'entrance', 'to': 'room-101', 'distance': 2}]
    assert client.put(url+'/graph', json=graph).status_code == 200
    assert client.post(url+'/route', json={'from': 'entrance', 'to': 'room-101'}).json()['totalMetres'] == 2
    assert route['totalMetres'] > 2
    assert client.put(url+'/v2/scene.ply', content=b'ply').status_code == 201
    assert client.patch(url, json={'version': 'v2'}).json()['assets']['splat'].endswith('/scene.ply')


def test_lost_tracking_offroute_reroute_and_arrival(client):
    graph = {'nodes': [{'id': 'a', 'position': [0,0,0]}, {'id': 'b', 'position': [0,0,-10], 'kind': 'destination'}],
             'edges': [{'from': 'a', 'to': 'b'}]}
    client.put('/worlds/demo-building/graph', json=graph)
    sid = client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone', 'destination': 'b'}).json()['sessionId']
    start = datetime.now(timezone.utc)-timedelta(seconds=10)
    def update(seconds, point, tracking='localized'):
        result = client.post(f'/sessions/{sid}/pose', json={'timestamp': (start+timedelta(seconds=seconds)).isoformat(),
            'trackingState': tracking, 'pose': {'position': point, 'rotation': [0,0,0,1]}})
        assert result.status_code == 200, result.text
        return result.json()
    assert update(0, [0,0,0])['state'] == 'navigating'
    assert update(1, [5,0,-2])['state'] == 'off-route'
    with client.websocket_connect(f'/ws/sessions/{sid}') as ws:
        ws.receive_json()
        assert update(7, [5,0,-3])['state'] == 'off-route'
        assert ws.receive_json()['type'] == 'rerouted'
        assert ws.receive_json()['type'] == 'progress'
    assert update(8, [0,0,-5], 'lost')['state'] == 'lost'
    assert update(9, [0,0,-10])['state'] == 'arrived'


def test_annotation_publication_uses_current_world_hash(client, world):
    from ..app.services.annotations import AnnotationBatch, Candidate, batch_digest, world_digest
    batch = AnnotationBatch(site_id=world['id'], map_revision='v1', floor=0, model='fake', candidates=[
        Candidate(id='water', frame='a.jpg', frame_sha256='abc', category='bottle_filler',
                  name='Bottle filler', description='Verified fixture', sign_text='', designation='unknown', uncertainty='')])
    review = {'site_id': world['id'], 'map_revision': 'v1', 'batch_sha256': batch_digest(batch),
        'graph_sha256': world_digest(world), 'reviews': [{'candidate_id': 'water', 'decision': 'approve',
        'waypoint_id': 'lobby', 'verified_by': 'Surveyor', 'verified_at': '2026-09-19'}]}
    result = client.put('/worlds/demo-building/annotations', json={'batch': batch.model_dump(), 'review': review})
    assert result.status_code == 200, result.text
    check(result.json(), 'world.schema.json')
    assert result.json()['navigationGraph']['nodes'][-1]['id'] == 'water'
    assert client.post('/worlds/demo-building/route', json={'from': 'entrance', 'to': 'water'}).status_code == 200
    assert client.put('/worlds/demo-building/annotations', json={'batch': batch.model_dump(), 'review': review}).status_code == 422


def test_publish_reindexes_and_notes_hazards_without_a_separate_index_call(settings, world):
    from ..app.services.annotations import AnnotationBatch, Candidate, batch_digest, world_digest
    path = settings.wander_data_root / 'worlds' / world['id'] / 'world.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(world), encoding='utf-8')
    stub = SimpleNamespace(
        inference=SimpleNamespace(inference=AsyncMock(return_value={'text_embedding': [{'embedding': [1, 0, 0]}]})),
        index=AsyncMock(), close=AsyncMock(),
        indices=SimpleNamespace(exists=AsyncMock(return_value=True), create=AsyncMock(), put_mapping=AsyncMock()))
    elastic = ElasticClient(settings, stub)
    with TestClient(create_app(settings, model=ScriptedModel([]), events=FixtureEvents(), search=FixtureSearch(),
                              elastic=elastic), headers={'X-API-Key': settings.wander_api_key}) as client:
        batch = AnnotationBatch(site_id=world['id'], map_revision='v1', floor=0, model='fake', candidates=[
            Candidate(id='hazard-1', frame='a.jpg', frame_sha256='abc', category='obstacle',
                      name='Loose cable', description='Cable across corridor', sign_text='',
                      designation='unknown', uncertainty='Uncertain extent', navigation_role='potential_hazard')])
        review = {'site_id': world['id'], 'map_revision': 'v1', 'batch_sha256': batch_digest(batch),
            'graph_sha256': world_digest(world), 'reviews': [{'candidate_id': 'hazard-1', 'decision': 'note',
            'waypoint_id': 'lobby', 'verified_by': 'Surveyor', 'verified_at': '2026-09-19'}]}
        result = client.put(f"/worlds/{world['id']}/annotations",
                            json={'batch': batch.model_dump(), 'review': review})
        assert result.status_code == 200, result.text
    notes_path = settings.wander_data_root / 'worlds' / world['id'] / 'context-notes.json'
    assert notes_path.exists()
    notes = json.loads(notes_path.read_text())
    assert notes[0]['id'] == 'hazard-1'
    assert notes[0]['navigation_role'] == 'potential_hazard'
    # Reindex happened inline as part of publish; no separate POST /index call was made.
    assert stub.index.await_count >= 1
    indexed_ids = {call.kwargs['document']['id'] for call in stub.index.await_args_list}
    assert 'hazard-1' in indexed_ids


def test_saving_notes_reindexes_them_so_hand_placed_pins_are_searchable(settings, world):
    path = settings.wander_data_root / 'worlds' / world['id'] / 'world.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(world), encoding='utf-8')
    stub = SimpleNamespace(
        inference=SimpleNamespace(inference=AsyncMock(return_value={'text_embedding': [{'embedding': [1, 0, 0]}]})),
        index=AsyncMock(), close=AsyncMock(),
        indices=SimpleNamespace(exists=AsyncMock(return_value=True), create=AsyncMock(), put_mapping=AsyncMock()))
    elastic = ElasticClient(settings, stub)
    with TestClient(create_app(settings, model=ScriptedModel([]), events=FixtureEvents(), search=FixtureSearch(),
                              elastic=elastic), headers={'X-API-Key': settings.wander_api_key}) as client:
        notes = {'schema': 'wander.notes/v1', 'worldId': world['id'], 'notes': [
            {'id': 'bed-1', 'title': 'Bed 1', 'location': 'North wall', 'position': [1, 0, 2],
             'createdAt': '2026-09-19T12:00:00Z'}]}
        assert client.put(f"/worlds/{world['id']}/notes", json=notes).status_code == 200
    assert stub.index.await_count >= 1
    document = stub.index.await_args_list[-1].kwargs['document']
    assert document['id'] == 'bed-1' and document['name'] == 'Bed 1' and document['is_destination'] is False


def test_agent_can_read_persisted_world_session(client):
    sid = client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone'}).json()['sessionId']
    result = client.post('/assistant/query', json={'session_id': sid, 'text': 'Where am I?'})
    assert result.status_code == 200
    assert client.app.state.store.get(sid).site_id == 'demo-building'


def test_oversized_asset_is_not_published(client):
    client.app.state.settings.asset_max_bytes = 3
    result = client.put('/worlds/demo-building/v1/scene.spz', content=b'1234')
    assert result.status_code == 413
    assert client.get('/worlds/demo-building/v1/scene.spz').status_code == 404
    assert not list(client.app.state.worlds.path('worlds', 'demo-building', 'v1').glob('upload-*'))


def test_world_socket_authentication_and_read_only_commands(client):
    from starlette.testclient import WebSocketDenialResponse
    from starlette.websockets import WebSocketDisconnect
    sid = client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone'}).json()['sessionId']
    with pytest.raises(WebSocketDenialResponse) as error:
        with client.websocket_connect(f'/ws/sessions/{sid}', headers={'X-API-Key': 'wrong'}):
            pass
    assert error.value.status_code == 401
    with client.websocket_connect(f'/ws/sessions/{sid}') as socket:
        socket.receive_json()
        socket.send_json({'type': 'set_destination', 'destination': 'room-101'})
        with pytest.raises(WebSocketDisconnect):
            socket.receive_json()


def test_api_key_unconfigured_is_not_an_auth_bypass(settings):
    settings.wander_api_key = ''
    with TestClient(create_app(settings, model=ScriptedModel([]), events=FixtureEvents())) as client:
        assert client.get('/health').status_code == 401


def test_first_instruction_is_relative_to_heading(world):
    world['navigationGraph'] = {'nodes': [{'id': 'a', 'position': [0,0,0]}, {'id': 'b', 'position': [10,0,0]}],
                                'edges': [{'from': 'a', 'to': 'b'}]}
    facing_east = compute_route(world, {'from': 'a', 'to': 'b', 'headingDeg': 90})
    assert facing_east['instructions'][0]['turn'] == 'straight'
    facing_north = compute_route(world, {'from': 'a', 'to': 'b', 'headingDeg': 0})
    assert facing_north['instructions'][0]['turn'] == 'right'
    facing_west = compute_route(world, {'from': 'a', 'to': 'b', 'headingDeg': 270})
    assert facing_west['instructions'][0]['turn'] == 'u-turn'
    assert compute_route(world, {'from': 'a', 'to': 'b'})['instructions'][0]['turn'] == 'straight'


def test_yaw_matches_leg_heading_convention():
    from ..app.routing.heading import yaw, bearing, legacy_heading
    assert yaw([0,0,0,1]) == pytest.approx(0)                       # camera looks down -Z
    assert yaw([0,-math.sqrt(.5),0,math.sqrt(.5)]) == pytest.approx(90)  # -90° about Y turns -Z into +X
    assert bearing([0,0,0], [1,0,0]) == pytest.approx(90)
    assert legacy_heading(0) == 180 and legacy_heading(90) == 270


def test_chest_height_pose_uses_horizontal_thresholds_and_speaks_turns(client):
    graph = {'nodes': [{'id': 'a', 'position': [0,0,0]}, {'id': 'b', 'position': [0,0,-10]},
                       {'id': 'c', 'position': [10,0,-10], 'kind': 'destination'}],
             'edges': [{'from': 'a', 'to': 'b'}, {'from': 'b', 'to': 'c'}]}
    client.put('/worlds/demo-building/graph', json=graph)
    sid = client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone', 'destination': 'c'}).json()['sessionId']
    start = datetime.now(timezone.utc)-timedelta(seconds=10)
    east = [0, -math.sqrt(.5), 0, math.sqrt(.5)]
    def update(seconds, point, rotation=(0,0,0,1)):
        result = client.post(f'/sessions/{sid}/pose', json={'timestamp': (start+timedelta(seconds=seconds)).isoformat(),
            'trackingState': 'localized', 'pose': {'position': point, 'rotation': list(rotation)}})
        assert result.status_code == 200, result.text
        return result.json()
    first = update(0, [0, 1.3, 0])
    assert first['state'] == 'navigating' and first['headingDeg'] == pytest.approx(0)
    assert first['instruction']['turn'] == 'straight' and first['speak'] == first['instruction']['text']
    assert first['distanceToNextMetres'] == pytest.approx(10)
    # Same leg, same heading: nothing new to say.
    assert 'speak' not in update(1, [0, 1.3, -4])
    # Reaching b 1.3 m above the floor still counts; facing north, c is to the right.
    at_b = update(2, [0, 1.3, -10])
    assert at_b['nextNode']['id'] == 'c' and at_b['instruction']['turn'] == 'right' and 'speak' in at_b
    # Turning to face east settles into 'straight' and is spoken once.
    turned = update(6, [0, 1.3, -10], east)
    assert turned['instruction']['turn'] == 'straight' and 'speak' in turned
    assert 'speak' not in update(7, [3, 1.3, -10], east)
    assert update(8, [10, 1.3, -10], east)['state'] == 'arrived'


def test_mesh_upload_registers_and_navmesh_proposal_stays_unpublished(client, world):
    url = '/worlds/demo-building'
    assert client.post(url+'/navmesh', json={}).status_code == 409
    # 8 m × 6 m room: floor slab at y=0, walls around, one wall across the middle with a 1.4 m gap.
    parts = []
    for size, centre in [((8.4, .1, 6.4), (0, -.05, 0)), ((.2, 2.5, 6.4), (-4.1, 1.25, 0)), ((.2, 2.5, 6.4), (4.1, 1.25, 0)),
                         ((8.4, 2.5, .2), (0, 1.25, -3.1)), ((8.4, 2.5, .2), (0, 1.25, 3.1)),
                         ((.2, 2.5, 2.3), (0, 1.25, -1.85)), ((.2, 2.5, 2.3), (0, 1.25, 1.85))]:
        box = trimesh.creation.box(extents=size)
        box.apply_translation(centre)
        parts.append(box)
    assert client.put(url+'/v1/mesh.glb', content=trimesh.util.concatenate(parts).export(file_type='glb')).status_code == 201
    assert client.get(url).json()['assets']['mesh'] == 'worlds/demo-building/v1/mesh.glb'
    assert client.get(url+'/navmesh').status_code == 404

    proposal = client.post(url+'/navmesh', json={'params': {'cell': .2}})
    assert proposal.status_code == 201, proposal.text
    proposal = proposal.json()
    assert proposal['status'] == 'proposed' and proposal['params']['cell'] == .2
    assert len(proposal['graph']['nodes']) >= 4 and proposal['graph']['edges']
    assert proposal['grid']['walkableCells'] > 0
    assert client.get(url+'/navmesh').json()['createdAt'] == proposal['createdAt']
    # The live graph is untouched until a reviewer PUTs the proposal.
    assert client.get(url).json()['navigationGraph'] == world['navigationGraph']
    assert client.put(url+'/graph', json=proposal['graph']).status_code == 200
    assert len(client.get(url).json()['navigationGraph']['nodes']) == len(proposal['graph']['nodes'])

    # Validation: a floating node and an edge straight through the divider; snapping is returned, not saved.
    graph = {'nodes': [{'id': 'w', 'position': [-2, 1.4, 0]}, {'id': 'e', 'position': [2, 0, 2]}],
             'edges': [{'from': 'w', 'to': 'e'}]}
    result = client.post(url+'/graph/validate', json={'graph': graph, 'params': {'cell': .2}})
    assert result.status_code == 200, result.text
    kinds = {(i['kind'], i.get('node') or (i.get('from'), i.get('to'))) for i in result.json()['issues']}
    assert ('edge-through-wall', ('w', 'e')) in kinds and ('node-height', 'w') in kinds
    assert result.json()['graph']['nodes'][0]['position'][1] == pytest.approx(0, abs=.03)
    assert client.get(url).json()['navigationGraph']['nodes'][0]['id'] != 'w'
    assert client.post(url+'/graph/validate', json={'params': {'cell': -1}}).status_code == 422


def two_floor_graph():
    """Ground floor a-b-c; stairs at b and an elevator at c both reach floor 2, which leads to the goal."""
    return {'nodes': [
        {'id': 'a', 'position': [0, 0, 0], 'floor': '1'},
        {'id': 'b', 'position': [0, 0, -10], 'floor': '1'},
        {'id': 'c', 'position': [10, 0, -10], 'floor': '1'},
        {'id': 'b2', 'position': [0, 4, -10], 'floor': '2'},
        {'id': 'c2', 'position': [10, 4, -10], 'floor': '2'},
        {'id': 'goal', 'position': [0, 4, -20], 'floor': '2', 'kind': 'destination'}],
        'edges': [
        {'from': 'a', 'to': 'b'}, {'from': 'b', 'to': 'c'},
        {'from': 'b', 'to': 'b2', 'kind': 'stairs'},
        {'from': 'c', 'to': 'c2', 'kind': 'elevator'},
        {'from': 'c2', 'to': 'b2'}, {'from': 'b2', 'to': 'goal'}]}


def test_accessible_only_skips_stairs_and_takes_the_elevator(world):
    world['navigationGraph'] = two_floor_graph()
    stairs = compute_route(world, {'from': 'a', 'to': 'goal'})
    assert [n['id'] for n in stairs['nodes']] == ['a', 'b', 'b2', 'goal']
    assert stairs['legs'][1]['kind'] == 'stairs' and 'kind' not in stairs['legs'][0]
    assert stairs['instructions'][1] == {'atNode': 'b', 'turn': 'stairs', 'text': 'Take the stairs to floor 2.',
                                         'distanceMetres': 10}
    check(stairs, 'navigation.schema.json', '#/$defs/routeResponse')
    lift = compute_route(world, {'from': 'a', 'to': 'goal', 'accessibleOnly': True})
    assert [n['id'] for n in lift['nodes']] == ['a', 'b', 'c', 'c2', 'b2', 'goal']
    assert lift['instructions'][2]['turn'] == 'elevator'
    # Coming out of the elevator, the turn is measured from the way in (east), so b2 is behind: u-turn.
    assert lift['instructions'][3]['turn'] == 'u-turn'
    # A free start next to the stairwell snaps to the corridor, never onto the stairs edge.
    assert [n['id'] for n in compute_route(world, {'from': [0, 2, -10], 'to': 'goal'})['nodes']][:2] == ['b', 'b2']
    # Explicit `accessible` beats the kind default: a stepped corridor is excluded, a stair-lift allowed.
    world['navigationGraph']['edges'][4]['accessible'] = False
    world['navigationGraph']['edges'][2]['accessible'] = True
    assert [n['id'] for n in compute_route(world, {'from': 'a', 'to': 'goal', 'accessibleOnly': True})['nodes']] == \
        ['a', 'b', 'b2', 'goal']
    world['navigationGraph']['edges'][2]['accessible'] = False
    with pytest.raises(Exception) as error:
        compute_route(world, {'from': 'a', 'to': 'goal', 'accessibleOnly': True})
    assert error.value.status_code == 422 and 'without stairs' in error.value.detail


def test_cross_floor_walk_edges_are_rejected(client):
    graph = two_floor_graph()
    graph['edges'][2] = {'from': 'b', 'to': 'b2'}
    result = client.put('/worlds/demo-building/graph', json=graph)
    assert result.status_code == 400 and 'joins floors 1 and 2' in result.json()['detail']
    assert client.put('/worlds/demo-building/graph', json=two_floor_graph()).status_code == 200


def test_session_accessible_only_persists_and_vertical_legs_wait_for_the_storey(client):
    client.put('/worlds/demo-building/graph', json=two_floor_graph())
    assert client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'p', 'accessibleOnly': 'yes'}).status_code == 400
    session = client.post('/sessions', json={'worldId': 'demo-building', 'deviceId': 'phone', 'destination': 'goal',
                                            'accessibleOnly': True}).json()
    check(session, 'navigation.schema.json', '#/$defs/session')
    assert session['accessibleOnly'] is True
    sid = session['sessionId']
    start = datetime.now(timezone.utc)-timedelta(seconds=10)
    def update(seconds, point):
        result = client.post(f'/sessions/{sid}/pose', json={'timestamp': (start+timedelta(seconds=seconds)).isoformat(),
            'trackingState': 'localized', 'pose': {'position': point, 'rotation': [0, 0, 0, 1]}})
        assert result.status_code == 200, result.text
        return result.json()
    first = update(0, [0, 1.3, 0])
    assert [n['id'] for n in client.get(f'/sessions/{sid}').json()['route']['nodes']] == ['a', 'b', 'c', 'c2', 'b2', 'goal']
    assert first['nextNode']['id'] == 'b'
    assert update(1, [0, 1.3, -10])['nextNode']['id'] == 'c'
    # Standing at the ground-floor elevator door: told to take it, and the leg does not advance until floor 2.
    at_c = update(2, [10, 1.3, -10])
    assert at_c['instruction']['turn'] == 'elevator' and at_c['speak'] == 'Take the elevator to floor 2.'
    assert update(3, [10, 1.3, -10])['nextNode']['id'] == 'c2'
    upstairs = update(8, [10, 5.3, -10])
    assert upstairs['nextNode']['id'] == 'b2' and upstairs['instruction']['turn'] != 'elevator'
    assert update(10, [0, 5.3, -10])['nextNode']['id'] == 'goal'
    assert update(12, [0, 5.3, -20])['state'] == 'arrived'


def test_splat_graph_validation_result_is_not_transformed_twice(world):
    world['alignment'] = {'frame': 'niantic-vps', 'position': [10, 0, 0], 'rotation': [0, 0, 0, 1], 'scale': 1}
    world['navigationGraph'] = {'frame': 'splat', 'nodes': [{'id': 'a', 'position': [1, 0, 0]}], 'edges': []}
    converted = world_graph(world)
    assert converted['frame'] == 'world'
    assert converted['nodes'][0]['position'] == [11, 0, 0]
    assert world_graph({**world, 'navigationGraph': converted}) == converted


def test_proposal_preserves_places_and_rejects_stale_acceptance(client):
    url = '/worlds/demo-building'
    graph = {'nodes': [
        {'id': 'entrance', 'name': 'Entrance', 'kind': 'entrance', 'position': [-2, 0, 0]},
        {'id': 'desk', 'name': 'Desk', 'kind': 'destination', 'position': [2, 0, 0]},
    ], 'edges': [{'from': 'entrance', 'to': 'desk'}]}
    assert client.put(url + '/graph', json=graph).status_code == 200
    mesh = trimesh.creation.box(extents=(8, .1, 6))
    mesh.apply_translation((0, -.05, 0))
    assert client.put(url + '/v1/mesh.glb', content=mesh.export(file_type='glb')).status_code == 201
    response = client.post(url + '/navmesh', json={})
    assert response.status_code == 201, response.text
    proposal = response.json()
    assert proposal['proposalIssues'] == []
    assert {p['id'] for p in proposal['places'] if p['connected']} == {'entrance', 'desk'}
    assert client.get(url).json()['navigationGraph'] == graph
    assert client.put(url + '/graph', json=proposal['graph'], headers={'If-Match': proposal['sourceRevision']}).status_code == 200
    # Replaying the old preview cannot overwrite a graph changed since generation.
    response = client.put(url + '/graph', json=proposal['graph'], headers={'If-Match': proposal['sourceRevision']})
    assert response.status_code == 412
    # A new mesh alignment also invalidates an otherwise-current preview.
    proposal = client.post(url + '/navmesh', json={}).json()
    assert client.patch(url, json={'meshFrame': 'splat'}).status_code == 200
    assert client.put(url + '/graph', json=proposal['graph'], headers={'If-Match': proposal['sourceRevision']}).status_code == 412
