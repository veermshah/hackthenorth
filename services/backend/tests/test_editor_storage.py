"""Pins and measurements use unique IDs and persist world coordinates unchanged."""
from .test_worlds import client, world  # noqa: F401 -- shared API fixtures

import pytest


@pytest.mark.parametrize('resource,item', [
    ('notes', {'id': 'pin', 'title': 'Door', 'position': [10, 2, -3], 'createdAt': '2026-09-20T00:00:00Z'}),
    ('measurements', {'id': 'span', 'points': [[10, 2, -3], [10, 5, 1]]}),
])
def test_editor_roundtrip_and_duplicate_rejection(client, resource, item):
    url = f'/worlds/demo-building/{resource}'
    body = {'schema': f'wander.{resource}/v1', 'worldId': 'demo-building', resource: [item]}
    assert client.put(url, json=body).status_code == 200
    assert client.get(url).json()[resource] == [item]
    assert client.put(url, json={**body, resource: [item, item]}).status_code == 400
    # A rejected edit cannot damage the previous snapshot.
    assert client.get(url).json()[resource] == [item]
    assert client.put(url, json={**body, resource: []}).status_code == 200
    assert client.get(url).json()[resource] == []


@pytest.mark.parametrize('resource,item', [
    ('notes', {'id': 'pin', 'title': 'Door', 'position': [10, 2, -3], 'createdAt': '2026-09-20T00:00:00Z'}),
    ('measurements', {'id': 'span', 'points': [[10, 2, -3], [10, 5, 1]]}),
])
def test_legacy_duplicates_recover_with_backup_and_preserve_every_record(client, settings, resource, item):
    import json
    from copy import deepcopy
    path = settings.wander_data_root / 'worlds/demo-building' / f'{resource}.json'
    records = [deepcopy(item), {**deepcopy(item), 'id': item['id'] + '-duplicate-2'}, deepcopy(item)]
    if resource == 'notes':
        records[2].update(title='Different door', position=[-4, 5, 6], description='Keep this too')
    original = {'schema': f'wander.{resource}/v1', 'worldId': 'demo-building', resource: records}
    path.write_text(json.dumps(original))
    response = client.get(f'/worlds/demo-building/{resource}')
    assert response.status_code == 200, response.text
    repaired = response.json()[resource]
    assert len(repaired) == len(records)
    assert [row['id'] for row in repaired] == [item['id'], item['id'] + '-duplicate-2', item['id'] + '-duplicate-3']
    for before, after in zip(records, repaired):
        assert {k: v for k, v in before.items() if k != 'id'} == {k: v for k, v in after.items() if k != 'id'}
    assert json.loads(path.read_text())[resource] == repaired
    backups = list(path.parent.glob(f'{resource}-before-id-repair-*.json'))
    assert len(backups) == 1
    assert json.loads(backups[0].read_text()) == original
    assert client.get(f'/worlds/demo-building/{resource}').json()[resource] == repaired
    assert len(list(path.parent.glob(f'{resource}-before-id-repair-*.json'))) == 1


def test_duplicate_recovery_does_not_hide_other_corruption(client, settings):
    import json
    path = settings.wander_data_root / 'worlds/demo-building/notes.json'
    original = {'schema': 'wander.notes/v1', 'worldId': 'demo-building', 'notes': [{'id': 'bad'}]}
    path.write_text(json.dumps(original))
    assert client.get('/worlds/demo-building/notes').status_code == 400
    assert json.loads(path.read_text()) == original
