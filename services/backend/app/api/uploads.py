"""Short-lived tickets that let a browser PUT one asset straight to this service.

A splat is hundreds of megabytes, and the web app's Vercel functions cap request
bodies at 4.5 MB, so the bytes cannot be proxied through them. Instead the web
server — which holds the API key — mints a ticket for one exact
`worlds/<id>/<version>/<file>` path, and the browser uploads with that ticket in
`X-Upload-Ticket` instead of the key. The ticket is worthless for anything else:
it names a single path that does not exist yet (versions are immutable), and it
expires in minutes.
"""
import secrets
import time

TICKET_HEADER = b'x-upload-ticket'
TICKET_TTL_SECONDS = 30 * 60


class UploadTickets:
    """In-memory tickets, each bound to one asset path. Expired ones are pruned on use."""

    def __init__(self, ttl: float = TICKET_TTL_SECONDS, limit: int = 100):
        self.ttl, self.limit = ttl, limit
        self.tickets: dict[str, tuple[str, float]] = {}

    def mint(self, path: str, now=None) -> tuple[str, float]:
        now = time.time() if now is None else now
        self.prune(now)
        token = secrets.token_urlsafe(32)
        expires = now + self.ttl
        self.tickets[token] = (path, expires)
        # A burst of abandoned uploads must not grow this without bound.
        for stale in list(self.tickets)[:-self.limit]:
            del self.tickets[stale]
        return token, expires

    def valid(self, token: str, path: str, now=None) -> bool:
        now = time.time() if now is None else now
        entry = self.tickets.get(token)
        if entry is None:
            return False
        wanted, expires = entry
        if expires <= now:
            del self.tickets[token]
            return False
        # compare_digest so a wrong ticket cannot be narrowed down by timing.
        return secrets.compare_digest(wanted, path)

    def spend(self, token: str) -> None:
        """Drop a ticket once its file is stored; a retry needs a fresh one."""
        self.tickets.pop(token, None)

    def prune(self, now=None) -> None:
        now = time.time() if now is None else now
        for token, (_, expires) in list(self.tickets.items()):
            if expires <= now:
                del self.tickets[token]


def asset_path(scope) -> str | None:
    """`worlds/<id>/<version>/<file>` when the request is an asset PUT, else None."""
    if scope.get('method') != 'PUT':
        return None
    parts = scope.get('path', '').strip('/').split('/')
    if len(parts) != 4 or parts[0] != 'worlds':
        return None
    return '/'.join(parts)


def authorizes(scope) -> bool:
    """True when this request carries a live ticket for exactly the path it targets."""
    path = asset_path(scope)
    if path is None:
        return False
    token = dict(scope['headers']).get(TICKET_HEADER, b'').decode('utf-8', errors='replace')
    if not token:
        return False
    tickets = getattr(scope['app'].state, 'upload_tickets', None)
    return tickets is not None and tickets.valid(token, path)
