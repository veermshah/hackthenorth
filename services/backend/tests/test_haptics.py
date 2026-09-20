from fastapi.testclient import TestClient

from services.backend.app.api.haptics import PulseQueue, is_public_path
from services.backend.app.main import create_app


def test_public_paths_exclude_the_phone_feed():
    assert is_public_path('/haptics/left')
    assert is_public_path('/haptics/all')
    assert not is_public_path('/haptics/pending')
    assert not is_public_path('/worlds/x/localize')


def test_ids_keep_increasing_across_restarts():
    first = PulseQueue().add('left', 300)['id']
    second = PulseQueue().add('left', 300)['id']  # a "restarted" queue
    assert second >= first


def test_queue_prunes_and_cursors():
    q = PulseQueue(ttl=10)
    a = q.add('left', 300, now=100)
    b = q.add('back', 500, now=105)
    assert [p['id'] for p in q.since(0, now=106)] == [a['id'], b['id']]
    assert [p['id'] for p in q.since(a['id'], now=106)] == [b['id']]
    assert q.since(0, now=116) == [], 'expired'


def test_trigger_is_keyless_and_pending_is_not(settings):
    with TestClient(create_app(settings)) as client:
        assert client.get('/haptics/pending').status_code == 401
        left = client.post('/haptics/left?ms=250')
        assert left.status_code == 200 and left.json()['queued'][0]['role'] == 'left'
        assert client.get('/haptics/right').status_code == 200, 'a browser GET works too'
        assert client.get('/haptics/elbow').status_code == 404
        assert client.get('/haptics/all').status_code == 200
        feed = client.get('/haptics/pending', headers={'X-API-Key': 'test-key'}).json()
        roles = [p['role'] for p in feed['pulses']]
        assert roles == ['left', 'right', 'front', 'left', 'right', 'back']
        assert feed['pulses'][0]['ms'] == 250
        later = client.get(f"/haptics/pending?since={feed['last']}", headers={'X-API-Key': 'test-key'}).json()
        assert later['pulses'] == [] and later['last'] == feed['last']
