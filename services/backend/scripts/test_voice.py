"""Paid voice smoke test against a running backend (Phase 0 of docs/VOICE_AGENT_PLAN.md).

Two input modes, combinable:
  --input question.wav   mono PCM16 24 kHz recording, paced like a live microphone
  --say "guide me to room 101"   typed text through the same delegation path (no audio needed)

Every phone-side event is printed with a wall-clock offset and optionally written as JSONL
(--log). Set VOICE_TRACE=true on the backend to also log upstream Live events there, which is
what tells you where transcript fragments land relative to delegation offsets.
"""
import argparse
import asyncio
import base64
import json
import time
import wave
from pathlib import Path

import httpx
from websockets.asyncio.client import connect
from ..app.config import Settings


def load_audio(path):
    with wave.open(str(path), 'rb') as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 24000):
            raise ValueError('Input must be a mono PCM16 WAV at 24000 Hz')
        audio = source.readframes(source.getnframes())
    if len(audio) > 60 * 48000:
        raise ValueError('Smoke-test recordings must be at most 60 seconds')
    return audio


async def run(args):
    settings = Settings()
    if not settings.voice_access_token:
        raise ValueError('Set VOICE_ACCESS_TOKEN to match the backend')
    audio = load_audio(args.input) if args.input else b''
    async with httpx.AsyncClient(headers={'X-API-Key': settings.wander_api_key}) as http:
        if args.session:
            session = args.session
        else:
            response = await http.post(args.base_url + '/sessions', json={'worldId': args.world, 'deviceId': 'voice-smoke-test'})
            response.raise_for_status()
            session = response.json()['sessionId']
    print('session', session)
    url = args.base_url.replace('https://', 'wss://').replace('http://', 'ws://')
    output = bytearray()
    started = time.monotonic()
    log = open(args.log, 'a', encoding='utf-8') if args.log else None

    def record(event):
        stamp = time.monotonic() - started
        if log:
            log.write(json.dumps({'t': round(stamp, 3), **event}, ensure_ascii=False) + '\n')
        if event['type'] == 'audio':
            return
        summary = {k: v for k, v in event.items() if k not in ('type', 'tool_calls', 'sources')}
        print(f"{stamp:7.2f}s {event['type']:<18} {json.dumps(summary, ensure_ascii=False)[:300]}")

    async with connect(f'{url}/ws/sessions/{session}/voice', additional_headers={'X-API-Key': settings.wander_api_key},
                       max_size=2**20) as socket:
        await socket.send(json.dumps({'type': 'auth', 'token': settings.voice_access_token}))
        ready = json.loads(await socket.recv())
        record(ready)
        if ready.get('type') != 'voice_ready':
            raise ValueError('Voice did not become ready')

        async def send():
            # Live listens continuously: keep silence flowing so the greeting and answers are timed
            # against a real microphone stream, then the recording, then silence for the reply.
            data = b'\0' * 48000 * 2 + audio + b'\0' * 48000 * args.wait_seconds
            for index, offset in enumerate(range(0, len(data), 4800)):
                if index == 20:
                    for text in args.say:
                        await socket.send(json.dumps({'type': 'text', 'text': text}))
                        await asyncio.sleep(args.say_gap)
                await socket.send(json.dumps({'type': 'audio', 'audio': base64.b64encode(data[offset:offset + 4800]).decode()}))
                await asyncio.sleep(0.1)
            await socket.send(json.dumps({'type': 'close'}))

        async def receive():
            async for raw in socket:
                event = json.loads(raw)
                record(event)
                if event['type'] == 'audio':
                    output.extend(base64.b64decode(event['audio']))
                elif event['type'] == 'error':
                    raise ValueError(event['message'])
                elif event['type'] == 'closed' and not event.get('renewing'):
                    return
        await asyncio.gather(send(), receive())
    if log:
        log.close()
    if not output:
        print('No output audio received')
        return
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), 'wb') as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(24000)
        target.writeframes(output)
    print(f'{args.output} ({len(output) / 48000:.1f} s of speech)')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', type=Path, help='mono PCM16 24 kHz WAV to stream as microphone audio')
    parser.add_argument('--say', action='append', default=[], help='typed request sent after two seconds; repeatable')
    parser.add_argument('--say-gap', type=float, default=8, help='seconds between repeated --say requests')
    parser.add_argument('--output', type=Path, default=Path('artifacts/voice-reply.wav'))
    parser.add_argument('--log', type=Path, help='append every phone-side event as JSON lines')
    parser.add_argument('--base-url', default='http://127.0.0.1:8000')
    parser.add_argument('--world', default='demo-building', help='world for a new session')
    parser.add_argument('--session', help='reuse an existing session (e.g. the phone\'s, to test cues)')
    parser.add_argument('--wait-seconds', type=int, default=30)
    args = parser.parse_args()
    if not 5 <= args.wait_seconds <= 120:
        parser.error('wait-seconds must be 5..120')
    if not args.input and not args.say:
        parser.error('Provide --input and/or --say')
    asyncio.run(run(args))


if __name__ == '__main__':
    main()
