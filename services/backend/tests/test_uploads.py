import json

import pytest
from fastapi.testclient import TestClient

from ..app.api.uploads import UploadTickets, asset_path
from ..app.config import ROOT
from ..app.main import create_app
from ..scripts.fixtures import FixtureEvents, FixtureSearch, ScriptedModel

WORLD = 'demo-building'
ASSET = f'/worlds/{WORLD}/v1/scene.spz'


@pytest.fixture
def seeded(settings):
    world = json.loads((ROOT / 'shared/contracts/examples/demo-building.world.json').read_text(encoding='utf-8'))
    path = settings.wander_data_root / 'worlds' / world['id'] / 'world.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(world), encoding='utf-8')
    return settings


@pytest.fixture
def client(seeded):
    seeded.wander_web_origins = 'https://wander.example'
    app = create_app(seeded, model=ScriptedModel([]), events=FixtureEvents(), search=FixtureSearch())
    with TestClient(app, headers={'X-API-Key': seeded.wander_api_key}) as value:
        yield value


def test_tickets_expire_and_are_bound_to_one_path():
    tickets = UploadTickets(ttl=60)
    token, expires = tickets.mint('worlds/a/v1/scene.spz', now=100)
    assert expires == 160
    assert tickets.valid(token, 'worlds/a/v1/scene.spz', now=159)
    assert not tickets.valid(token, 'worlds/a/v1/other.spz', now=159), 'a ticket names one file'
    assert not tickets.valid(token, 'worlds/b/v1/scene.spz', now=159), 'and one world'
    assert not tickets.valid('made-up', 'worlds/a/v1/scene.spz', now=159)
    assert not tickets.valid(token, 'worlds/a/v1/scene.spz', now=161), 'expired'


def test_spent_tickets_stop_working():
    tickets = UploadTickets()
    token, _ = tickets.mint('worlds/a/v1/scene.spz')
    tickets.spend(token)
    assert not tickets.valid(token, 'worlds/a/v1/scene.spz')


def test_asset_path_only_matches_versioned_asset_puts():
    def scope(method, path):
        return {'method': method, 'path': path}

    assert asset_path(scope('PUT', '/worlds/a/v1/scene.spz')) == 'worlds/a/v1/scene.spz'
    assert asset_path(scope('GET', '/worlds/a/v1/scene.spz')) is None
    assert asset_path(scope('PUT', '/worlds/a/graph')) is None
    assert asset_path(scope('PUT', '/worlds/a/v1/scene.spz/extra')) is None
    assert asset_path(scope('PUT', '/sessions/a/v1/scene.spz')) is None


def test_ticket_lets_a_keyless_browser_upload_one_file(client):
    minted = client.post(ASSET + '/ticket')
    assert minted.status_code == 201
    token = minted.json()['token']
    assert minted.json()['path'] == f'worlds/{WORLD}/v1/scene.spz'

    keyless = {'X-API-Key': '', 'X-Upload-Ticket': token}
    assert client.put(ASSET, content=b'splat bytes', headers=keyless).status_code == 201
    stored = client.get(ASSET)
    assert stored.status_code == 200 and stored.content == b'splat bytes'

    # Spent: the same ticket cannot be replayed against the next version either.
    replay = client.put(f'/worlds/{WORLD}/v2/scene.spz', content=b'x', headers=keyless)
    assert replay.status_code == 401


def test_a_ticket_is_useless_on_any_other_route(client):
    token = client.post(ASSET + '/ticket').json()['token']
    keyless = {'X-API-Key': '', 'X-Upload-Ticket': token}
    assert client.get('/worlds', headers=keyless).status_code == 401
    assert client.put(f'/worlds/{WORLD}/v1/other.spz', content=b'x', headers=keyless).status_code == 401
    assert client.delete(f'/worlds/{WORLD}', headers=keyless).status_code == 401


def test_minting_needs_the_key_and_refuses_taken_or_odd_paths(client):
    assert client.post(ASSET + '/ticket', headers={'X-API-Key': ''}).status_code == 401
    assert client.post(f'/worlds/{WORLD}/v1/scene.exe/ticket').status_code == 400
    assert client.post('/worlds/missing/v1/scene.spz/ticket').status_code == 404
    client.put(ASSET, content=b'first')
    assert client.post(ASSET + '/ticket').status_code == 409, 'versions are immutable'


def test_preflight_is_answered_without_a_key(seeded):
    seeded.wander_web_origins = 'https://wander.example,http://localhost:3000'
    app = create_app(seeded, model=ScriptedModel([]), events=FixtureEvents(), search=FixtureSearch())
    with TestClient(app) as client:
        preflight = client.options(ASSET, headers={
            'Origin': 'https://wander.example',
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers': 'x-upload-ticket',
        })
        assert preflight.status_code == 200
        assert preflight.headers['access-control-allow-origin'] == 'https://wander.example'
        assert 'x-upload-ticket' in preflight.headers['access-control-allow-headers'].lower()

        other = client.options(ASSET, headers={
            'Origin': 'https://not-ours.example',
            'Access-Control-Request-Method': 'PUT',
        })
        assert 'access-control-allow-origin' not in other.headers


def test_no_ticket_when_the_browser_could_never_use_it(seeded):
    """Without CORS a browser cannot redeem a ticket, so handing one out only produces
    an unexplained network error in the upload dialog. Say so instead."""
    seeded.wander_web_origins = ''
    app = create_app(seeded, model=ScriptedModel([]), events=FixtureEvents(), search=FixtureSearch())
    with TestClient(app, headers={'X-API-Key': seeded.wander_api_key}) as client:
        refused = client.post(ASSET + '/ticket')
        assert refused.status_code == 503
        assert 'WANDER_WEB_ORIGINS' in refused.json()['detail']
        # Uploading with the key still works; only the browser path is off.
        assert client.put(ASSET, content=b'splat').status_code == 201
