"""Walkable floor from an aligned mesh: occupancy grid → clearance → waypoint graph.

Deterministic geometry only. The mesh (a Scaniverse `.glb`, single floor, world frame or
splat frame + `alignment`) is sampled onto an XZ grid; a cell is *floor* when an up-facing
surface sits near the floor height and *blocked* when anything solid occupies the band a
person walks through. The walkable set is eroded by the agent radius, its largest connected
component keeps only reachable space (discarded area is reported), and clearance-centred
waypoints are joined by a sparse visibility graph with redundant detours removed. The
same grid validates hand-authored graphs (edges through walls, nodes off the floor) and snaps
node heights onto the floor. Nothing here is authoritative until a human accepts it into
`navigationGraph`.
"""
from __future__ import annotations

import heapq
import math
from collections import deque
from dataclasses import asdict, dataclass

import numpy as np
import trimesh

from .heading import rotate


@dataclass(frozen=True)
class Params:
    cell: float = 0.15
    agentRadius: float = 0.3
    agentHeight: float = 1.8
    stepHeight: float = 0.25
    spacing: float = 1.5
    floorSlopeDeg: float = 30.0
    seed: int = 0

    @classmethod
    def parse(cls, body):
        values = {}
        for field, default in asdict(cls()).items():
            if field in body:
                value = body[field]
                if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                    raise ValueError(f'{field} must be a number')
                if field == 'seed':
                    if value < 0 or value != int(value):
                        raise ValueError('seed must be a non-negative integer')
                    values[field] = int(value)
                else:
                    if value <= 0:
                        raise ValueError(f'{field} must be a positive number')
                    values[field] = float(value)
        params = cls(**values)
        if not 0.05 <= params.cell <= 1:
            raise ValueError('cell must be between 0.05 and 1 metre')
        if params.spacing < params.cell * 2:
            raise ValueError('spacing must be at least two cells')
        if params.stepHeight >= params.agentHeight:
            raise ValueError('stepHeight must be below agentHeight')
        return params


def load_mesh(path, alignment=None, frame='world'):
    """Load a mesh as a single Trimesh in the world frame."""
    mesh = trimesh.load(str(path), force='mesh')
    if not isinstance(mesh, trimesh.Trimesh) or mesh.faces.shape[0] == 0:
        raise ValueError('Mesh has no triangles')
    if frame == 'splat':
        if not alignment:
            raise ValueError('Splat-frame mesh requires alignment')
        mesh = mesh.copy()
        matrix = np.eye(4)
        matrix[:3, :3] = np.column_stack([rotate(axis, alignment['rotation']) for axis in np.eye(3)]) * alignment['scale']
        matrix[:3, 3] = alignment['position']
        mesh.apply_transform(matrix)
    return mesh


class Occupancy:
    """XZ grid of floor / blocked cells plus per-cell floor heights."""

    def __init__(self, mesh, params: Params):
        self.params = params
        cell = params.cell
        samples = self.sample(mesh, params)
        self.floor_y = self.floor_height(mesh, samples, params)

        low = mesh.bounds[0]
        high = mesh.bounds[1]
        self.origin = (float(low[0]) - cell, float(low[2]) - cell)
        self.width = int(math.ceil((high[0] - low[0]) / cell)) + 3
        self.height = int(math.ceil((high[2] - low[2]) / cell)) + 3
        if self.width * self.height > 4_000_000:
            raise ValueError('Mesh footprint is too large for this cell size')

        points, normals = samples
        ix, iz = self.index(points[:, 0], points[:, 2])
        inside = (ix >= 0) & (ix < self.width) & (iz >= 0) & (iz < self.height)
        points, normals, ix, iz = points[inside], normals[inside], ix[inside], iz[inside]
        flat = iz * self.width + ix
        size = self.width * self.height

        up = normals[:, 1] > math.cos(math.radians(params.floorSlopeDeg))
        rel = points[:, 1] - self.floor_y
        floorish = up & (rel > -0.3) & (rel < params.stepHeight)
        counts = np.bincount(flat[floorish], minlength=size)
        self.floor = (counts > 0).reshape(self.height, self.width)
        # The floor a foot lands on is the highest up-facing surface in the band (slab tops, not undersides).
        heights = np.full(size, -np.inf)
        np.maximum.at(heights, flat[floorish], points[floorish, 1])
        self.heights = np.where(counts > 0, heights, np.nan).reshape(self.height, self.width)

        self.fill_floor_triangles(mesh)

        solid = (rel > params.stepHeight) & (rel < params.agentHeight)
        self.blocked = (np.bincount(flat[solid], minlength=size) > 0).reshape(self.height, self.width)

        walkable = self.floor & ~self.blocked
        radius_cells = int(math.ceil(params.agentRadius / cell))
        obstacle = ~walkable
        for _ in range(radius_cells):
            obstacle = dilate(obstacle)
        self.walkable = largest_component(~obstacle)
        self.excluded_cells = int((~obstacle & ~self.walkable).sum())
        self.clearance = distance_to(~self.walkable)

    def fill_floor_triangles(self, mesh):
        """Fill observed floor triangles at cell centres; random sampling must not punch holes in slabs.

        Small scan triangles already contribute samples/vertices. Rasterize larger, entirely
        floor-band triangles, without bridging missing geometry or extrapolating a floor plane.
        """
        p = self.params
        triangles = mesh.triangles
        up = mesh.face_normals[:, 1] > math.cos(math.radians(p.floorSlopeDeg))
        band = ((triangles[:, :, 1] > self.floor_y - .3) &
                (triangles[:, :, 1] < self.floor_y + p.stepHeight)).all(axis=1)
        for triangle in triangles[up & band & (mesh.area_faces >= p.cell ** 2)]:
            lo, hi = triangle.min(axis=0), triangle.max(axis=0)
            x0, z0 = self.index(lo[0], lo[2])
            x1, z1 = self.index(hi[0], hi[2])
            zs, xs = np.mgrid[max(0, z0):min(self.height, z1 + 1), max(0, x0):min(self.width, x1 + 1)]
            x, z = self.centre(xs, zs)
            a, b, c = triangle
            denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
            if abs(denominator) < 1e-12:
                continue
            u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator
            v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator
            inside = (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9)
            ys = u * a[1] + v * b[1] + (1 - u - v) * c[1]
            zi, xi = zs[inside], xs[inside]
            self.floor[zi, xi] = True
            self.heights[zi, xi] = np.fmax(self.heights[zi, xi], ys[inside])

    @staticmethod
    def sample(mesh, params):
        count = int(min(max(mesh.area / (params.cell * params.cell) * 6, 20_000), 3_000_000))
        points, faces = trimesh.sample.sample_surface(mesh, count, seed=params.seed)
        points = np.vstack([np.asarray(points), mesh.vertices])
        normals = np.vstack([mesh.face_normals[faces], mesh.vertex_normals])
        return points, normals

    @staticmethod
    def floor_height(mesh, samples, params):
        """Lowest substantial horizontal surface: area-weighted height histogram of up-facing faces."""
        up = mesh.face_normals[:, 1] > math.cos(math.radians(params.floorSlopeDeg))
        if not up.any():
            raise ValueError('Mesh has no horizontal surfaces to use as a floor')
        ys = mesh.triangles_center[up, 1]
        weights = mesh.area_faces[up]
        bins = np.arange(ys.min() - 0.05, ys.max() + 0.1, 0.05)
        histogram, edges = np.histogram(ys, bins=bins, weights=weights)
        candidates = np.flatnonzero(histogram >= histogram.max() * 0.25)
        first = candidates[0]
        centre = (edges[first] + edges[first + 1]) / 2
        near = np.abs(ys - centre) < 0.15
        return float(weighted_median(ys[near], weights[near]))

    def index(self, x, z):
        ix = np.floor((np.asarray(x) - self.origin[0]) / self.params.cell).astype(int)
        iz = np.floor((np.asarray(z) - self.origin[1]) / self.params.cell).astype(int)
        return ix, iz

    def cell_of(self, position):
        ix, iz = self.index(position[0], position[2])
        ix, iz = int(ix), int(iz)
        if 0 <= ix < self.width and 0 <= iz < self.height:
            return ix, iz
        return None

    def centre(self, ix, iz):
        cell = self.params.cell
        return self.origin[0] + (ix + 0.5) * cell, self.origin[1] + (iz + 0.5) * cell

    def floor_at(self, position, radius=0.5):
        """Floor height under `position`, searching outwards up to `radius` metres; None when there is no floor."""
        cell = self.cell_of(position)
        if cell is None:
            return None
        ix, iz = cell
        reach = int(math.ceil(radius / self.params.cell))
        best = None
        for dz in range(-reach, reach + 1):
            for dx in range(-reach, reach + 1):
                x, z = ix + dx, iz + dz
                if 0 <= x < self.width and 0 <= z < self.height and self.floor[z, x]:
                    distance = math.hypot(dx, dz)
                    if best is None or distance < best[0]:
                        best = (distance, float(self.heights[z, x]))
        return None if best is None else best[1]

    def line_cells(self, a, b):
        """Grid cells crossed by the horizontal segment ab (supercover: no diagonal gaps)."""
        ca, cb = self.cell_of(a), self.cell_of(b)
        if ca is None or cb is None:
            return None
        return supercover(ca, cb)

    def summary(self):
        return {
            'origin': [self.origin[0], self.floor_y, self.origin[1]],
            'cell': self.params.cell,
            'width': self.width,
            'height': self.height,
            'floorY': self.floor_y,
            # One character per cell, rows along +Z: '.' walkable, 'x' blocked or off-floor, ' ' no data.
            'rows': [''.join('.' if w else ('x' if f or b else ' ') for w, f, b in zip(wr, fr, br))
                     for wr, fr, br in zip(self.walkable, self.floor, self.blocked)],
            'walkableCells': int(self.walkable.sum()),
            'floorCells': int(self.floor.sum()),
            'excludedWalkableCells': self.excluded_cells,
        }


def build_graph(occupancy: Occupancy):
    """Waypoint lattice over the walkable grid, linked by line of sight and simplified into corridors."""
    params = occupancy.params
    block = max(2, int(round(params.spacing / params.cell)))
    cells = {}
    for bz in range(0, occupancy.height, block):
        for bx in range(0, occupancy.width, block):
            patch = occupancy.clearance[bz:bz + block, bx:bx + block]
            mask = occupancy.walkable[bz:bz + block, bx:bx + block]
            if not mask.any():
                continue
            # Most clearance wins; ties go to the cell nearest the block centre so lattices stay regular.
            zs, xs = np.indices(patch.shape)
            centre_distance = np.hypot(zs - (patch.shape[0] - 1) / 2, xs - (patch.shape[1] - 1) / 2)
            scores = np.where(mask, patch * 1000 - centre_distance, -np.inf)
            dz, dx = np.unravel_index(int(np.argmax(scores)), scores.shape)
            cells[(bz // block, bx // block)] = (bx + dx, bz + dz)

    keys = sorted(cells)
    adjacency = {key: set() for key in keys}

    def link(a, b):
        if a == b:
            return
        adjacency.setdefault(a, set()).add(b)
        adjacency.setdefault(b, set()).add(a)

    for i, key in enumerate(keys):
        for other in keys[i + 1:]:
            if abs(other[0] - key[0]) > 1 or abs(other[1] - key[1]) > 1:
                continue
            a, b = cells[key], cells[other]
            if clear(occupancy, a, b):
                link(key, other)
                continue
            # Blocked directly (a wall between the blocks): look for a doorway cell both can see.
            portal = find_portal(occupancy, a, b, block)
            if portal is not None:
                # A doorway cell is one junction even when several block pairs discover it.
                portal_key = next((k for k, cell in cells.items() if cell == portal), ('portal', *portal))
                cells[portal_key] = portal
                link(key, portal_key)
                link(portal_key, other)

    cells, adjacency = sparsify(occupancy, cells, adjacency)

    # Corridor simplification: drop a pass-through node when its neighbours see each other nearly in line.
    changed = True
    while changed:
        changed = False
        for key in list(adjacency):
            if len(adjacency[key]) != 2:
                continue
            a, b = adjacency[key]
            if b in adjacency[a]:
                continue
            ca, ck, cb = cells[a], cells[key], cells[b]
            u = (ck[0] - ca[0], ck[1] - ca[1])
            v = (cb[0] - ck[0], cb[1] - ck[1])
            cosine = (u[0] * v[0] + u[1] * v[1]) / (math.hypot(*u) * math.hypot(*v) or 1)
            if cosine > math.cos(math.radians(35)) and clear(occupancy, ca, cb):
                adjacency[a].discard(key)
                adjacency[b].discard(key)
                adjacency[a].add(b)
                adjacency[b].add(a)
                del adjacency[key]
                changed = True

    component = largest_component_keys(adjacency)
    ordered = sorted(component, key=lambda k: (cells[k][1], cells[k][0]))
    ids = {key: f'gen-{i + 1:03d}' for i, key in enumerate(ordered)}
    out_nodes = []
    for key in ordered:
        ix, iz = cells[key]
        x, z = occupancy.centre(ix, iz)
        y = float(occupancy.heights[iz, ix]) if not math.isnan(occupancy.heights[iz, ix]) else occupancy.floor_y
        out_nodes.append({'id': ids[key], 'kind': 'waypoint', 'position': [round(x, 3), round(y, 3), round(z, 3)]})
    positions = {n['id']: n['position'] for n in out_nodes}
    out_edges = []
    for key in ordered:
        for other in sorted(adjacency[key], key=ids.get):
            if ids[key] < ids[other]:
                a, b = positions[ids[key]], positions[ids[other]]
                out_edges.append({'from': ids[key], 'to': ids[other], 'bidirectional': True,
                                  'distance': round(math.hypot(b[0] - a[0], b[2] - a[2]), 3)})
    return {'frame': 'world', 'nodes': out_nodes, 'edges': out_edges}


def sparsify(occupancy, cells, adjacency):
    """Merge nearby junctions, then build a 1.5-spanner of the visible connections.

    Short edges are considered first. Keep an edge only if the existing route is over
    50% longer: this removes triangle clutter while retaining useful loops around obstacles.
    Every replacement segment is checked against the radius-eroded floor.
    """
    order = sorted(adjacency, key=lambda k: (-occupancy.clearance[cells[k][1], cells[k][0]], cells[k]))
    separation = occupancy.params.spacing / occupancy.params.cell * .6
    for keep in order:
        if keep not in adjacency:
            continue
        for remove in sorted(adjacency[keep], key=lambda k: cells[k]):
            if math.dist(cells[keep], cells[remove]) >= separation:
                continue
            neighbours = adjacency[remove] - {keep}
            if not all(clear(occupancy, cells[keep], cells[n]) for n in neighbours):
                continue
            for neighbour in neighbours:
                adjacency[neighbour].discard(remove)
                adjacency[neighbour].add(keep)
            adjacency[keep].discard(remove)
            adjacency[keep].update(neighbours)
            del adjacency[remove]
    ranks = {key: i for i, key in enumerate(adjacency)}
    edges = sorted((math.dist(cells[a], cells[b]), ranks[a], ranks[b], a, b)
                   for a in adjacency for b in adjacency[a] if ranks[a] < ranks[b])
    sparse = {key: set() for key in adjacency}
    for distance, _, _, a, b in edges:
        limit = distance * 1.5
        queue = [(0., ranks[a], a)]
        best = {a: 0.}
        while queue:
            cost, _, key = heapq.heappop(queue)
            if cost > best[key] or cost > limit:
                continue
            if key == b:
                break
            for other in sparse[key]:
                total = cost + math.dist(cells[key], cells[other])
                if total <= limit and total < best.get(other, math.inf):
                    best[other] = total
                    heapq.heappush(queue, (total, ranks[other], other))
        if best.get(b, math.inf) > limit:
            sparse[a].add(b)
            sparse[b].add(a)
    return cells, sparse


def preserve_places(occupancy, generated, original):
    """Retain named places and their IDs; attach only along verified free-floor segments.

    A misplaced or disconnected place stays visible and blocks acceptance. Single-floor
    generation cannot infer restrictions or replace a building's vertical connections.
    """
    floors = {n['floor'] for n in original['nodes'] if n.get('floor') is not None}
    if len(floors) > 1 or any(e.get('kind', 'walk') != 'walk' or e.get('accessible') is False
                              or e.get('bidirectional') is False for e in original['edges']):
        raise ValueError('This generator handles one floor with unrestricted walking paths. '
                         'Keep the existing floor transitions and restricted paths; generate in a single-floor world.')
    places = [n for n in original['nodes'] if n.get('name') or n.get('kind') in ('entrance', 'destination')]
    # Never reuse a destination ID, including names that resemble generated IDs.
    reserved = {n['id'] for n in places}
    rename = {}
    for n in generated['nodes']:
        identifier = n['id']
        while identifier in reserved:
            identifier = 'gen-' + identifier
        reserved.add(identifier)
        rename[n['id']] = identifier
        n['id'] = identifier
        if floors:
            n['floor'] = next(iter(floors))
    for edge in generated['edges']:
        edge['from'], edge['to'] = rename[edge['from']], rename[edge['to']]
    network = list(generated['nodes'])
    reports = []
    for place in places:
        position = place['position']
        cell = occupancy.cell_of(position)
        target = None
        if cell is not None and abs(position[1] - occupancy.floor_y) <= .5:
            # Allow a small adjustment from the boundary to the walking centre, never through solids.
            reach = math.ceil(.75 / occupancy.params.cell)
            candidates = []
            for z in range(max(0, cell[1] - reach), min(occupancy.height, cell[1] + reach + 1)):
                for x in range(max(0, cell[0] - reach), min(occupancy.width, cell[0] + reach + 1)):
                    if not occupancy.walkable[z, x]:
                        continue
                    cx, cz = occupancy.centre(x, z)
                    distance = math.hypot(cx - position[0], cz - position[2])
                    if distance <= .75 and all(occupancy.floor[zz, xx] and not occupancy.blocked[zz, xx]
                                               for xx, zz in supercover(cell, (x, z))):
                        candidates.append((distance, x, z))
            if candidates:
                _, x, z = min(candidates)
                target = (x, z)
        connected = [] if target is None else [n for n in network if clear(occupancy, target, occupancy.cell_of(n['position']))]
        if connected:
            nearest = min(connected, key=lambda n: math.dist(target, occupancy.cell_of(n['position'])))
            x, z = occupancy.centre(*target)
            updated = {**place, 'position': [round(x, 3), round(float(occupancy.heights[target[1], target[0]]), 3), round(z, 3)]}
            if target == occupancy.cell_of(nearest['position']) and nearest['id'] not in {n['id'] for n in places}:
                # Replace a coincident generated waypoint with the place instead of drawing two dots.
                for edge in generated['edges']:
                    for end in ('from', 'to'):
                        if edge[end] == nearest['id']:
                            edge[end] = place['id']
                generated['nodes'].remove(nearest)
                network.remove(nearest)
                generated['nodes'].append(updated)
                network.append(updated)
            else:
                generated['nodes'].append(updated)
                distance = math.dist(updated['position'], nearest['position'])
                generated['edges'].append({'from': place['id'], 'to': nearest['id'], 'bidirectional': True, 'distance': round(distance, 3)})
            reports.append({'id': place['id'], 'name': place.get('name', place['id']), 'connected': True,
                            'movedMetres': round(math.dist(position, updated['position']), 3)})
        else:
            generated['nodes'].append(dict(place))
            reports.append({'id': place['id'], 'name': place.get('name', place['id']), 'connected': False,
                            'movedMetres': 0})
    return reports


def validate(occupancy: Occupancy, graph, snap=True):
    """Check a world-frame graph against the grid; returns issues and a floor-snapped copy."""
    issues = []
    nodes = {}
    for node in graph['nodes']:
        position = list(node['position'])
        cell = occupancy.cell_of(position)
        if cell is None or not occupancy.floor[cell[1], cell[0]]:
            floor_y = occupancy.floor_at(position)
            if floor_y is None:
                issues.append({'kind': 'node-off-floor', 'node': node['id'],
                               'message': 'No floor within 0.5 m of this node'})
            else:
                issues.append({'kind': 'node-edge-of-floor', 'node': node['id'],
                               'message': 'Node sits just off the scanned floor'})
        elif occupancy.blocked[cell[1], cell[0]]:
            issues.append({'kind': 'node-in-obstacle', 'node': node['id'],
                           'message': 'Node is inside a wall or furniture'})
            floor_y = float(occupancy.heights[cell[1], cell[0]])
        else:
            floor_y = float(occupancy.heights[cell[1], cell[0]])
            if not occupancy.walkable[cell[1], cell[0]]:
                issues.append({'kind': 'node-clearance', 'node': node['id'],
                               'message': 'Node lacks walking clearance or is disconnected from the main floor'})
        if floor_y is not None:
            offset = position[1] - floor_y
            if abs(offset) > 0.3:
                issues.append({'kind': 'node-height', 'node': node['id'], 'offsetMetres': round(offset, 3),
                               'message': f'Node is {offset:+.2f} m from the floor'})
            if snap:
                position[1] = round(floor_y, 3)
        nodes[node['id']] = {**node, 'position': position}

    for edge in graph['edges']:
        a, b = nodes.get(edge['from']), nodes.get(edge['to'])
        if not a or not b or edge.get('kind', 'walk') != 'walk':
            continue
        cells = occupancy.line_cells(a['position'], b['position'])
        if cells is None:
            issues.append({'kind': 'edge-off-floor', 'from': edge['from'], 'to': edge['to'],
                           'message': 'Edge leaves the scanned area'})
            continue
        through = [c for c in cells if occupancy.blocked[c[1], c[0]]]
        void = [c for c in cells if not occupancy.floor[c[1], c[0]]]
        if through:
            x, z = occupancy.centre(*through[len(through) // 2])
            issues.append({'kind': 'edge-through-wall', 'from': edge['from'], 'to': edge['to'],
                           'at': [round(x, 3), round(occupancy.floor_y, 3), round(z, 3)],
                           'message': f'Edge passes through {len(through)} blocked cell(s)'})
        elif len(void) > 2:
            x, z = occupancy.centre(*void[len(void) // 2])
            issues.append({'kind': 'edge-off-floor', 'from': edge['from'], 'to': edge['to'],
                           'at': [round(x, 3), round(occupancy.floor_y, 3), round(z, 3)],
                           'message': f'Edge crosses {len(void)} cell(s) with no floor'})
        elif any(not occupancy.walkable[z, x] for x, z in cells):
            issues.append({'kind': 'edge-clearance', 'from': edge['from'], 'to': edge['to'],
                           'message': 'Edge lacks walking clearance or leaves the reachable floor'})
    snapped = {**graph, 'nodes': [nodes[n['id']] for n in graph['nodes']]}
    return issues, snapped


# ------------------------------------------------------------------ grid helpers

def dilate(mask):
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    out[1:, 1:] |= mask[:-1, :-1]
    out[1:, :-1] |= mask[:-1, 1:]
    out[:-1, 1:] |= mask[1:, :-1]
    out[:-1, :-1] |= mask[1:, 1:]
    return out


def distance_to(mask):
    """Chessboard distance (in cells) from every cell to the nearest True cell of `mask`."""
    distance = np.where(mask, 0, np.iinfo(np.int32).max).astype(np.int32)
    frontier = mask.copy()
    step = 0
    while frontier.any() and step < 10_000:
        step += 1
        grown = dilate(frontier) & ~frontier
        distance[grown] = np.minimum(distance[grown], step)
        if not grown.any():
            break
        frontier |= grown
    return distance


def largest_component(mask):
    """Keep only the biggest 4-connected region of True cells."""
    labels = np.zeros(mask.shape, dtype=np.int32)
    best, best_size = 0, 0
    label = 0
    for start in zip(*np.nonzero(mask)):
        if labels[start]:
            continue
        label += 1
        queue = deque([start])
        labels[start] = label
        size = 0
        while queue:
            z, x = queue.popleft()
            size += 1
            for nz, nx in ((z - 1, x), (z + 1, x), (z, x - 1), (z, x + 1)):
                if 0 <= nz < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[nz, nx] and not labels[nz, nx]:
                    labels[nz, nx] = label
                    queue.append((nz, nx))
        if size > best_size:
            best, best_size = label, size
    return (labels == best) if best else np.zeros_like(mask, dtype=bool)


def largest_component_keys(adjacency):
    seen, best = set(), set()
    for start in adjacency:
        if start in seen:
            continue
        component = {start}
        queue = deque([start])
        while queue:
            key = queue.popleft()
            for other in adjacency[key]:
                if other not in component:
                    component.add(other)
                    queue.append(other)
        seen |= component
        if len(component) > len(best):
            best = component
    return best


def supercover(a, b):
    """All cells a segment between two cell centres touches (no corner-cutting)."""
    (x, z), (x1, z1) = a, b
    dx, dz = abs(x1 - x), abs(z1 - z)
    sx, sz = (1 if x1 > x else -1), (1 if z1 > z else -1)
    cells = [(x, z)]
    ix = iz = 0
    # Compare the next boundary-crossing times as integers. Unlike Bresenham's
    # nearest-pixel approximation this visits the same cells in either direction.
    while ix < dx or iz < dz:
        tx, tz = (1 + 2 * ix) * dz, (1 + 2 * iz) * dx
        if tx == tz:
            cells.extend(((x + sx, z), (x, z + sz)))
            x, z = x + sx, z + sz
            ix, iz = ix + 1, iz + 1
        elif tx < tz:
            x += sx
            ix += 1
        else:
            z += sz
            iz += 1
        cells.append((x, z))
    return cells


def clear(occupancy: Occupancy, a, b):
    return all(occupancy.walkable[z, x] for x, z in supercover(a, b))


def find_portal(occupancy: Occupancy, a, b, block):
    """Highest-clearance walkable cell between two lattice cells that both can see (a doorway)."""
    x0, x1 = sorted((a[0], b[0]))
    z0, z1 = sorted((a[1], b[1]))
    best = None
    for z in range(max(0, z0 - block // 2), min(occupancy.height, z1 + block // 2 + 1)):
        for x in range(max(0, x0 - block // 2), min(occupancy.width, x1 + block // 2 + 1)):
            if not occupancy.walkable[z, x]:
                continue
            score = int(occupancy.clearance[z, x])
            if best is not None and score <= best[0]:
                continue
            if clear(occupancy, a, (x, z)) and clear(occupancy, (x, z), b):
                best = (score, (x, z))
    return None if best is None else best[1]


def weighted_median(values, weights):
    order = np.argsort(values)
    cumulative = np.cumsum(weights[order])
    return values[order][int(np.searchsorted(cumulative, cumulative[-1] / 2))]
