"""Phone-facing voice socket. The Live bridge itself lives in services/voice_bridge.py.

The native client supplies PCM16LE mono 24 kHz and plays returned PCM in order. This endpoint
is opt-in and requires a server-configured demo access token in the first message.
"""
import asyncio
import hmac
import json
import logging
from contextlib import suppress

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..services.voice_bridge import LiveBridge, TranscriptWindow, audio_event  # noqa: F401 - re-exported for callers/tests

router = APIRouter()
logger = logging.getLogger(__name__)


@router.websocket('/ws/sessions/{session_id}/voice')
async def voice_socket(socket: WebSocket, session_id: str):
    state = socket.app.state
    settings = state.settings
    await socket.accept()
    if not settings.voice_enabled or not settings.voice_access_token or not settings.openai_api_key:
        await socket.close(code=1008, reason='Voice is not configured')
        return
    calls = state.voice_calls
    joined = False
    try:
        # A first-message token avoids putting credentials in URLs/access logs.
        raw = await asyncio.wait_for(socket.receive_text(), timeout=10)
        if len(raw) > 2048:
            raise ValueError('Invalid authentication message')
        auth = json.loads(raw)
        if (not isinstance(auth, dict) or set(auth) != {'type', 'token'} or auth['type'] != 'auth'
                or not isinstance(auth['token'], str)
                or not hmac.compare_digest(auth['token'], settings.voice_access_token)):
            await socket.close(code=1008, reason='Unauthorized')
            return
        state.store.get(session_id)
        if session_id in calls:
            await socket.close(code=1008, reason='A voice call is already active for this session')
            return
        calls.add(session_id)
        joined = True
        bridge = LiveBridge(socket, state.agent, session_id, settings, worlds=state.worlds)
        try:
            await bridge.run()
        except TimeoutError:
            logger.info('Voice session %s reached the configured maximum duration', session_id)
            with suppress(Exception):
                await socket.send_json({'type': 'closed', 'reason': 'max_duration', 'seconds': bridge.usage_seconds,
                                        'renewing': False})
    except WebSocketDisconnect:
        return
    except KeyError:
        with suppress(Exception):
            await socket.send_json({'type': 'error', 'message': 'Session not found'})
    except Exception as error:
        logger.warning('Voice session %s stopped (%s)', session_id, type(error).__name__)
        with suppress(Exception):
            await socket.send_json({'type': 'error', 'message': 'Voice unavailable or call ended; reconnect to retry.'})
    finally:
        if joined:
            calls.discard(session_id)
        with suppress(Exception):
            await socket.close()
