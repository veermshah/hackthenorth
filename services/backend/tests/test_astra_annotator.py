"""Astra as annotator/guide: posed VPS frames → placed review-only candidates → landmark-rich guidance."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from ..app.main import create_app
from ..app.services.annotations import (
    AnnotationBatch, Candidate, ImagePoint, PosedFinding, PosedFindings, batch_digest, world_digest)
from ..app.services.worlds import check
from ..scripts.fixtures import ScriptedModel, FixtureEvents, FixtureSearch
from .test_localization_queries import SITE, upload
from .test_worlds import world  # noqa: F401  (fixture)

FILLER = PosedFinding(category='bottle_filler', name='Bottle filler', description='Wall-mounted filler beside the desk',
                      sign_text='', designation='unknown', uncertainty='', image_point=ImagePoint(u=0.5, v=1.0))
CABLE = PosedFinding(category='obstacle', name='Loose cable', description='Cable across the corridor', sign_text='',
                     designation='unknown', uncertainty='Extent unclear', navigation_role='potential_hazard',
                     image_point=ImagePoint(u=0.5, v=1.0))
SKY = PosedFinding(category='sign', name='Ceiling sign', description='Hanging sign', sign_text='Exit', designation='unknown',
                   uncertainty='', image_point=ImagePoint(u=0.5, v=0.0))
# Landscape camera at chest height above the lobby desk, looking down -Z: the bottom-centre pixel lands ~3.6 m ahead, 1.4 m from the lobby node.
CAMERA_OVER_LOBBY = {'position': [4.5, 1.5, 1.0], 'rotation': [0, 0, 0, 1]}
LANDSCAPE = {'width': 640, 'height': 480, 'orientation': 'landscape', 'fovDeg': {'horizontal': 60, 'vertical': 45}}


@pytest.fixture
def astra():
    parse = AsyncMock(return_value=SimpleNamespace(output_parsed=PosedFindings(findings=[FILLER, CABLE, SKY])))
    return SimpleNamespace(responses=SimpleNamespace(parse=parse))


@pytest.fixture
def client(settings, world, astra):
    path = settings.wander_data_root / 'worlds' / world['id'] / 'world.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(world), encoding='utf-8')
    with TestClient(create_app(settings, model=ScriptedModel([]), events=FixtureEvents(), search=FixtureSearch(),
                              annotation_client=astra), headers={'X-API-Key': settings.wander_api_key}) as value:
        assert value.patch(f"/worlds/{world['id']}", json={'nianticSiteId': SITE}).status_code == 200
        yield value


def localize(client, world, **overrides):
    result = client.post(f"/worlds/{world['id']}/localize/query", json=upload(world, **overrides))
    assert result.status_code == 201, result.text
    return result.json()


def test_proposals_are_placed_from_the_camera_pose_and_stay_out_of_the_live_graph(client, world, astra, settings):
    wid = world['id']
    posed = localize(client, world, image=LANDSCAPE, result={**upload(world)['result'], 'pose': CAMERA_OVER_LOBBY})
    # A frame that never localized is not evidence of anything and must be skipped.
    localize(client, world, image=LANDSCAPE,
             result={'trackingState': 'limited', 'anchorState': 'notTracked', 'confidence': 0.1})

    result = client.post(f'/worlds/{wid}/annotations/propose', json={})
    assert result.status_code == 201, result.text
    proposal = result.json()
    assert proposal['status'] == 'proposed' and proposal['queryIds'] == [posed['id']]
    assert proposal['placedWith'] == 'floor' and proposal['unplaced'] == 1
    assert astra.responses.parse.await_count == 1
    call = astra.responses.parse.await_args.kwargs
    assert call['text_format'] is PosedFindings and 'metric distances' in call['instructions']

    batch = AnnotationBatch.model_validate(proposal['batch'])
    by_name = {c.name: c for c in batch.candidates}
    filler = by_name['Bottle filler']
    assert filler.frame == posed['id'] + '.jpg' and len(filler.frame_sha256) == 64
    assert filler.position == pytest.approx([4.5, 0, -2.62], abs=0.05)
    assert filler.placement.method == 'floor' and filler.placement.query_id == posed['id']
    assert filler.placement.nearest_node == 'lobby' and filler.placement.nearest_node_metres < 1.5
    assert filler.placement.image_point == FILLER.image_point
    # Upward sight lines cannot be placed; the candidate is kept with the reason in its uncertainty.
    assert by_name['Ceiling sign'].position is None and 'Not placed' in by_name['Ceiling sign'].uncertainty
    assert by_name['Loose cable'].navigation_role == 'potential_hazard'
    # Deterministic IDs: the same frame + model output produces the same candidate IDs on re-run.
    again = client.post(f'/worlds/{wid}/annotations/propose', json={'queryIds': [posed['id']]}).json()
    assert [c['id'] for c in again['batch']['candidates']] == [c.id for c in batch.candidates]

    # Nothing about the live world changed; the artefact is a separate review-only file.
    assert client.get(f'/worlds/{wid}').json()['navigationGraph'] == world['navigationGraph']
    assert client.get(f'/worlds/{wid}/annotations/proposals').json()['batch'] == proposal['batch']
    assert (settings.wander_data_root / 'worlds' / wid / 'annotation-proposals.json').exists()


def test_propose_rejects_bad_selections(client, world):
    wid = world['id']
    assert client.post(f'/worlds/{wid}/annotations/propose', json={'limit': 0}).status_code == 400
    assert client.post(f'/worlds/{wid}/annotations/propose', json={'queryIds': ['missing']}).status_code == 404
    assert client.post(f'/worlds/{wid}/annotations/propose', json={}).status_code == 409  # no posed frames yet
    assert client.get(f'/worlds/{wid}/annotations/proposals').status_code == 404


def test_auto_detect_notes_creates_plain_pins_without_review(client, world, astra):
    wid = world['id']
    localize(client, world, image=LANDSCAPE, result={**upload(world)['result'], 'pose': CAMERA_OVER_LOBBY})

    result = client.post(f'/worlds/{wid}/notes/auto-detect', json={})
    assert result.status_code == 201, result.text
    body = result.json()
    # FILLER and CABLE share the same image_point, so they place at the same spot and one
    # is skipped as a within-batch duplicate; the Ceiling sign's upward sight line isn't placed.
    assert body['added'] == 1 and body['unplaced'] == 1 and body['skippedDuplicates'] == 1
    assert body['notes'][0]['title'] == 'Bottle filler'

    # A plain, immediately-visible/deletable pin: same file the "Add note" tool writes, and
    # the live navigation graph never changes (unlike the reviewed /annotations path).
    assert client.get(f'/worlds/{wid}/notes').json()['notes'] == body['notes']
    assert client.get(f'/worlds/{wid}').json()['navigationGraph'] == world['navigationGraph']

    # Re-running detection against the same evidence must not duplicate the pin.
    again = client.post(f'/worlds/{wid}/notes/auto-detect', json={}).json()
    assert again['added'] == 0 and again['skippedDuplicates'] == 2
    assert len(client.get(f'/worlds/{wid}/notes').json()['notes']) == 1


def test_candidates_to_notes_places_distinct_pins_and_skips_near_duplicates():
    from ..app.services.annotations import Candidate, candidates_to_notes

    near_desk = Candidate(id='a', frame='f.jpg', frame_sha256='x', category='desk', name='Desk',
                          description='A desk', sign_text='', designation='unknown', uncertainty='',
                          position=[1.0, 0.0, 2.0])
    far_bed = Candidate(id='b', frame='f.jpg', frame_sha256='x', category='bed', name='Bed 3',
                        description='A bed', sign_text='', designation='unknown', uncertainty='',
                        position=[10.0, 0.0, 10.0])
    duplicate_of_desk = Candidate(id='c', frame='f.jpg', frame_sha256='x', category='desk', name='Desk (again)',
                                  description='', sign_text='', designation='unknown', uncertainty='',
                                  position=[1.1, 0.0, 2.05])
    unplaced = Candidate(id='d', frame='f.jpg', frame_sha256='x', category='other', name='Unplaced',
                         description='', sign_text='', designation='unknown', uncertainty='', position=None)

    pairs, skipped = candidates_to_notes([near_desk, far_bed, duplicate_of_desk, unplaced], existing_notes=[])
    assert [note['title'] for note, _ in pairs] == ['Desk', 'Bed 3']
    assert skipped == 1
    assert all(note['author'] == 'auto-detected' for note, _ in pairs)

    # Also skips duplicates of pins that already existed before this batch.
    pairs2, skipped2 = candidates_to_notes([far_bed], existing_notes=[{'position': [10.0, 0.1, 9.9]}])
    assert pairs2 == [] and skipped2 == 1


def test_auto_detect_notes_rejects_bad_selections_and_needs_posed_frames(client, world):
    wid = world['id']
    assert client.post(f'/worlds/{wid}/notes/auto-detect', json={'limit': 0}).status_code == 400
    assert client.post(f'/worlds/{wid}/notes/auto-detect', json={}).status_code == 409  # no posed frames yet


def test_approved_candidates_publish_at_their_placed_position_and_guide_by_landmark(client, world):
    wid = world['id']
    localize(client, world, image=LANDSCAPE, result={**upload(world)['result'], 'pose': CAMERA_OVER_LOBBY})
    batch = AnnotationBatch.model_validate(client.post(f'/worlds/{wid}/annotations/propose', json={}).json()['batch'])
    by_name = {c.name: c for c in batch.candidates}
    review = {'site_id': wid, 'map_revision': 'v1', 'batch_sha256': batch_digest(batch),
              'graph_sha256': world_digest(client.get(f'/worlds/{wid}').json()), 'reviews': [
                  {'candidate_id': by_name['Bottle filler'].id, 'decision': 'approve', 'waypoint_id': 'lobby',
                   'verified_by': 'Surveyor', 'verified_at': '2026-09-19'},
                  {'candidate_id': by_name['Loose cable'].id, 'decision': 'note', 'waypoint_id': 'lobby',
                   'verified_by': 'Surveyor', 'verified_at': '2026-09-19'},
                  {'candidate_id': by_name['Ceiling sign'].id, 'decision': 'reject',
                   'verified_by': 'Surveyor', 'verified_at': '2026-09-19'}]}
    published = client.put(f'/worlds/{wid}/annotations', json={'batch': batch.model_dump(), 'review': review})
    assert published.status_code == 200, published.text
    check(published.json(), 'world.schema.json')
    node = {n['id']: n for n in published.json()['navigationGraph']['nodes']}[by_name['Bottle filler'].id]
    assert node['position'] == by_name['Bottle filler'].position and node['name'] == 'Bottle filler'
    assert node['kind'] == 'destination' and node['floor'] == '0'

    # Graph routing is still deterministic; the reviewed landmark only enriches the words.
    route = client.post(f'/worlds/{wid}/route', json={'from': 'entrance', 'to': 'room-101'}).json()
    check(route, 'navigation.schema.json', '#/$defs/routeResponse')
    assert [n['id'] for n in route['nodes']] == ['entrance', 'lobby', 'elevators', 'room-101']
    at_lobby = route['instructions'][1]
    assert at_lobby['landmarks'] == [{'id': node['id'], 'name': 'Bottle filler', 'relation': 'at'}]
    assert at_lobby['text'] == 'Continue straight past Bottle filler for 5 metres.'
    assert 'Loose cable' not in json.dumps(route)  # hazards / notes are never spoken as landmarks

    arrival = client.post(f'/worlds/{wid}/route', json={'from': 'entrance', 'to': node['id']}).json()
    assert arrival['instructions'][-1]['text'] == 'You have arrived at Bottle filler.'


def test_hand_written_candidates_without_a_placement_still_publish_at_the_waypoint(client, world):
    wid = world['id']
    batch = AnnotationBatch(site_id=wid, map_revision='v1', floor=0, model='fake', candidates=[
        Candidate(id='water', frame='a.jpg', frame_sha256='abc', category='bottle_filler',
                  name='Bottle filler', description='Verified fixture', sign_text='', designation='unknown', uncertainty='')])
    review = {'site_id': wid, 'map_revision': 'v1', 'batch_sha256': batch_digest(batch),
              'graph_sha256': world_digest(client.get(f'/worlds/{wid}').json()),
              'reviews': [{'candidate_id': 'water', 'decision': 'approve', 'waypoint_id': 'lobby',
                           'verified_by': 'Surveyor', 'verified_at': '2026-09-19'}]}
    result = client.put(f'/worlds/{wid}/annotations', json={'batch': batch.model_dump(), 'review': review})
    assert result.status_code == 200, result.text
    node = {n['id']: n for n in result.json()['navigationGraph']['nodes']}['water']
    assert node['position'] == [4.5, 0, -1.2]
