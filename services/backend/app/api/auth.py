import secrets
from urllib.parse import parse_qs

from .haptics import is_public_path
from .uploads import authorizes as upload_ticket_authorizes
from starlette.responses import JSONResponse
from starlette.websockets import WebSocket


class APIKeyMiddleware:
    """Fail closed for HTTP and WS, including the older demo endpoints."""
    def __init__(self, app, key):
        self.app, self.key = app, key

    async def __call__(self, scope, receive, send):
        if scope['type'] not in ('http', 'websocket'):
            return await self.app(scope, receive, send)
        if scope['type'] == 'http' and is_public_path(scope.get('path', '')):
            return await self.app(scope, receive, send)  # demo buzz triggers, deliberately keyless
        # A browser uploading a splat cannot be given the key; it carries a ticket the web
        # server minted for that one path instead (see api/uploads.py).
        if scope['type'] == 'http' and upload_ticket_authorizes(scope):
            return await self.app(scope, receive, send)
        headers = dict(scope['headers'])
        provided = headers.get(b'x-api-key', b'').decode('utf-8', errors='replace')
        # A plain browser navigation can't set a custom header. Websockets already
        # accept ?key=... for the same reason; extend that narrowly to the
        # disposable self-hosted-localization test page only (not every route).
        if not provided and (scope['type'] == 'websocket'
                             or scope.get('path') in ('/localize-test', '/map-viewer')):
            provided = parse_qs(scope.get('query_string', b'').decode()).get('key', [''])[0]
        if not self.key or not secrets.compare_digest(provided.encode(), self.key.encode()):
            response = JSONResponse({'detail': 'invalid api key'}, status_code=401)
            if scope['type'] == 'http':
                return await response(scope, receive, send)
            socket = WebSocket(scope, receive, send)
            if 'websocket.http.response' in scope.get('extensions', {}):
                return await socket.send_denial_response(response)
            return await socket.close(code=1008)
        await self.app(scope, receive, send)
