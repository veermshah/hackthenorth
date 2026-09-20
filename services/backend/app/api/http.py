import asyncio
import json
from pathlib import Path
from fastapi import APIRouter, Request, UploadFile, File, Form, HTTPException, Query as QueryParam
from fastapi.responses import HTMLResponse, StreamingResponse
from ..models import SessionRequest, DestinationRequest, Query, Document
from ..integrations.elastic.ingestion import extract_text
from ..services.sessions import broadcast

router = APIRouter()
STATIC_DIR = Path(__file__).resolve().parents[1] / 'static'
LOCALIZE_TEST_PAGE = (STATIC_DIR / 'localize_test.html').read_text(encoding='utf-8')
MAP_VIEWER_PAGE = (STATIC_DIR / 'map_viewer.html').read_text(encoding='utf-8')


@router.get('/health')
async def health():
    return {'status': 'ok'}


@router.get('/localize-test', response_class=HTMLResponse)
async def localize_test_page():
    """Disposable dev harness for services/backend/deployment/modal_localization.py.
    Reachable via ?key=... (see APIKeyMiddleware) since a plain browser navigation
    can't set a custom header; the page's own API calls use the header normally."""
    return LOCALIZE_TEST_PAGE


@router.get('/map-viewer', response_class=HTMLResponse)
async def map_viewer_page():
    """Disposable dev harness: renders a build_map point cloud + registered
    camera positions with Three.js. See app/api/worlds.py's
    GET /worlds/{id}/localization-map/points.ply and .../cameras."""
    return MAP_VIEWER_PAGE


@router.post('/legacy/sessions', status_code=201)
async def create_session(body: SessionRequest, request: Request):
    return request.app.state.navigation.create(body.site_id).snapshot()


@router.get('/legacy/sessions/{session_id}')
async def session_state(session_id: str, request: Request):
    return request.app.state.store.get(session_id).snapshot()


@router.get('/destinations')
async def destinations(request: Request):
    graph = request.app.state.navigation.graph
    return {'site_id': graph.site_id, 'destinations': [d.model_dump() for d in graph.destinations]}


@router.post('/legacy/sessions/{session_id}/destination')
async def destination(session_id: str, body: DestinationRequest, request: Request):
    state = request.app.state
    session = state.store.get(session_id)
    result = state.navigation.set_destination(session, body.destination_id, body.accessible_only)
    await broadcast(session, {'type': 'route_update', **result})
    await broadcast(session, {'type': 'navigation_instruction', **result})
    state.events.record(session, 'destination_set', body.model_dump())
    state.events.record(session, 'route_generated', result)
    if result['instruction'] == 'arrived':
        state.events.record(session, 'arrived', {'destination_id': body.destination_id})
    return result


@router.post('/assistant/query')
async def query(body: Query, request: Request):
    return await request.app.state.agent.query(body.session_id, body.text, body.ui_context)


@router.post('/assistant/query/stream')
async def query_stream(body: Query, request: Request):
    """Server-sent events: zero or more {"type":"delta","text":...} chunks as the model's
    final answer streams in, then one {"type":"final", text, sources, actions, tool_calls}
    event. Same agent loop and session state as POST /assistant/query; that endpoint stays
    non-streaming for callers (the mobile call view) that need one complete answer to speak."""
    async def events():
        async for event in request.app.state.agent.query_stream(body.session_id, body.text, body.ui_context):
            if event['type'] == 'delta':
                yield f"data: {json.dumps({'type': 'delta', 'text': event['text']})}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'final', **event['payload']})}\n\n"
    return StreamingResponse(events(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@router.post('/knowledge/documents', status_code=201)
async def document(body: Document, request: Request):
    if body.site_id != request.app.state.navigation.graph.site_id:
        raise ValueError('Unknown site')
    return {'source_ids': await request.app.state.ingestion.document(body)}


@router.post('/knowledge/upload', status_code=201)
async def upload(request: Request, site_id: str = Form(...), document_id: str = Form(...),
                 file: UploadFile = File(...)):
    data = await file.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(413, 'Maximum upload size is 5 MiB')
    try:
        text = await asyncio.to_thread(extract_text, file.filename or '', data)
    except Exception:
        raise ValueError('Could not extract text; use valid UTF-8 text/Markdown or a text PDF')
    return await document(Document(site_id=site_id, id=document_id, title=file.filename or document_id, text=text), request)


@router.get('/sites/{site_id}/obstacle-hotspots')
async def obstacle_hotspots(site_id: str, request: Request, hours: int = QueryParam(default=24, ge=1, le=168)):
    """Operator-facing view of the same ES|QL STATS aggregation the assistant's
    get_obstacle_hotspots tool uses, without going through the LLM."""
    rows = await request.app.state.events.hazard_density(site_id, hours)
    return {'site_id': site_id, 'hours': hours, 'hotspots': rows}


@router.get('/elastic/status')
async def elastic_status(request: Request):
    elastic = request.app.state.elastic
    available = False
    if elastic.client:
        try:
            available = bool(await elastic.client.ping())
        except Exception:
            pass
    return {'configured': elastic.client is not None, 'reachable': available,
            'embedding_endpoint': elastic.settings.elastic_embedding_endpoint,
            'rerank_endpoint': elastic.settings.elastic_rerank_endpoint,
            'failed_event_writes': request.app.state.events.failed_writes}
