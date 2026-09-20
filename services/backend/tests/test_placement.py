"""Image point + stored camera pose → world position, without the model ever emitting coordinates."""
import math

import pytest
import trimesh

from ..app.routing.placement import MAX_RANGE, pixel_direction, place

LANDSCAPE = {'width': 640, 'height': 480, 'orientation': 'landscape', 'fovDeg': {'horizontal': 60, 'vertical': 45}}
PORTRAIT = {**LANDSCAPE, 'width': 480, 'height': 640, 'orientation': 'portrait'}
CAMERA = {'position': [0, 1.5, 0], 'rotation': [0, 0, 0, 1]}  # identity: looking down -Z


def test_pixel_directions_follow_the_contract_orientation_rules():
    assert pixel_direction(0.5, 0.5, LANDSCAPE) == pytest.approx([0, 0, -1])
    # Landscape: image right = camera +X, image down = camera -Y.
    right = pixel_direction(1, 0.5, LANDSCAPE)
    down = pixel_direction(0.5, 1, LANDSCAPE)
    assert right[0] > 0 and abs(right[1]) < 1e-9 and down[1] < 0 and abs(down[0]) < 1e-9
    # Portrait: image up = camera -X, image right = camera +Y, so image-left points at the floor (-Y).
    up = pixel_direction(0.5, 0, PORTRAIT)
    left = pixel_direction(0, 0.5, PORTRAIT)
    assert up[0] < 0 and abs(up[1]) < 1e-9 and left[1] < 0 and abs(left[0]) < 1e-9


def test_floor_plane_fallback_places_the_bottom_of_the_frame_ahead_of_the_camera():
    hit = place(CAMERA, 0.5, 1, LANDSCAPE, mesh=None, floor_y=0)
    expected_z = -1.5 / math.tan(math.radians(22.5))
    assert hit['method'] == 'floor'
    assert hit['position'] == pytest.approx([0, 0, expected_z], abs=1e-3)
    assert hit['distanceMetres'] == pytest.approx(math.hypot(1.5, expected_z), abs=1e-2)


def test_rays_that_miss_everything_are_not_placed():
    assert place(CAMERA, 0.5, 0, LANDSCAPE, mesh=None, floor_y=0) is None  # looks up
    far = {'position': [0, MAX_RANGE * 2, 0], 'rotation': [0, 0, 0, 1]}
    assert place(far, 0.5, 1, LANDSCAPE, mesh=None, floor_y=0) is None  # floor beyond range
    assert place(CAMERA, 0.5, 0.5, {**LANDSCAPE, 'fovDeg': None}, mesh=None, floor_y=0) is None


def test_mesh_hit_wins_over_the_floor_plane():
    wall = trimesh.creation.box(extents=[4, 3, 0.2])
    wall.apply_translation([0, 1.5, -3])
    hit = place(CAMERA, 0.5, 1, LANDSCAPE, mesh=wall, floor_y=0)
    assert hit['method'] == 'mesh'
    assert hit['position'][2] == pytest.approx(-2.9, abs=1e-3)
    assert 0 < hit['position'][1] < 1.5
    # Rotate the camera to face +X: the wall is no longer in view, so the floor catches the ray.
    facing_x = {'position': [0, 1.5, 0], 'rotation': [0, -math.sin(math.pi / 4), 0, math.cos(math.pi / 4)]}
    hit = place(facing_x, 0.5, 1, LANDSCAPE, mesh=wall, floor_y=0)
    assert hit['method'] == 'floor' and hit['position'][0] > 0 and abs(hit['position'][2]) < 1e-3
