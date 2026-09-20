import asyncio
import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from ..app.config import ROOT
from ..app.main import create_app
from ..app.services import voice_bridge
from ..app.services.voice_bridge import (CHECKING, FAILED, GREETING, NOT_HEARD, LiveBridge, TranscriptWindow, audio_event,
                                         catalogue_seed, route_summary, situation, split_for_append)
from ..app.services.worlds import WorldNavigation, WorldStore


class FakeUpstream:
    """A Live primary WebSocket: records client events, delivers queued server events."""

    def __init__(self, live_id='live_1', expires_in=3600, auto_close=True):
        self.sent = []
        self.events = asyncio.Queue()
        self.started = {'type': 'session.started', 'session': {'id': live_id, 'expires_at': time.time() + expires_in}}
        self.auto_close = auto_close

    async def send(self, raw):
        event = json.loads(raw)
        self.sent.append(event)
        if event['type'] == 'session.close' and self.auto_close:
            await self.events.put({'type': 'session.closed', 'reason': 'close_requested', 'usage': {'seconds': 12.5}})

    async def recv(self):
        return json.dumps(self.started)

    def __aiter__(self):
        return self

    async def __anext__(self):
        event = await self.events.get()
        if event is None:
            raise StopAsyncIteration
        return json.dumps(event)

    def of(self, kind):
        return [event for event in self.sent if event['type'] == kind]


class FakePhone:
    def __init__(self):
        self.received = []
        self.inbox = asyncio.Queue()

    async def send_json(self, event):
        self.received.append(event)

    async def receive_text(self):
        message = await self.inbox.get()
        if isinstance(message, Exception):
            raise message
        return json.dumps(message)

    def of(self, kind):
        return [event for event in self.received if event['type'] == kind]


def connecting(*upstreams):
    remaining = list(upstreams)

    @asynccontextmanager
    async def connect():
        yield remaining.pop(0)
    return connect


async def until(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError('Condition not met in time')
        await asyncio.sleep(0.01)


def agent_with(result):
    return SimpleNamespace(query=AsyncMock(return_value=result))


def fast(settings):
    settings.voice_transcript_grace_s = 0.05
    settings.voice_context_interval_s = 0.05
    settings.voice_enabled = True
    settings.voice_access_token = 'demo-token'
    settings.openai_api_key = 'fake-key'
    return settings


ROUTE_RESULT = {'text': 'Starting guidance to Room 101, about 16 metres.', 'sources': [], 'actions': [
    {'type': 'set_destination', 'destination_id': 'room-101', 'accessible_only': False}],
    'tool_calls': [{'name': 'set_destination', 'arguments': '{}', 'result': {'data': {'destination': 'room-101', 'route': {
        'nodes': [{'id': 'entrance'}, {'id': 'room-101', 'name': 'Room 101'}], 'totalMetres': 16.2,
        'instructions': [{'text': 'Continue straight for 5 metres.'}]}}}}]}


def test_audio_validation():
    assert audio_event({'type': 'audio', 'audio': 'AAA='})['type'] == 'session.input_audio.append'
    for message in ({'type': 'session.start'}, {'type': 'audio', 'audio': '!'},
                    {'type': 'audio', 'audio': 'AA=='}, {'type': 'audio', 'audio': ''}):
        with pytest.raises(ValueError):
            audio_event(message)


def test_transcript_window_reconstructs_the_task_from_fragments():
    window = TranscriptWindow()
    window.append('user', {'delta': 'Hello there.', 'start_ms': 0, 'end_ms': 800})
    window.append('assistant', {'delta': 'Hi, how can I help you today?', 'start_ms': 900, 'end_ms': 2500})
    window.append('user', {'delta': 'Guide me ', 'start_ms': 3000, 'end_ms': 3500})
    window.append('assistant', {'delta': 'Sure.', 'start_ms': 3400, 'end_ms': 3600})   # backchannel, not a turn
    assert window.delegate({'offset_ms': 3700, 'delegation': {'id': 'd1', 'target': 'client'}}) == ('d1', 3700)
    assert window.delegate({'offset_ms': 3700, 'delegation': {'id': 'd1', 'target': 'client'}}) is None
    assert window.delegate({'offset_ms': 3700, 'delegation': {'id': 'd2', 'target': 'responses'}}) is None
    # The last fragment lands after the delegation event but belongs to it on the timeline.
    window.append('user', {'delta': 'to bed one.', 'start_ms': 3500, 'end_ms': 4100})
    text, dialogue = window.task(3700)
    assert text == 'Guide me to bed one.'
    assert dialogue == [('user', 'Hello there.'), ('assistant', 'Hi, how can I help you today?')]
    window.consume(3700)
    # Speech after the slack window belongs to the next request; consumed speech is context only.
    window.append('user', {'delta': 'How far is it?', 'start_ms': 9000, 'end_ms': 9800})
    text, dialogue = window.task(9700)
    assert text == 'How far is it?' and ('user', 'to bed one.') in dialogue
    assert window.task(3700)[0] == ''
    assert 'user: How far is it?' in window.dialogue_text()


def test_transcript_window_bounds_memory():
    window = TranscriptWindow(max_chars=30)
    for i in range(10):
        window.append('user', {'delta': 'x' * 10, 'start_ms': i * 100, 'end_ms': i * 100 + 50})
    assert window.chars <= 30 and len(window.fragments) == 3


def test_split_for_append_and_route_summary():
    assert split_for_append('One. Two! Three?', limit=8) == ['One.', 'Two!', 'Three?']
    assert split_for_append('a' * 30, limit=10) == ['a' * 10] * 3
    assert route_summary(ROUTE_RESULT) == 'Guidance started to Room 101: 16 metres in total. First cue: Continue straight for 5 metres.'
    assert route_summary({'tool_calls': [{'name': 'get_current_location', 'result': {'data': {}}}]}) is None
    assert 'once the phone localizes' in route_summary({'tool_calls': [{'name': 'set_destination', 'result': {'data': {'destination': 'x'}}}]})


def test_voice_disabled_by_default(settings):
    from starlette.websockets import WebSocketDisconnect
    with TestClient(create_app(settings), headers={'X-API-Key': settings.wander_api_key}) as client:
        with client.websocket_connect('/ws/sessions/unknown/voice') as ws:
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()


def test_voice_rejects_token_before_provider_connection(settings, monkeypatch):
    from starlette.websockets import WebSocketDisconnect
    fast(settings)

    def forbidden(*args, **kwargs):
        raise AssertionError('Unauthorized client opened a provider connection')
    monkeypatch.setattr(voice_bridge, 'websocket_connect', forbidden)
    with TestClient(create_app(settings), headers={'X-API-Key': settings.wander_api_key}) as client:
        with client.websocket_connect('/ws/sessions/unknown/voice') as ws:
            ws.send_json({'type': 'auth', 'token': 'wrong-token'})
            with pytest.raises(WebSocketDisconnect) as error:
                ws.receive_json()
            assert error.value.code == 1008


def test_one_call_per_session(settings, monkeypatch):
    from starlette.websockets import WebSocketDisconnect
    fast(settings)

    async def hold(self):
        await self.socket.send_json({'type': 'voice_ready'})
        await asyncio.Event().wait()
    monkeypatch.setattr(LiveBridge, 'run', hold)
    with TestClient(create_app(settings), headers={'X-API-Key': settings.wander_api_key}) as client:
        session = client.post('/legacy/sessions', json={}).json()['session_id']
        with client.websocket_connect(f'/ws/sessions/{session}/voice') as first:
            first.send_json({'type': 'auth', 'token': 'demo-token'})
            assert first.receive_json() == {'type': 'voice_ready'}
            with client.websocket_connect(f'/ws/sessions/{session}/voice') as second:
                second.send_json({'type': 'auth', 'token': 'demo-token'})
                with pytest.raises(WebSocketDisconnect) as error:
                    second.receive_json()
                assert error.value.code == 1008
        with client.websocket_connect('/ws/sessions/missing/voice') as ws:
            ws.send_json({'type': 'auth', 'token': 'demo-token'})
            assert ws.receive_json()['message'] == 'Session not found'


@pytest.mark.asyncio
async def test_bridge_greets_delegates_with_late_transcript_and_speaks_cues(settings):
    fast(settings)
    upstream, phone = FakeUpstream(), FakePhone()
    agent = agent_with(ROUTE_RESULT)
    bridge = LiveBridge(phone, agent, 'session', settings, connect=connecting(upstream))
    run = asyncio.create_task(bridge.run())

    await until(lambda: upstream.of('session.instructions.append'))
    start = upstream.of('session.start')[0]['session']
    assert start['model'] == settings.openai_live_model and start['delegation'] == {'type': 'client'}
    assert start['audio'] == {'format': {'type': 'audio/pcm', 'rate': 24000}, 'output': {'voice': 'marin'}}
    assert 'Delegation policy' in start['instructions'] and 'input' not in start
    assert upstream.of('session.instructions.append')[0] == {'type': 'session.instructions.append', 'delegation_id': None,
                                                              'content': GREETING, 'event_id': 'greeting'}
    ready = phone.of('voice_ready')[0]
    assert ready['rate'] == 24000 and ready['ai_generated_voice'] and ready['liveSessionId'] == 'live_1'

    # Phone audio is relayed; malformed frames are rejected only by their own validation.
    await phone.inbox.put({'type': 'audio', 'audio': 'AAA='})
    await until(lambda: upstream.of('session.input_audio.append'))
    assert upstream.of('session.input_audio.append')[0]['audio'] == 'AAA='

    # The delegation event arrives before the final transcript fragment of the utterance.
    await upstream.events.put({'type': 'session.input_transcript.delta', 'delta': 'Guide me to room', 'start_ms': 1000, 'end_ms': 1800})
    await upstream.events.put({'type': 'session.delegation.created', 'offset_ms': 2000, 'delegation': {'id': 'del_1', 'target': 'client'}})
    await until(lambda: len(phone.of('transcript')) == 1)
    await upstream.events.put({'type': 'session.input_transcript.delta', 'delta': ' one oh one.', 'start_ms': 1800, 'end_ms': 2150})
    await until(lambda: upstream.of('session.commentary.append'))
    agent.query.assert_awaited_once_with('session', 'Guide me to room one oh one.', dialogue=None)
    thinking = upstream.of('session.thinking.append')
    assert thinking[0] == {'type': 'session.thinking.append', 'delegation_id': 'del_1', 'content': CHECKING}
    assert upstream.of('session.commentary.append')[0] == {'type': 'session.commentary.append', 'delegation_id': 'del_1',
                                                            'content': ROUTE_RESULT['text']}
    await until(lambda: len(upstream.of('session.thinking.append')) >= 2)
    assert upstream.of('session.thinking.append')[1]['content'].startswith('Guidance started to Room 101')
    assert phone.of('assistant_response')[0]['actions'] == ROUTE_RESULT['actions']
    assert phone.of('transcript')[0] == {'type': 'transcript', 'speaker': 'user', 'delta': 'Guide me to room',
                                         'start_ms': 1000, 'end_ms': 1800}

    # Navigation events from WorldNavigation: ordinary cues are commentary, arrival is verbatim, duplicates collapse.
    await bridge.subscriber.send_json({'type': 'progress', 'sessionId': 'session', 'progress': {
        'state': 'navigating', 'speak': 'Turn right, then continue 5 metres.', 'remainingMetres': 5}})
    await until(lambda: len(upstream.of('session.commentary.append')) == 2)
    assert upstream.of('session.commentary.append')[1] == {'type': 'session.commentary.append', 'delegation_id': None,
                                                            'content': 'Turn right, then continue 5 metres.'}
    arrived = {'state': 'arrived', 'speak': 'You have arrived at Room 101.', 'remainingMetres': 0}
    await bridge.subscriber.send_json({'type': 'progress', 'sessionId': 'session', 'progress': arrived})
    await bridge.subscriber.send_json({'type': 'arrived', 'sessionId': 'session', 'progress': arrived})
    await until(lambda: len(phone.of('navigation')) >= 3)
    exact = [e for e in upstream.of('session.instructions.append') if e.get('event_id') != 'greeting']
    assert exact == [{'type': 'session.instructions.append', 'delegation_id': None,
                      'content': 'Say exactly, now: "You have arrived at Room 101."'}]

    # A rejected command is reported, not fatal; the phone hears about it as a warning.
    await upstream.events.put({'type': 'error', 'error': {'type': 'invalid_request_error', 'code': 'unknown_parameter',
                                                          'message': 'private', 'client_event_id': 'situation'}})
    await until(lambda: phone.of('warning'))
    assert phone.of('warning')[0]['code'] == 'unknown_parameter'
    await upstream.events.put({'type': 'session.usage.updated', 'usage': {'seconds': 30}})
    await until(lambda: phone.of('usage'))

    # Typed text uses the same path without a delegation ID.
    agent.query.reset_mock()
    await phone.inbox.put({'type': 'text', 'text': 'How far is it?'})
    await until(lambda: len(upstream.of('session.commentary.append')) == 3)
    assert upstream.of('session.commentary.append')[2]['delegation_id'] is None
    assert agent.query.await_args.args == ('session', 'How far is it?')
    assert 'user: Guide me to room one oh one.' in agent.query.await_args.kwargs['dialogue']

    await phone.inbox.put({'type': 'mute'})
    await until(lambda: upstream.of('session.input_audio.mute'))
    await phone.inbox.put({'type': 'close'})
    await asyncio.wait_for(run, 3)
    assert upstream.of('session.close') and phone.of('closed')[0] == {'type': 'closed', 'reason': 'close_requested',
                                                                      'seconds': 12.5, 'renewing': False}


@pytest.mark.asyncio
async def test_bridge_asks_to_repeat_without_transcript_and_reports_busy(settings):
    fast(settings)
    upstream, phone = FakeUpstream(), FakePhone()
    slow = asyncio.Event()
    calls = []

    async def query(*args, **kwargs):
        calls.append(args)
        if len(calls) == 1:
            raise RuntimeError('provider down')   # one failed request must not end the call
        await slow.wait()
        return {'text': 'Done.', 'sources': [], 'actions': [], 'tool_calls': []}
    bridge = LiveBridge(phone, SimpleNamespace(query=query), 'session', settings, connect=connecting(upstream))
    run = asyncio.create_task(bridge.run())
    await until(lambda: phone.of('voice_ready'))
    await upstream.events.put({'type': 'session.delegation.created', 'offset_ms': 500, 'delegation': {'id': 'silent', 'target': 'client'}})
    await until(lambda: upstream.of('session.commentary.append'))
    assert upstream.of('session.commentary.append')[0] == {'type': 'session.commentary.append', 'delegation_id': 'silent',
                                                            'content': NOT_HEARD}
    for i in range(10):
        await upstream.events.put({'type': 'session.input_transcript.delta', 'delta': f'Request {i}.', 'start_ms': 1000 + i, 'end_ms': 1001 + i})
        await upstream.events.put({'type': 'session.delegation.created', 'offset_ms': 1001 + i, 'delegation': {'id': f'd{i}', 'target': 'client'}})
    await until(lambda: any(e['content'].startswith('The assistant is still working') for e in upstream.of('session.commentary.append')))
    await until(lambda: any(e['content'] == FAILED for e in upstream.of('session.commentary.append')))
    # The burst above was one utterance on the timeline, so it was consumed by d0; a later request works.
    slow.set()
    await upstream.events.put({'type': 'session.input_transcript.delta', 'delta': 'Where am I?', 'start_ms': 9000, 'end_ms': 9500})
    await upstream.events.put({'type': 'session.delegation.created', 'offset_ms': 9600, 'delegation': {'id': 'later', 'target': 'client'}})
    await until(lambda: any(e['content'] == 'Done.' for e in upstream.of('session.commentary.append')))
    assert calls[-1][1] == 'Where am I?'
    await phone.inbox.put({'type': 'close'})
    await asyncio.wait_for(run, 3)


@pytest.mark.asyncio
async def test_bridge_renews_an_expired_live_session_and_flushes_buffered_audio(settings):
    fast(settings)
    first, second, phone = FakeUpstream('live_1'), FakeUpstream('live_2'), FakePhone()
    agent = agent_with({'text': 'You are near the lobby.', 'sources': [], 'actions': [], 'tool_calls': []})
    gate = asyncio.Event()
    upstreams = [first, second]

    @asynccontextmanager
    async def connect():
        upstream = upstreams.pop(0)
        if upstream is second:
            await gate.wait()
        yield upstream
    bridge = LiveBridge(phone, agent, 'session', settings, connect=connect)
    run = asyncio.create_task(bridge.run())
    await until(lambda: phone.of('voice_ready'))
    await first.events.put({'type': 'session.input_transcript.delta', 'delta': 'Where am I?', 'start_ms': 100, 'end_ms': 900})
    await first.events.put({'type': 'session.delegation.created', 'offset_ms': 1000, 'delegation': {'id': 'd1', 'target': 'client'}})
    await until(lambda: first.of('session.commentary.append'))
    await first.events.put({'type': 'session.output_transcript.delta', 'delta': 'You are near the lobby.', 'start_ms': 2000, 'end_ms': 3000})
    await first.events.put({'type': 'session.closed', 'reason': 'expired', 'usage': {'seconds': 100}})
    await until(lambda: phone.of('closed'))
    assert phone.of('closed')[0]['renewing'] is True
    # Audio spoken while the replacement session starts is kept and delivered after session.started.
    await phone.inbox.put({'type': 'audio', 'audio': 'AAA='})
    await until(lambda: bridge.buffer)
    gate.set()
    await until(lambda: phone.of('renewed'))
    start = second.of('session.start')[0]['session']
    seeded = ' '.join(part['text'] for item in start['input'] for part in item['content'])
    assert 'user: Where am I?' in seeded and 'assistant: You are near the lobby.' in seeded
    assert second.of('session.input_audio.append')[0]['audio'] == 'AAA='
    assert second.of('session.instructions.append')[0]['event_id'] == 'renewed'
    assert len(phone.of('voice_ready')) == 1
    await phone.inbox.put({'type': 'close'})
    await asyncio.wait_for(run, 3)
    assert second.of('session.close')


@pytest.mark.asyncio
async def test_bridge_finalizes_live_when_the_phone_disconnects(settings):
    from starlette.websockets import WebSocketDisconnect
    fast(settings)
    upstream, phone = FakeUpstream(), FakePhone()
    bridge = LiveBridge(phone, agent_with({}), 'session', settings, connect=connecting(upstream))
    run = asyncio.create_task(bridge.run())
    await until(lambda: phone.of('voice_ready'))
    await phone.inbox.put(WebSocketDisconnect(1001))
    with pytest.raises(WebSocketDisconnect):
        await asyncio.wait_for(run, 3)
    assert upstream.of('session.close') and bridge.usage_seconds == 12.5


@pytest.fixture
def world_store(settings):
    store = WorldStore(settings.wander_data_root)
    world = json.loads((ROOT / 'shared/contracts/examples/demo-building.world.json').read_text(encoding='utf-8'))
    path = settings.wander_data_root / 'worlds' / world['id'] / 'world.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(world), encoding='utf-8')
    (path.parent / 'notes.json').write_text(json.dumps({'schema': 'wander.notes/v1', 'worldId': 'demo-building', 'notes': [
        {'id': 'n1', 'title': 'Bed 1', 'position': [2, 0, 0], 'createdAt': '2026-09-19T12:00:00Z'},
        {'id': 'n2', 'title': 'Water fountain', 'position': [0, 0, -3], 'createdAt': '2026-09-19T12:00:00Z'},
        {'id': 'n3', 'title': 'Far away', 'position': [50, 0, 0], 'createdAt': '2026-09-19T12:00:00Z'}]}), encoding='utf-8')
    return store


@pytest.mark.asyncio
async def test_situation_and_catalogue_follow_the_persisted_session(world_store):
    navigation = WorldNavigation(world_store)
    session = await navigation.create('demo-building', 'phone')
    sid = session['sessionId']
    seed = catalogue_seed(world_store, sid)
    assert 'Front entrance, Lobby desk, Elevator bank, Room 101' in seed and 'Bed 1, Water fountain' in seed
    assert situation(world_store, sid) == 'Position unknown: no current localization fix. No destination set.'
    from datetime import datetime, timezone
    stamp = datetime.now(timezone.utc).isoformat()
    # Identity rotation faces -Z: the fountain (0,0,-3) is ahead, Bed 1 (2,0,0) is to the right.
    await navigation.pose(sid, {'timestamp': stamp, 'pose': {'position': [0, 0, 0], 'rotation': [0, 0, 0, 1]},
                               'trackingState': 'localized'}, allow_no_destination=True)
    text = situation(world_store, sid)
    assert text.startswith('Position: 0 m from Front entrance. Notes nearby: Bed 1 2 m on your right; Water fountain 3 m ahead.')
    assert 'Far away' not in text and text.endswith('No destination set.')
    await navigation.destination(sid, 'room-101')
    text = situation(world_store, sid)
    # Right after set_destination there is a route but no progress yet: total distance and first cue.
    assert 'Guidance to Room 101: navigating, 15 m in total. Current cue: Right, then continue 5 metres.' in text
    await navigation.pose(sid, {'timestamp': datetime.now(timezone.utc).isoformat(),
                                'pose': {'position': [1, 0, 0], 'rotation': [0, 0, 0, 1]}, 'trackingState': 'localized'})
    text = situation(world_store, sid)
    assert 'Guidance to Room 101: navigating, 14 m remaining. Current cue:' in text
    assert situation(world_store, 'missing') is None and catalogue_seed(world_store, 'missing') is None


@pytest.mark.asyncio
async def test_bridge_subscribes_to_world_session_events_and_pushes_situation(settings, world_store):
    fast(settings)
    navigation = WorldNavigation(world_store)
    sid = (await navigation.create('demo-building', 'phone', destination='room-101'))['sessionId']
    upstream, phone = FakeUpstream(), FakePhone()
    bridge = LiveBridge(phone, agent_with({}), sid, settings, worlds=world_store, connect=connecting(upstream))
    run = asyncio.create_task(bridge.run())
    await until(lambda: phone.of('voice_ready'))
    assert bridge.subscriber in world_store.sockets[sid]
    seed = upstream.of('session.start')[0]['session']['input'][0]['content'][0]['text']
    assert seed.startswith('Building: Demo building') and 'Bed 1' in seed
    from datetime import datetime, timezone
    await navigation.pose(sid, {'timestamp': datetime.now(timezone.utc).isoformat(),
                                'pose': {'position': [0, 0, 0], 'rotation': [0, 0, 0, 1]}, 'trackingState': 'localized'})
    await until(lambda: upstream.of('session.commentary.append'))
    # The exact phrase WorldNavigation returned to the phone as `speak` is what Live is asked to say.
    assert upstream.of('session.commentary.append')[0] == {'type': 'session.commentary.append', 'delegation_id': None,
                                                            'content': 'Right, then continue 5 metres.'}
    await until(lambda: any(e.get('event_id') == 'situation' for e in upstream.of('session.thinking.append')))
    situations = [e for e in upstream.of('session.thinking.append') if e.get('event_id') == 'situation']
    assert 'Guidance to Room 101: navigating' in situations[-1]['content']
    await asyncio.sleep(0.2)
    # Unchanged situation is not re-sent.
    assert len({e['content'] for e in upstream.of('session.thinking.append') if e.get('event_id') == 'situation'}) == \
        len([e for e in upstream.of('session.thinking.append') if e.get('event_id') == 'situation'])
    assert phone.of('navigation')
    await phone.inbox.put({'type': 'close'})
    await asyncio.wait_for(run, 3)
    assert bridge.subscriber not in world_store.sockets[sid]
