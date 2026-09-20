import json
import time
from fastapi.testclient import TestClient
from ..app.main import create_app
from ..scripts.fixtures import ScriptedModel, FixtureEvents, FixtureSearch
from ..scripts.simulate_navigation import pose_message


def make_client(settings, model=None):
    return TestClient(create_app(settings, model=model or ScriptedModel([]),
        events=FixtureEvents(), search=FixtureSearch()), headers={'X-API-Key': settings.wander_api_key})


def test_http_sessions_and_errors(settings):
    with make_client(settings) as client:
        assert client.get('/health').json() == {'status': 'ok'}
        session = client.post('/legacy/sessions', json={})
        assert session.status_code == 201
        sid = session.json()['session_id']
        assert client.get(f'/legacy/sessions/{sid}').status_code == 200
        assert client.get('/legacy/sessions/unknown').status_code == 404
        assert client.post('/legacy/sessions', json={'site_id': 'unknown'}).status_code == 422
        assert len(client.get('/destinations').json()['destinations']) == 8
        assert client.post(f'/legacy/sessions/{sid}/destination', json={'destination_id': 'east_elevator'}).status_code == 422
        assert client.post('/assistant/query', json={'session_id': sid, 'text': ''}).status_code == 422


def test_assistant_query_stream_emits_deltas_then_a_final_event(settings):
    with make_client(settings, model=ScriptedModel(['Hello there.'])) as client:
        sid = client.post('/legacy/sessions', json={}).json()['session_id']
        response = client.post('/assistant/query/stream', json={'session_id': sid, 'text': 'Hi'})
        assert response.status_code == 200
        assert response.headers['content-type'].startswith('text/event-stream')
        events = [json.loads(chunk[len('data: '):]) for chunk in response.text.strip().split('\n\n') if chunk]
        # ScriptedModel has no real token deltas (it answers in one shot via the base
        # AgentModel.stream() default), so the only event is the final payload.
        assert events == [{'type': 'final', 'text': 'Hello there.', 'sources': [], 'actions': [], 'tool_calls': []}]


def test_navigation_websocket_malformed_recovery_and_broadcast(settings):
    with make_client(settings) as client:
        sid = client.post('/legacy/sessions', json={}).json()['session_id']
        with client.websocket_connect(f'/ws/legacy/sessions/{sid}') as one, client.websocket_connect(f'/ws/legacy/sessions/{sid}') as two:
            assert one.receive_json()['type'] == two.receive_json()['type'] == 'session_state'
            for malformed in ('not json', '[]', '{"type":"unknown"}', '{"type":"pose_update","pose":{}}'):
                one.send_text(malformed)
                assert one.receive_json()['type'] == 'error'
            one.send_json(pose_message(0, 0, 0))
            for socket in (one, two):
                assert socket.receive_json()['type'] == 'pose_update'
                assert socket.receive_json()['type'] == 'navigation_instruction'
            response = client.post(f'/legacy/sessions/{sid}/destination', json={'destination_id': 'east_elevator'})
            assert response.status_code == 200 and response.json()['distance_remaining_m'] == 12
            for socket in (one, two):
                assert socket.receive_json()['type'] == 'route_update'
                assert socket.receive_json()['instruction'] == 'continue'
            one.send_json({'type': 'obstacle', 'direction': 'front', 'description': 'chair', 'timestamp': time.time()})
            assert one.receive_json()['type'] == two.receive_json()['type'] == 'obstacle'


def test_assistant_websocket(settings):
    model = ScriptedModel([('get_current_location', {}), 'Your location is unavailable.'])
    with make_client(settings, model) as client:
        sid = client.post('/legacy/sessions', json={}).json()['session_id']
        with client.websocket_connect(f'/ws/sessions/{sid}/assistant') as socket:
            socket.send_json({'type': 'bad'})
            assert socket.receive_json()['type'] == 'error'
            socket.send_json({'type': 'assistant_message', 'text': 'Where am I?'})
            response = socket.receive_json()
            assert response['type'] == 'assistant_response'
            assert response['tool_calls'][0]['name'] == 'get_current_location'
            assert response['actions'] == []


def test_unknown_ws_session(settings):
    with make_client(settings) as client:
        with client.websocket_connect('/ws/legacy/sessions/unknown') as socket:
            assert socket.receive_json()['type'] == 'error'


def test_missing_elastic_returns_unavailable(settings):
    with make_client(settings) as client:
        result = client.post('/knowledge/documents', json={'site_id': 'demo_building', 'id': 'a', 'title': 'a', 'text': 'a'})
        assert result.status_code == 503


def test_upload_validation(settings):
    with make_client(settings) as client:
        response = client.post('/knowledge/upload', data={'site_id': 'demo_building', 'document_id': 'x'},
                               files={'file': ('x.exe', b'bad', 'application/octet-stream')})
        assert response.status_code == 422
        response = client.post('/knowledge/upload', data={'site_id': 'demo_building', 'document_id': 'x'},
                               files={'file': ('x.txt', b'x' * (5 * 1024 * 1024 + 1), 'text/plain')})
        assert response.status_code == 413


def test_lifespan_closes_all_clients_on_smoke_test_exit(settings):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    import pytest

    async def scenario():
        elastic = SimpleNamespace(close=AsyncMock())
        events = FixtureEvents()
        events.close = AsyncMock(side_effect=RuntimeError('failed event shutdown'))
        model = ScriptedModel([])
        model.close = AsyncMock()
        app = create_app(settings, elastic=elastic, events=events, model=model)
        with pytest.raises(RuntimeError, match='failed event shutdown'):
            async with app.router.lifespan_context(app):
                raise SystemExit('smoke test failed')
        elastic.close.assert_awaited_once()
        model.close.assert_awaited_once()

    asyncio.run(scenario())
