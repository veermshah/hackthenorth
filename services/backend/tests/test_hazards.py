import json

from services.backend.app.services.hazards import hazards_from_files, is_hazard
from services.backend.app.services.worlds import WorldStore


def test_is_hazard_needs_position_and_role_or_category():
    assert is_hazard({'navigation_role': 'potential_hazard', 'x': 1, 'y': 0, 'z': 2})
    assert is_hazard({'category': 'obstacle', 'x': 1.5, 'y': 0.0, 'z': -2.0})
    assert not is_hazard({'category': 'restroom', 'navigation_role': 'destination', 'x': 1, 'y': 0, 'z': 2})
    assert not is_hazard({'navigation_role': 'potential_hazard'})


def test_hazards_from_files_merges_notes_and_annotations(tmp_path):
    store = WorldStore(tmp_path)
    world = tmp_path / 'worlds' / 'w1'
    world.mkdir(parents=True)
    (world / 'context-notes.json').write_text(json.dumps([
        {'id': 'n1', 'name': 'Bags by the door', 'category': 'obstacle', 'navigation_role': 'potential_hazard',
         'permanence': 'temporary', 'x': 1.0, 'y': 0.0, 'z': -2.0, 'extra': 'dropped'},
        {'id': 'n2', 'name': 'Reception', 'category': 'reception', 'navigation_role': 'landmark', 'x': 0, 'y': 0, 'z': 0},
    ]))
    (world / 'annotations.json').write_text(json.dumps([
        {'id': 'a1', 'name': 'Step down', 'category': 'surface_change', 'navigation_role': 'context',
         'x': 3.0, 'y': 0.0, 'z': 1.0},
    ]))
    rows = hazards_from_files(store, 'w1')
    assert [r['id'] for r in rows] == ['n1', 'a1']
    assert 'extra' not in rows[0]
    assert rows[1]['x'] == 3.0
