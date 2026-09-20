"""GPT-Live bridge: the phone streams PCM over our WebSocket, this process holds the primary
Live WebSocket (the API key never leaves the server), and the existing grounded agent handles
delegated work.

Everything the voice says about the map comes from the backend: delegated answers return as
`session.commentary.append`, navigation cues from WorldNavigation are forwarded as they are
emitted, and a short silent situation summary keeps the model from guessing. Client-owned
delegation means we must reconstruct the request from transcript fragments ourselves; see
TranscriptWindow. Protocol reference: developers.openai.com/api/reference/resources/live.
"""
import asyncio
import base64
import binascii
import json
import logging
import re
import time
from collections import deque
from contextlib import suppress
from pathlib import Path

from fastapi import HTTPException
from websockets.asyncio.client import connect as websocket_connect

from ..routing.heading import bearing, horizontal, relative, yaw
from .worlds import targets, world_graph, world_notes

logger = logging.getLogger(__name__)
LIVE_URL = 'wss://api.openai.com/v1/live/sessions'
LIVE_PROMPT = (Path(__file__).resolve().parents[1] / 'integrations/openai/prompts/live_frontend.txt').read_text(encoding='utf-8')
GREETING = ('Greet the user now in English in one short sentence: say the Wander voice guide is ready, that '
            'this voice is AI generated, and that they can ask where they are, what is nearby, or say '
            '"guide me to" a place. Then pause and listen.')
RENEWED = 'The voice connection was renewed. Continue the conversation naturally without greeting again.'
BUSY = 'The assistant is still working on the previous request. Ask the user to wait a moment.'
NOT_HEARD = 'The request was not received. Ask the user to repeat it.'
FAILED = 'The backend could not complete that request. Say so briefly; no guidance was changed.'
CHECKING = 'Checking the map now. Nothing has been changed yet.'
# Cues whose wording and timing matter are requested verbatim; ordinary turn cues may be paraphrased.
SAY_EXACTLY = ('arrived', 'off-route', 'lost')
RENEWABLE = ('expired', 'connection_lost')
# Appends are capped at 500 tokens; English sentences stay well below that at this many characters.
APPEND_CHARS = 1200
NOTES_WITHIN_M = 10
# Renew the Live session this long before its server-side expiry, at most this many times per call.
RENEW_MARGIN_S = 60
MAX_RENEWALS = 8


def audio_event(message):
    if not isinstance(message, dict) or set(message) != {'type', 'audio'} or message['type'] != 'audio':
        raise ValueError('Expected {type: audio, audio: base64 PCM16LE}')
    if not isinstance(message['audio'], str) or len(message['audio']) > 65536:
        raise ValueError('Audio chunk exceeds 64 KiB encoded')
    try:
        data = base64.b64decode(message['audio'], validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError('Invalid audio base64') from error
    if not data or len(data) % 2:
        raise ValueError('Expected nonempty 16-bit PCM samples')
    return {'type': 'session.input_audio.append', 'audio': message['audio']}


def split_for_append(text, limit=APPEND_CHARS):
    """Sentence-boundary chunks that each fit one append event."""
    parts, current = [], ''
    for sentence in re.split(r'(?<=[.!?])\s+', text.strip()):
        if current and len(current) + len(sentence) + 1 > limit:
            parts.append(current)
            current = sentence
        else:
            current = (current + ' ' + sentence).strip()
    if current:
        parts.append(current)
    return [part[i:i + limit] for part in parts for i in range(0, len(part), limit)] or []


def side_word(angle):
    magnitude = abs(angle)
    if magnitude <= 25:
        return 'ahead'
    if magnitude >= 155:
        return 'behind you'
    return 'on your right' if angle > 0 else 'on your left'


class TranscriptWindow:
    """Both speakers' fragments on the Live timeline. Fragments are not turns and the delegation event
    carries no task text, so a delegation's task is the user's speech after the last substantial
    assistant utterance, up to (slightly past) the delegation offset. Everything earlier is dialogue
    context for the agent; it is never re-run as a task."""

    def __init__(self, history=8, max_chars=8000, slack_ms=300, boundary_words=4):
        self.fragments = deque()
        self.chars = 0
        self.cursor = -1
        self.seen = set()
        self.history, self.max_chars, self.slack, self.boundary_words = history, max_chars, slack_ms, boundary_words

    @property
    def end_ms(self):
        return max((f['end'] for f in self.fragments), default=0)

    def append(self, speaker, event):
        self.add(speaker, event['delta'], event['start_ms'], event['end_ms'])

    def add(self, speaker, text, start_ms, end_ms):
        self.fragments.append({'speaker': speaker, 'start': start_ms, 'end': end_ms, 'text': text})
        self.chars += len(text)
        while self.chars > self.max_chars and len(self.fragments) > 1:
            self.chars -= len(self.fragments.popleft()['text'])

    def delegate(self, event):
        """Register a client delegation once; returns (id, offset_ms) or None for duplicates/others."""
        delegation = event['delegation']
        if delegation.get('target') != 'client' or delegation['id'] in self.seen:
            return None
        if len(self.seen) >= 200:
            raise ValueError('Call delegation limit reached; reconnect')
        self.seen.add(delegation['id'])
        return delegation['id'], event['offset_ms']

    def turns(self, limit_ms):
        """Fragments up to limit_ms merged into [speaker, text, start, consumed] turns. Consumed and
        unconsumed speech never merge, so an earlier task cannot leak into the next one."""
        groups = []
        for f in self.fragments:
            if f['start'] > limit_ms:
                continue
            consumed = f['start'] <= self.cursor
            if groups and groups[-1][0] == f['speaker'] and groups[-1][3] == consumed:
                groups[-1][1] += f['text']
            else:
                groups.append([f['speaker'], f['text'], f['start'], consumed])
        return groups

    def task(self, offset_ms):
        """(task text, dialogue lines) for a delegation created at offset_ms."""
        groups = self.turns(offset_ms + self.slack)
        first = 0
        for i, (speaker, text, _, consumed) in enumerate(groups):
            if consumed or (speaker == 'assistant' and len(text.split()) >= self.boundary_words):
                first = i + 1
        task = ' '.join(text.strip() for speaker, text, _, _ in groups[first:] if speaker == 'user').strip()
        dialogue = [(speaker, text.strip()) for speaker, text, _, _ in groups[max(0, first - self.history):first]
                    if text.strip()]
        return task, dialogue

    def consume(self, offset_ms):
        self.cursor = max(self.cursor, offset_ms + self.slack)

    def dialogue_text(self, limit_ms=None, turns=None):
        groups = self.turns(limit_ms if limit_ms is not None else self.end_ms + self.slack)
        return '\n'.join(f'{speaker}: {text.strip()}' for speaker, text, _, _ in groups[-(turns or self.history):]
                         if text.strip())


class SessionEventSubscriber:
    """Sits in WorldStore.sockets[session_id] beside the dashboard sockets. emit() awaits send_json
    with a two-second timeout, so events are queued here and forwarded to Live by the bridge."""

    def __init__(self, maxsize=64):
        self.queue = asyncio.Queue(maxsize=maxsize)

    async def send_json(self, event):
        if self.queue.full():
            self.queue.get_nowait()
        self.queue.put_nowait(event)


def route_summary(result):
    """Silent context after a successful set_destination: what guidance is running now."""
    for call in result.get('tool_calls', []):
        data = call.get('result', {}).get('data')
        if call.get('name') != 'set_destination' or not isinstance(data, dict):
            continue
        route = data.get('route')
        if not route:
            return 'Guidance is set; the route starts once the phone localizes.'
        name = route['nodes'][-1].get('name') or data.get('destination')
        first = route['instructions'][0]['text'] if route.get('instructions') else ''
        return f"Guidance started to {name}: {route['totalMetres']:.0f} metres in total. First cue: {first}".strip()
    return None


def catalogue_seed(worlds, session_id, limit=60):
    """Startup history for the Live model: the names it may hear as destinations. Names only; the
    backend resolves them to IDs and routes."""
    try:
        data = worlds.session(session_id)
        world = worlds.world(data['worldId'])
    except HTTPException:
        return None
    places = [n['name'] for n in world_graph(world)['nodes'] if n.get('name')][:limit]
    notes = [n['title'] for n in world_notes(worlds, world['id']) if n.get('title')][:limit]
    text = f"Building: {world['name']}."
    if places:
        text += ' Mapped places the backend can guide to: ' + ', '.join(places) + '.'
    if notes:
        text += ' Notes pinned on the map, also valid destinations: ' + ', '.join(notes) + '.'
    if not places and not notes:
        text += ' No destinations are mapped yet.'
    return text


def situation(worlds, session_id):
    """One short paragraph of current facts for session.thinking.append, or None for legacy sessions."""
    try:
        data = worlds.session(session_id)
        world = worlds.world(data['worldId'])
    except HTTPException:
        return None
    nodes = {n['id']: n for n in world_graph(world)['nodes']}
    parts = []
    pose = data.get('lastPose')
    if pose is None or data['state'] in ('lost', 'ended'):
        parts.append('Position unknown: no current localization fix.')
    else:
        position, facing = pose['position'], yaw(pose['rotation'])
        if nodes:
            nearest = min(nodes.values(), key=lambda n: horizontal(position, n['position']))
            parts.append(f"Position: {horizontal(position, nearest['position']):.0f} m from {nearest.get('name') or nearest['id']}.")
        near = []
        for note in world_notes(worlds, world['id']):
            metres = horizontal(position, note['position'])
            if metres > NOTES_WITHIN_M:
                continue
            where = side_word(relative(bearing(position, note['position']), facing)) if facing is not None and metres > 0.3 else 'here'
            near.append((metres, f"{note['title']} {metres:.0f} m {where}"))
        if near:
            parts.append('Notes nearby: ' + '; '.join(text for _, text in sorted(near)[:4]) + '.')
    destination = data.get('destination')
    if destination:
        name = targets(worlds, world).get(destination, {}).get('name') or destination
        progress, route = data.get('lastProgress') or {}, data.get('route') or {}
        line = f'Guidance to {name}: {progress.get("state", data["state"])}'
        if progress.get('remainingMetres') is not None and progress.get('state') not in ('lost', 'localizing'):
            line += f", {progress['remainingMetres']:.0f} m remaining"
        elif route.get('totalMetres') is not None:
            # A destination was just set: the route exists but no pose has produced progress yet.
            line += f", {route['totalMetres']:.0f} m in total"
        cue = (progress.get('instruction') or {}).get('text') or \
            (route['instructions'][0]['text'] if route.get('instructions') and not progress else None)
        if cue:
            line += f'. Current cue: {cue}'
        parts.append(line.rstrip('.') + '.')
    else:
        parts.append('No destination set.')
    return ' '.join(parts)


class LiveBridge:
    """One phone call: audio relay, delegation to the agent, and backend-driven steering."""

    def __init__(self, socket, agent, session_id, settings, worlds=None, connect=None):
        self.socket, self.agent, self.session_id, self.settings, self.worlds = socket, agent, session_id, settings, worlds
        self.connect = connect or self.default_connect
        self.window = TranscriptWindow()
        self.subscriber = SessionEventSubscriber()
        self.upstream = None
        self.live_id = None
        self.generation = 0
        self.closing = False
        self.renew_requested = False
        self.pending = asyncio.Queue(maxsize=8)
        self.send_lock = asyncio.Lock()
        # Microphone audio captured while a replacement session starts; ~3 s of 100 ms chunks.
        self.buffer = deque(maxlen=30)
        self.usage_seconds = 0
        self.last_cue = ('', 0.0)
        self.last_situation = None
        self.last_progress_sent = 0.0
        self.grace = settings.voice_transcript_grace_s

    def default_connect(self):
        return websocket_connect(LIVE_URL, additional_headers={'Authorization': 'Bearer ' + self.settings.openai_api_key},
                                 max_size=2**20, open_timeout=20)

    # ------------------------------------------------------------------ transport helpers

    async def to_phone(self, event):
        async with self.send_lock:
            await self.socket.send_json(event)

    async def to_live(self, event):
        upstream = self.upstream
        if upstream is None:
            logger.info('Voice: dropped %s while no Live session was attached', event.get('type'))
            return False
        try:
            await upstream.send(json.dumps(event))
        except Exception as error:  # noqa: BLE001 - the session loop notices the broken socket and renews
            logger.warning('Voice: could not send %s to Live (%s)', event.get('type'), type(error).__name__)
            return False
        return True

    async def append(self, kind, content, delegation_id=None, event_id=None):
        event = {'type': f'session.{kind}.append', 'delegation_id': delegation_id, 'content': content}
        if event_id:
            event['event_id'] = event_id
        return await self.to_live(event)

    def session_config(self):
        config = {'model': self.settings.openai_live_model, 'instructions': LIVE_PROMPT,
                  'audio': {'format': {'type': 'audio/pcm', 'rate': 24000}, 'output': {'voice': self.settings.voice_name}},
                  'delegation': {'type': 'client'}}
        seed = []
        if self.worlds is not None:
            text = catalogue_seed(self.worlds, self.session_id)
            if text:
                seed.append({'type': 'message', 'role': 'developer', 'content': [{'type': 'input_text', 'text': text}]})
        if self.generation:
            history = self.window.dialogue_text(turns=12)
            if history:
                seed.append({'type': 'message', 'role': 'developer', 'content': [{'type': 'input_text', 'text':
                             'Transcript of the conversation so far in this call:\n' + history}]})
            current = situation(self.worlds, self.session_id) if self.worlds is not None else None
            if current:
                seed.append({'type': 'message', 'role': 'developer', 'content': [{'type': 'input_text', 'text': current}]})
        if seed:
            config['input'] = seed
        return config

    def register(self):
        """Subscribe to this session's navigation events; None for legacy in-memory sessions."""
        try:
            if self.worlds is None or not self.worlds.path('sessions', self.session_id + '.json').is_file():
                return None
        except HTTPException:
            return None
        clients = self.worlds.sockets.setdefault(self.session_id, set())
        clients.add(self.subscriber)
        return clients

    # ------------------------------------------------------------------ call lifecycle

    async def run(self):
        registry = self.register()
        phone = asyncio.create_task(self.phone_in())
        helpers = [asyncio.create_task(self.delegate_loop()), asyncio.create_task(self.events_loop()),
                   asyncio.create_task(self.context_loop())]
        try:
            async with asyncio.timeout(self.settings.voice_max_minutes * 60):
                while True:
                    async with self.connect() as upstream:
                        live = asyncio.create_task(self.live_session(upstream))
                        done, _ = await asyncio.wait({live, phone, *helpers}, return_when=asyncio.FIRST_COMPLETED)
                        if live not in done:
                            # The phone asked to end, hung up, or a helper failed: finalize the Live
                            # session so its usage is confirmed, then surface whatever ended the call.
                            self.closing = True
                            with suppress(Exception):
                                await upstream.send(json.dumps({'type': 'session.close', 'event_id': 'close'}))
                            with suppress(Exception):
                                await asyncio.wait_for(live, 10)
                            for task in done:
                                task.result()
                            return
                        reason = live.result()
                    if reason in RENEWABLE and not self.closing and not phone.done() and self.generation < MAX_RENEWALS:
                        self.generation += 1
                        logger.info('Voice session %s ended (%s); renewing as generation %d', self.session_id, reason, self.generation)
                        continue
                    if reason in RENEWABLE and not self.closing:
                        raise ValueError('Live session kept dropping; giving up on renewal')
                    return
        finally:
            self.upstream = None
            for task in (phone, *helpers):
                task.cancel()
            await asyncio.gather(phone, *helpers, return_exceptions=True)
            if registry is not None:
                registry.discard(self.subscriber)

    async def live_session(self, upstream):
        """Drive one Live session to its close; returns the close reason."""
        self.renew_requested = False
        await upstream.send(json.dumps({'type': 'session.start', 'event_id': 'start', 'session': self.session_config()}))
        started = json.loads(await asyncio.wait_for(upstream.recv(), timeout=20))
        if started.get('type') != 'session.started':
            raise ValueError('Live provider did not start the session')
        info = started.get('session') or {}
        self.live_id = info.get('id')
        self.upstream = upstream
        while self.buffer:
            await upstream.send(json.dumps(self.buffer.popleft()))
        if self.generation == 0:
            await self.to_phone({'type': 'voice_ready', 'format': 'pcm16le', 'rate': 24000, 'channels': 1,
                                 'ai_generated_voice': True, 'voice': self.settings.voice_name, 'liveSessionId': self.live_id})
            await self.append('instructions', GREETING, event_id='greeting')
        else:
            await self.to_phone({'type': 'renewed', 'liveSessionId': self.live_id})
            await self.append('instructions', RENEWED, event_id='renewed')
        timer = asyncio.create_task(self.renewal_timer(info['expires_at'])) if info.get('expires_at') else None
        try:
            async for raw in upstream:
                reason = await self.handle_live_event(json.loads(raw))
                if reason is not None:
                    return reason
            return 'connection_lost'
        finally:
            self.upstream = None
            if timer is not None:
                timer.cancel()
                await asyncio.gather(timer, return_exceptions=True)

    async def renewal_timer(self, expires_at):
        await asyncio.sleep(max(1, expires_at - time.time() - RENEW_MARGIN_S))
        if self.closing:
            return
        self.renew_requested = True
        logger.info('Voice session %s approaching Live expiry; closing for renewal', self.session_id)
        await self.to_live({'type': 'session.close', 'event_id': 'renew'})

    async def handle_live_event(self, event):
        kind = event.get('type')
        if getattr(self.settings, 'voice_trace', False) and kind != 'session.output_audio.delta':
            # Phase-0 protocol check: where transcript fragments fall relative to delegation offsets.
            fields = {k: event[k] for k in ('start_ms', 'end_ms', 'offset_ms', 'reason', 'client_event_id') if k in event}
            if 'transcript' in (kind or ''):
                fields['delta'] = event.get('delta')
            if kind == 'session.delegation.created':
                fields['delegation'] = event.get('delegation', {}).get('id')
            logger.info('Live <- %s %s', kind, json.dumps(fields, ensure_ascii=False))
        if kind in ('session.input_transcript.delta', 'session.output_transcript.delta'):
            speaker = 'user' if 'input_' in kind else 'assistant'
            self.window.append(speaker, event)
            await self.to_phone({'type': 'transcript', 'speaker': speaker, 'delta': event['delta'],
                                 'start_ms': event['start_ms'], 'end_ms': event['end_ms']})
        elif kind == 'session.delegation.created':
            work = self.window.delegate(event)
            if work is not None:
                try:
                    self.pending.put_nowait((*work, time.monotonic()))
                except asyncio.QueueFull:
                    await self.append('commentary', BUSY, delegation_id=work[0])
        elif kind == 'session.output_audio.delta':
            await self.to_phone({'type': 'audio', 'audio': event['delta']})
        elif kind == 'session.usage.updated':
            self.usage_seconds = (event.get('usage') or {}).get('seconds', self.usage_seconds)
            await self.to_phone({'type': 'usage', 'seconds': self.usage_seconds})
        elif kind == 'session.closed':
            self.usage_seconds = (event.get('usage') or {}).get('seconds', self.usage_seconds)
            reason = event.get('reason') or 'unknown'
            if self.renew_requested and reason == 'close_requested':
                reason = 'expired'
            renewing = reason in RENEWABLE and not self.closing
            logger.info('Voice session %s Live closed: reason=%s seconds=%s', self.session_id, reason, self.usage_seconds)
            await self.to_phone({'type': 'closed', 'reason': reason, 'seconds': self.usage_seconds, 'renewing': renewing})
            return reason
        elif kind == 'error':
            # Rejected commands and moderation cut-offs arrive here and do not end the session; only
            # session.closed does. Log identifiers, never the provider's free-text message.
            error = event.get('error') or {}
            logger.warning('Live error code=%s type=%s param=%s client_event_id=%s', error.get('code'),
                           error.get('type'), error.get('param'), error.get('client_event_id'))
            await self.to_phone({'type': 'warning', 'code': error.get('code') or error.get('type') or 'live_error'})
        else:
            logger.debug('Live event %s', kind)
        return None

    # ------------------------------------------------------------------ phone -> backend

    async def phone_in(self):
        """Ends normally when the phone asks to close; raises on disconnect."""
        while True:
            raw = await self.socket.receive_text()
            if len(raw) > 66000:
                raise ValueError('Audio message too large')
            message = json.loads(raw)
            kind = message.get('type') if isinstance(message, dict) else None
            if kind == 'audio':
                event = audio_event(message)
                if self.upstream is None:
                    self.buffer.append(event)
                else:
                    await self.to_live(event)
            elif kind == 'text':
                text = message.get('text')
                if set(message) != {'type', 'text'} or not isinstance(text, str) or not 0 < len(text) <= 2000:
                    raise ValueError('Expected {type: text, text}')
                # Typed input joins the transcript at the current timeline position and is handled
                # like a delegation without an ID (its result is session-wide commentary).
                at = max(self.window.end_ms, self.window.cursor) + 1
                self.window.add('user', text, at, at)
                try:
                    self.pending.put_nowait((None, at, time.monotonic()))
                except asyncio.QueueFull:
                    raise ValueError('Too many pending requests') from None
            elif kind in ('mute', 'unmute'):
                await self.to_live({'type': f'session.input_audio.{kind}', 'event_id': kind})
            elif message == {'type': 'close'}:
                self.closing = True
                return
            else:
                raise ValueError('Only auth, audio, text, mute, unmute and close messages are accepted')

    # ------------------------------------------------------------------ delegation

    async def delegate_loop(self):
        while True:
            identity, offset, received = await self.pending.get()
            if identity is not None:
                # Transcript fragments for the utterance can land after the delegation event.
                await asyncio.sleep(self.grace)
            text, dialogue = self.window.task(offset)
            if not text and identity is not None:
                await asyncio.sleep(self.grace)
                text, dialogue = self.window.task(offset)
            if not text:
                logger.info('Voice delegation %s had no transcript', identity)
                if identity is not None:
                    await self.append('commentary', NOT_HEARD, delegation_id=identity)
                continue
            self.window.consume(offset)
            await self.append('thinking', CHECKING, delegation_id=identity)
            started = time.monotonic()
            context = '\n'.join(f'{speaker}: {value}' for speaker, value in dialogue) or None
            try:
                result = await self.agent.query(self.session_id, text, dialogue=context)
            except Exception as error:  # noqa: BLE001 - one failed request must not end the call
                logger.warning('Voice delegation %s failed (%s)', identity, type(error).__name__)
                await self.append('commentary', FAILED, delegation_id=identity)
                continue
            elapsed = time.monotonic() - started
            await self.to_phone({'type': 'assistant_response', **result})
            for part in split_for_append(result['text']) or [result['text']]:
                await self.append('commentary', part, delegation_id=identity)
            summary = route_summary(result)
            if summary:
                await self.append('thinking', summary, delegation_id=identity)
            logger.info('Voice delegation %s: wait=%.0fms agent=%.0fms tools=%s actions=%d', identity or 'text',
                        (started - received) * 1000, elapsed * 1000, [c['name'] for c in result.get('tool_calls', [])],
                        len(result.get('actions', [])))

    # ------------------------------------------------------------------ backend -> voice

    async def events_loop(self):
        while True:
            event = await self.subscriber.queue.get()
            await self.handle_session_event(event)

    async def handle_session_event(self, event):
        kind = event.get('type')
        progress = event.get('progress') or {}
        now = time.monotonic()
        speak = progress.get('speak')
        if speak and kind in ('progress', 'arrived', 'lost'):
            # arrived/lost are emitted right after the progress event carrying the same cue.
            if not (speak == self.last_cue[0] and now - self.last_cue[1] < 3):
                self.last_cue = (speak, now)
                if progress.get('state') in SAY_EXACTLY:
                    await self.append('instructions', f'Say exactly, now: "{speak}"')
                else:
                    await self.append('commentary', speak)
        if kind == 'ended':
            await self.append('instructions', 'The navigation session has ended. Tell the user briefly, then stop.')
        elif kind == 'localized' and self.last_situation is None:
            await self.push_situation()
        # Keep the phone informed without flooding it at pose rate; the route itself only travels on
        # the events that change it (rerouted) or end guidance.
        if kind != 'progress' or speak or now - self.last_progress_sent >= 0.5:
            self.last_progress_sent = now
            mirrored = event if kind != 'progress' else {k: v for k, v in event.items() if k != 'route'}
            await self.to_phone({'type': 'navigation', 'event': mirrored})

    async def context_loop(self):
        while True:
            await asyncio.sleep(self.settings.voice_context_interval_s)
            await self.push_situation()

    async def push_situation(self):
        if self.worlds is None or self.upstream is None:
            return
        try:
            text = situation(self.worlds, self.session_id)
        except Exception as error:  # noqa: BLE001 - context is best effort; the call must not drop
            logger.warning('Voice situation unavailable (%s)', type(error).__name__)
            return
        if text and text != self.last_situation:
            self.last_situation = text
            await self.append('thinking', text, event_id='situation')
