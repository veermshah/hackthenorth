"""Public endpoints that make one of the wearer's phones buzz briefly.

    POST or GET /haptics/{role}[?ms=300]      role: front | left | right | back | all

Pulses queue in memory for a few seconds. The front phone polls
`GET /haptics/pending?since=<last id>` (API key required) a few times a second,
buzzes itself for `front`, and forwards the rest to the side phones over the
peer link. The trigger routes need no API key so a demo page or a curl can hit them.
"""
import time
from itertools import count

from fastapi import APIRouter, HTTPException, Query, Request

router = APIRouter()
ROLES = ('front', 'left', 'right', 'back')
PUBLIC_PREFIX = '/haptics/'
PENDING_PATH = '/haptics/pending'


def is_public_path(path: str) -> bool:
    """Trigger routes are public; the phone's pending feed keeps the API key."""
    return path.startswith(PUBLIC_PREFIX) and path != PENDING_PATH


class PulseQueue:
    def __init__(self, ttl: float = 10.0, limit: int = 100):
        self.ttl, self.limit = ttl, limit
        self.pulses = []
        # Ids keep increasing across container restarts, so a phone's "since"
        # cursor from a previous instance never hides new pulses.
        self.ids = count(int(time.time() * 1000))

    def add(self, role: str, ms: int, now=None):
        now = time.time() if now is None else now
        self.prune(now)
        pulse = {'id': next(self.ids), 'role': role, 'ms': ms, 'at': now}
        self.pulses.append(pulse)
        del self.pulses[:-self.limit]
        return pulse

    def since(self, last_id: int, now=None):
        now = time.time() if now is None else now
        self.prune(now)
        return [p for p in self.pulses if p['id'] > last_id]

    def prune(self, now):
        self.pulses = [p for p in self.pulses if now - p['at'] <= self.ttl]


def queue(request: Request) -> PulseQueue:
    if not hasattr(request.app.state, 'haptics'):
        request.app.state.haptics = PulseQueue()
    return request.app.state.haptics


@router.get('/haptics/pending')
async def pending(request: Request, since: int = Query(default=0, ge=0)):
    pulses = queue(request).since(since)
    return {'pulses': [{'id': p['id'], 'role': p['role'], 'ms': p['ms']} for p in pulses],
            'last': pulses[-1]['id'] if pulses else since}


# Registered after the pending feed so "/haptics/pending" is never treated as a role.
@router.api_route('/haptics/{role}', methods=['GET', 'POST'])
async def trigger(role: str, request: Request, ms: int = Query(default=300, ge=50, le=3000)):
    roles = ROLES if role == 'all' else (role,)
    if role != 'all' and role not in ROLES:
        raise HTTPException(404, f'Unknown role {role!r}; use one of {", ".join(ROLES)} or all')
    pulses = [queue(request).add(r, ms) for r in roles]
    return {'queued': [{'id': p['id'], 'role': p['role'], 'ms': p['ms']} for p in pulses]}
