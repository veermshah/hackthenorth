import gzip
import struct

import numpy as np

from services.backend.app.services.occupancy import build_occupancy as build_full, decode_cells, ray_distance, read_spz_positions


def build_occupancy(spz, world, **overrides):
    """The production defaults only keep furniture-sized structure; the synthetic
    scenes here are tiny, so relax the density and size gates but keep the
    scale filter that removes smears."""
    params = dict(min_points=6, min_neighbors=3, min_component=30)
    params.update(overrides)
    return build_full(spz, world, **params)


def make_spz(points, alphas=None, fractional_bits=12, scales_m=None):
    points = np.asarray(points, dtype=np.float64)
    n = len(points)
    alphas = np.full(n, 255, dtype=np.uint8) if alphas is None else np.asarray(alphas, dtype=np.uint8)
    scales_m = np.full(n, 0.01) if scales_m is None else np.asarray(scales_m, dtype=np.float64)
    packed_scales = np.clip(np.round((np.log(scales_m) + 10.0) * 16.0), 0, 255).astype(np.uint8)
    packed_scales = np.repeat(packed_scales[:, None], 3, axis=1)
    fixed = np.round(points * (1 << fractional_bits)).astype(np.int64) & 0xFFFFFF
    packed = np.stack([fixed & 0xFF, (fixed >> 8) & 0xFF, (fixed >> 16) & 0xFF], axis=-1).astype(np.uint8)
    header = struct.pack('<IIIBBBB', 0x5053474E, 3, n, 0, fractional_bits, 0, 0)
    colours = bytes(n * 3)
    rotations = bytes(n * 4)
    return gzip.compress(header + packed.tobytes() + alphas.tobytes() + colours + packed_scales.tobytes() + rotations)


def wall(x0, x1, y0, y1, z, per_cell=12, cell=0.15):
    xs = np.arange(x0, x1, cell / 3)
    ys = np.arange(y0, y1, cell / 3)
    grid = np.array([(x, y, z) for x in xs for y in ys])
    return np.repeat(grid, max(1, per_cell // 9), axis=0)


def test_spz_round_trip():
    pts = [[1.5, -0.25, -3.0], [-2.0, 0.5, 0.75]]
    positions, alphas = read_spz_positions(make_spz(pts, [255, 10]))
    assert np.allclose(positions, pts, atol=1e-3)
    assert list(alphas) == [255, 10]


def test_wall_ahead_is_hit_and_transparent_and_sparse_points_are_ignored():
    world = {'id': 'w', 'version': 'v1', 'alignment': None}
    points = np.vstack([
        wall(-2, 2, -1.2, 1.2, z=-2.0),                    # wall two metres ahead of the origin
        [[0, 0, -0.9]] * 3,                                 # a few stray points: below min_points
        [[0, 0, -1.2]] * 50,                                # a blob, but transparent
    ])
    alphas = np.concatenate([np.full(len(points) - 50, 255), np.full(50, 5)])
    grid = build_occupancy(make_spz(points, alphas), world)
    assert grid['count'] > 0
    assert ray_distance(grid, [0, 0, 0], [0, 0, -1], 4.0) == pytest_approx(2.0, 0.16)
    assert ray_distance(grid, [0, 0, 0], [0, 0, 1], 4.0) is None
    assert ray_distance(grid, [0, 0, 0], [1, 0, 0], 4.0) is None


def test_alignment_moves_the_splat_into_the_world_frame():
    # Splat wall at z=-2; alignment shifts everything +1 in z, so the wall sits at z=-1 in the world.
    world = {'id': 'w', 'version': 'v1',
             'alignment': {'frame': 'niantic-vps', 'position': [0, 0, 1], 'rotation': [0, 0, 0, 1], 'scale': 1}}
    grid = build_occupancy(make_spz(wall(-2, 2, -1.2, 1.2, z=-2.0)), world)
    assert grid['frame'] == 'niantic-vps'
    assert ray_distance(grid, [0, 0, 0], [0, 0, -1], 4.0) == pytest_approx(1.0, 0.16)


def test_cells_decode_to_int32():
    grid = build_occupancy(make_spz(wall(-1, 1, -1, 1, z=-1.0)), {'id': 'w', 'version': 'v1'})
    cells = decode_cells(grid)
    assert cells.dtype == np.int32 and len(cells) == grid['count']


def pytest_approx(value, tolerance):
    import pytest
    return pytest.approx(value, abs=tolerance)


def test_smeared_floaters_and_small_clusters_are_dropped():
    world = {'id': 'w', 'version': 'v1', 'alignment': None}
    solid_wall = wall(-2, 2, -1.2, 1.2, z=-2.0)
    # A dense mid-air blob made of huge gaussians: a smear hanging in the room.
    smear = np.repeat([[0.0, 0.2, -1.0]], 40, axis=0) + np.random.default_rng(1).normal(0, 0.02, (40, 3))
    # A tiny but dense isolated blob of small gaussians: noise.
    speck = np.repeat([[0.5, 0.0, -0.8]], 40, axis=0) + np.random.default_rng(2).normal(0, 0.02, (40, 3))
    points = np.vstack([solid_wall, smear, speck])
    scales = np.concatenate([np.full(len(solid_wall), 0.01), np.full(40, 0.8), np.full(40, 0.01)])
    grid = build_occupancy(make_spz(points, scales_m=scales), world)
    assert ray_distance(grid, [0, 0, 0], [0, 0, -1], 4.0) == pytest_approx(2.0, 0.16), 'the wall survives'
    assert ray_distance(grid, [0, 0.2, 0], [0, 0, -1], 1.5) is None, 'the smear is gone'
    assert ray_distance(grid, [0.5, 0, 0], [0, 0, -1], 1.5) is None, 'the speck is gone'


def test_scale_gate_is_applied_in_world_metres():
    # Raw gaussians of 0.05 m pass the 0.08 m gate unscaled, but a 2x alignment makes them 0.10 m smears.
    solid_wall = wall(-2, 2, -1.2, 1.2, z=-2.0)
    spz = make_spz(solid_wall, scales_m=np.full(len(solid_wall), 0.05))
    unscaled = build_occupancy(spz, {'id': 'w', 'version': 'v1', 'alignment': None})
    assert unscaled['count'] > 0
    scaled = {'id': 'w', 'version': 'v1',
              'alignment': {'frame': 'niantic-vps', 'position': [0, 0, 0], 'rotation': [0, 0, 0, 1], 'scale': 2}}
    import pytest
    with pytest.raises(ValueError, match='no opaque points'):
        build_occupancy(spz, scaled)


def test_prune_does_not_wrap_across_grid_edges():
    from services.backend.app.services.occupancy import prune
    size = np.array([1, 4, 5])
    # Two 2x2 blocks at opposite k edges of adjacent rows: they touch only via
    # flat-index wraparound (1, 4) + 1 == (2, 0), never geometrically.
    a = [j * 5 + k for j in (0, 1) for k in (3, 4)]
    b = [j * 5 + k for j in (2, 3) for k in (0, 1)]
    occupied = np.array(a + b, dtype=np.int64)
    # Support: each cell in a 2x2 block has exactly 3 in-block neighbours.
    kept = prune(occupied, size, min_neighbors=3, min_component=4)
    assert sorted(kept.tolist()) == sorted(a + b)
    # A single 2x2 block is 4 cells; if wraparound merged the blocks into 8 they would survive a threshold of 5.
    assert len(prune(occupied, size, min_neighbors=3, min_component=5)) == 0


def test_cached_grid_reports_builder_version():
    from services.backend.app.services.occupancy import BUILDER
    grid = build_occupancy(make_spz(wall(-1, 1, -1, 1, z=-1.0)), {'id': 'w', 'version': 'v1'})
    assert grid['builder'] == BUILDER
