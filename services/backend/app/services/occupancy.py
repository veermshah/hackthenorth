"""Static obstacle map from a world's Gaussian splat.

The splat (Niantic .spz) is a dense point set of the scanned space. Voxelising
it gives an occupancy grid in the world frame that a localised phone can ray-cast
against to find walls and furniture in any direction, including where no sensor
is looking. Only the positions and alphas are read from the file.
"""
import base64
import gzip
import math
import struct

import numpy as np

SPZ_MAGIC = 0x5053474E
SCHEMA = 'wander.occupancy/v1'


BUILDER = 4  # bump when the filtering changes so cached grids are rebuilt


def read_spz_positions(data: bytes):
    """Return (positions[N,3] float32, alphas[N] uint8) from an .spz file."""
    positions, alphas, _ = read_spz(data)
    return positions, alphas


def read_spz(data: bytes):
    """Return (positions[N,3] float32, alphas[N] uint8, scales[N,3] float32 metres)."""
    raw = gzip.decompress(data)
    magic, version, count, _sh, fractional_bits, _flags, _ = struct.unpack_from('<IIIBBBB', raw, 0)
    if magic != SPZ_MAGIC:
        raise ValueError('Not an SPZ file')
    if version not in (2, 3):
        raise ValueError(f'Unsupported SPZ version {version}')
    offset = 16
    packed = np.frombuffer(raw, dtype=np.uint8, count=count * 9, offset=offset).reshape(count, 3, 3).astype(np.int32)
    fixed = packed[:, :, 0] | (packed[:, :, 1] << 8) | (packed[:, :, 2] << 16)
    fixed = np.where(fixed & 0x800000, fixed - 0x1000000, fixed)
    positions = (fixed / float(1 << fractional_bits)).astype(np.float32)
    offset += count * 9
    alphas = np.frombuffer(raw, dtype=np.uint8, count=count, offset=offset)
    offset += count            # alphas
    offset += count * 3        # colours
    packed_scales = np.frombuffer(raw, dtype=np.uint8, count=count * 3, offset=offset).reshape(count, 3)
    scales = np.exp(packed_scales.astype(np.float32) / 16.0 - 10.0)  # log-encoded, in metres
    return positions, alphas, scales


def quaternion_rotate(points, q):
    """Rotate points[N,3] by quaternion q = [x, y, z, w]."""
    x, y, z, w = q
    r = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float32)
    return points @ r.T


def build_occupancy(spz: bytes, world: dict, cell_size: float = 0.15, min_alpha: int = 64, min_points: int = 20,
                    trim_percentile: float = 0.5, max_scale: float = 0.08, min_neighbors: int = 8,
                    min_component: int = 300) -> dict:
    """Voxelise the splat into the world frame (alignment applied), keeping only
    solid, well-supported structure:

    * gaussians larger than `max_scale` on any axis are the smeared floaters and
      mid-air streaks a scan leaves behind; real surfaces are made of tiny ones;
    * a cell needs `min_points` opaque points, and `min_neighbors` occupied
      neighbours out of 26, so thin wisps do not count as surfaces;
    * connected clusters smaller than `min_component` cells are dropped as noise;
      at the defaults only walls and furniture-sized structure survive.
    """
    positions, alphas, scales = read_spz(spz)
    alignment = world.get('alignment')
    world_scale = np.float32(alignment['scale']) if alignment else np.float32(1)
    solid = (alphas >= min_alpha) & (scales.max(axis=1) * world_scale <= max_scale)
    positions = positions[solid]
    if alignment:
        positions = quaternion_rotate(positions * np.float32(alignment['scale']), alignment['rotation'])
        positions = positions + np.asarray(alignment['position'], dtype=np.float32)
    if len(positions) == 0:
        raise ValueError('Splat has no opaque points')
    low = np.percentile(positions, trim_percentile, axis=0) - 0.5
    high = np.percentile(positions, 100 - trim_percentile, axis=0) + 0.5
    inside = np.all((positions >= low) & (positions <= high), axis=1)
    positions = positions[inside]
    origin = np.floor(low / cell_size) * cell_size
    size = np.maximum(1, np.ceil((high - origin) / cell_size).astype(np.int64))
    index = np.floor((positions - origin) / cell_size).astype(np.int64)
    index = np.clip(index, 0, size - 1)
    flat = (index[:, 0] * size[1] + index[:, 1]) * size[2] + index[:, 2]
    cells, counts = np.unique(flat, return_counts=True)
    occupied = cells[counts >= min_points].astype(np.int64)
    occupied = prune(occupied, size, min_neighbors=min_neighbors, min_component=min_component).astype(np.int32)
    return {
        'schema': SCHEMA,
        'builder': BUILDER,
        'worldId': world['id'],
        'version': world['version'],
        'frame': (alignment or {}).get('frame', 'splat'),
        'cellSize': cell_size,
        'origin': [float(v) for v in origin],
        'size': [int(v) for v in size],
        'count': int(len(occupied)),
        'minPoints': min_points,
        'encoding': 'int32le-base64',
        'cells': base64.b64encode(occupied.tobytes()).decode('ascii'),
    }


def prune(occupied: np.ndarray, size, min_neighbors: int = 3, min_component: int = 30) -> np.ndarray:
    """Drop cells with too few occupied neighbours, then connected components
    (26-connectivity) smaller than `min_component` cells."""
    if len(occupied) == 0:
        return occupied
    shape = (int(size[0]), int(size[1]), int(size[2]))
    steps = np.array([(di, dj, dk)
                      for di in (-1, 0, 1) for dj in (-1, 0, 1) for dk in (-1, 0, 1)
                      if (di, dj, dk) != (0, 0, 0)], dtype=np.int64)

    def neighbours(cells, step):
        """Flat indices of `cells` shifted by `step`, or -1 where that leaves the grid."""
        ijk = np.stack(np.unravel_index(cells, shape), axis=1) + step
        inside = np.all((ijk >= 0) & (ijk < shape), axis=1)
        flat = np.full(len(cells), -1, dtype=np.int64)
        flat[inside] = np.ravel_multi_index(tuple(ijk[inside].T), shape)
        return flat

    occupied = np.sort(occupied)
    neighbors = np.zeros(len(occupied), dtype=np.int32)
    for step in steps:
        neighbors += np.isin(neighbours(occupied, step), occupied)
    occupied = occupied[neighbors >= min_neighbors]
    if len(occupied) == 0:
        return occupied
    # Connected components by union-find over the neighbour steps.
    index = {int(c): i for i, c in enumerate(occupied)}
    parent = np.arange(len(occupied))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for step in steps[len(steps) // 2:]:  # lexicographically positive half: each pair once
        candidates = neighbours(occupied, step)
        present = np.isin(candidates, occupied)
        for a, b in zip(np.nonzero(present)[0], candidates[present]):
            ra, rb = find(a), find(index[int(b)])
            if ra != rb:
                parent[ra] = rb
    roots = np.array([find(i) for i in range(len(occupied))])
    _, inverse, sizes = np.unique(roots, return_inverse=True, return_counts=True)
    return occupied[sizes[inverse] >= min_component]


def decode_cells(grid: dict) -> np.ndarray:
    return np.frombuffer(base64.b64decode(grid['cells']), dtype=np.int32)


def ray_distance(grid: dict, origin, direction, max_range: float, cells=None) -> float | None:
    """Reference ray march used by tests: distance to the first occupied cell."""
    cells = set(decode_cells(grid).tolist()) if cells is None else cells
    cell = grid['cellSize']
    o = np.asarray(grid['origin'])
    size = grid['size']
    d = np.asarray(direction, dtype=np.float64)
    d = d / np.linalg.norm(d)
    step = cell / 2
    t = 0.0
    while t <= max_range:
        p = np.asarray(origin) + d * t
        i = np.floor((p - o) / cell).astype(int)
        if np.all(i >= 0) and np.all(i < size):
            if int((i[0] * size[1] + i[1]) * size[2] + i[2]) in cells:
                return t
        t += step
    return None
