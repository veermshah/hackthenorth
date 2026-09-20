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
