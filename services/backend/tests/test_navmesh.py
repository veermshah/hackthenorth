import math

import numpy as np
import pytest
import trimesh

from ..app.routing.navmesh import Occupancy, Params, build_graph, load_mesh, validate


def box(size, centre):
    mesh = trimesh.creation.box(extents=size)
    mesh.apply_translation(centre)
    return mesh


@pytest.fixture(scope='module')
def room():
    """10 m × 6 m room, floor at y = 0.2, ceiling at 2.7, a wall across the middle with a 1.4 m door
    gap and a table in the west half. Walls are 0.2 m thick boxes."""
    parts = [
        box((10.4, 0.1, 6.4), (0, 0.15, 0)),                # floor slab (top at 0.2)
        box((10.4, 0.1, 6.4), (0, 2.75, 0)),                # ceiling
        box((0.2, 2.5, 6.4), (-5.1, 1.45, 0)),              # west wall
        box((0.2, 2.5, 6.4), (5.1, 1.45, 0)),               # east wall
        box((10.4, 2.5, 0.2), (0, 1.45, -3.1)),             # north wall
        box((10.4, 2.5, 0.2), (0, 1.45, 3.1)),              # south wall
        box((0.2, 2.5, 2.3), (0, 1.45, -1.85)),             # divider, north part (door gap -0.7..0.7)
        box((0.2, 2.5, 2.3), (0, 1.45, 1.85)),              # divider, south part
        box((1.2, 0.05, 0.8), (-3, 0.95, 1.5)),             # table top
    ]
    return trimesh.util.concatenate(parts)


@pytest.fixture(scope='module')
def occupancy(room):
    return Occupancy(room, Params(cell=0.1, spacing=1.0))


def test_floor_height_and_walkable_area(occupancy):
    assert occupancy.floor_y == pytest.approx(0.2, abs=0.03)
    walkable_m2 = occupancy.walkable.sum() * occupancy.params.cell ** 2
    # Room is 60 m²; radius erosion trims ~0.3 m off every wall and the divider, table removes ~1 m².
    assert 35 < walkable_m2 < 56
    # The doorway is walkable, the wall beside it is not.
    door = occupancy.cell_of([0, 0.2, 0])
    wall = occupancy.cell_of([0, 0.2, 2])
    assert occupancy.walkable[door[1], door[0]]
    assert occupancy.blocked[wall[1], wall[0]]
    assert not occupancy.walkable[wall[1], wall[0]]


def test_generated_graph_connects_both_halves_through_the_door(occupancy):
    graph = build_graph(occupancy)
    assert len(graph['nodes']) >= 8
    assert graph['edges']
    positions = {n['id']: n['position'] for n in graph['nodes']}
    assert any(p[0] < -2 for p in positions.values()) and any(p[0] > 2 for p in positions.values())
    for node in graph['nodes']:
        assert node['position'][1] == pytest.approx(0.2, abs=0.05)
    # Every edge is clear of walls by construction.
    issues, _ = validate(occupancy, graph)
    assert [i for i in issues if i['kind'] == 'edge-through-wall'] == []
    # Connected: BFS from the first node reaches all nodes.
    adjacency = {n['id']: set() for n in graph['nodes']}
    for e in graph['edges']:
        adjacency[e['from']].add(e['to'])
        adjacency[e['to']].add(e['from'])
    seen, stack = set(), [graph['nodes'][0]['id']]
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        stack.extend(adjacency[node])
    assert seen == set(adjacency)


def test_validator_flags_wall_crossing_and_snaps_floating_nodes(occupancy):
    graph = {
        'nodes': [
            {'id': 'w', 'kind': 'waypoint', 'position': [-2, 1.5, 2]},       # floating 1.3 m above the floor
            {'id': 'e', 'kind': 'waypoint', 'position': [2, 0.2, 2]},
            {'id': 'door', 'kind': 'waypoint', 'position': [0, 0.2, 0]},
            {'id': 'out', 'kind': 'waypoint', 'position': [20, 0.2, 20]},    # outside the scan
        ],
        'edges': [
            {'from': 'w', 'to': 'e'},          # straight through the divider
            {'from': 'w', 'to': 'door'},       # around it: fine
            {'from': 'door', 'to': 'e'},
        ],
    }
    issues, snapped = validate(occupancy, graph)
    kinds = {(i['kind'], i.get('node') or (i.get('from'), i.get('to'))) for i in issues}
    assert ('edge-through-wall', ('w', 'e')) in kinds
    assert ('node-height', 'w') in kinds
    assert ('node-off-floor', 'out') in kinds
    assert ('edge-through-wall', ('w', 'door')) not in kinds
    assert ('edge-through-wall', ('door', 'e')) not in kinds
    by_id = {n['id']: n for n in snapped['nodes']}
    assert by_id['w']['position'][1] == pytest.approx(0.2, abs=0.03)
    assert by_id['out']['position'] == [20, 0.2, 20]


def test_summary_rows_match_grid(occupancy):
    summary = occupancy.summary()
    assert len(summary['rows']) == summary['height']
    assert all(len(row) == summary['width'] for row in summary['rows'])
    assert summary['walkableCells'] == sum(row.count('.') for row in summary['rows'])


def test_load_mesh_applies_splat_alignment(tmp_path, room):
    path = tmp_path / 'mesh.glb'
    room.export(path)
    alignment = {'frame': 'niantic-vps', 'position': [10, 1, -4],
                 'rotation': [0, math.sin(math.pi / 4), 0, math.cos(math.pi / 4)], 'scale': 2}
    mesh = load_mesh(path, alignment, frame='splat')
    # A 90° yaw about +Y maps +X to -Z; extents double; centre moves to the alignment position.
    extents = mesh.bounds[1] - mesh.bounds[0]
    assert extents[0] == pytest.approx(6.4 * 2, abs=1e-3)
    assert extents[2] == pytest.approx(10.4 * 2, abs=1e-3)
    assert np.allclose(mesh.bounds.mean(axis=0), [10, 1 + 1.45 * 2, -4], atol=0.05)
    world = load_mesh(path)
    assert np.allclose(world.bounds, room.bounds, atol=1e-4)


def test_params_reject_nonsense():
    with pytest.raises(ValueError):
        Params.parse({'cell': -1})
    with pytest.raises(ValueError):
        Params.parse({'cell': 0.5, 'spacing': 0.5})
    assert Params.parse({'spacing': 2}).spacing == 2


def test_seed_zero_is_the_default_the_viewer_sends():
    assert Params.parse({'seed': 0}).seed == 0
    assert Params.parse({'seed': 7.0}).seed == 7
    for bad in (-1, 1.5, True):
        with pytest.raises(ValueError):
            Params.parse({'seed': bad})


def test_empty_floor_never_becomes_walkable():
    from ..app.routing.navmesh import largest_component
    assert not largest_component(np.zeros((12, 12), dtype=bool)).any()
    grid = Occupancy(box((2, .1, 2), (0, -.05, 0)), Params(agentRadius=3))
    assert not grid.walkable.any()
    assert build_graph(grid) == {'frame': 'world', 'nodes': [], 'edges': []}


def test_clearance_expansion_stops_when_grid_is_covered(monkeypatch):
    from ..app.routing import navmesh
    calls = []
    original = navmesh.dilate
    def count(mask):
        calls.append(1)
        return original(mask)
    monkeypatch.setattr(navmesh, 'dilate', count)
    mask = np.zeros((15, 15), dtype=bool)
    mask[7, 7] = True
    distance = navmesh.distance_to(mask)
    assert distance[0, 0] == 7 and distance[7, 7] == 0
    assert len(calls) <= 8


def test_floor_triangles_fill_sampling_holes_without_bridging_real_gaps(monkeypatch):
    # Use no surface samples: the floor triangles themselves must support the walking area.
    monkeypatch.setattr(Occupancy, 'sample', staticmethod(lambda mesh, params: (mesh.vertices, mesh.vertex_normals)))
    floor = trimesh.util.concatenate([box((3, .1, 4), (-2, -.05, 0)), box((3, .1, 4), (2, -.05, 0))])
    grid = Occupancy(floor, Params(cell=.1))
    x, z = grid.cell_of([0, 0, 0])
    assert not grid.floor[z, x]  # the metre-wide unscanned gap is never filled
    assert grid.walkable.sum() * .01 > 7
    assert grid.excluded_cells > 0  # disconnected floor is reported, not silently advertised as reachable


def test_open_room_graph_is_sparse_and_has_no_duplicate_junctions():
    grid = Occupancy(box((6, .1, 6), (0, -.05, 0)), Params())
    graph = build_graph(grid)
    # Retain coverage across the room without the original 19-dot / 45-link lattice.
    assert 4 <= len(graph['nodes']) <= 12
    assert len(graph['edges']) <= len(graph['nodes']) * 2
    positions = [tuple(n['position']) for n in graph['nodes']]
    assert len(set(positions)) == len(positions)
    assert max(p[0] for p in positions) - min(p[0] for p in positions) > 3
    assert max(p[2] for p in positions) - min(p[2] for p in positions) > 3
    assert validate(grid, graph)[0] == []
    assert graph == build_graph(grid)


def test_named_places_keep_ids_and_connect_through_clear_floor(occupancy):
    from ..app.routing.navmesh import preserve_places
    graph = build_graph(occupancy)
    original = {'nodes': [
        {'id': 'start', 'name': 'Entrance', 'kind': 'entrance', 'floor': 'G', 'position': [-2, .2, 0]},
        {'id': 'desk', 'name': 'Desk', 'kind': 'destination', 'floor': 'G', 'position': [2, .2, 0]},
    ], 'edges': []}
    reports = preserve_places(occupancy, graph, original)
    assert all(p['connected'] for p in reports)
    assert all(p['movedMetres'] <= .15 for p in reports)
    assert all(n['floor'] == 'G' for n in graph['nodes'])
    assert validate(occupancy, graph)[0] == []
    adjacency = {n['id']: set() for n in graph['nodes']}
    for e in graph['edges']:
        adjacency[e['from']].add(e['to'])
        adjacency[e['to']].add(e['from'])
    seen, queue = set(), ['start']
    while queue:
        key = queue.pop()
        if key not in seen:
            seen.add(key)
            queue.extend(adjacency[key])
    assert 'desk' in seen


def test_unreachable_places_are_kept_without_inventing_a_wall_crossing(occupancy):
    from ..app.routing.navmesh import preserve_places
    graph = build_graph(occupancy)
    places = [{'id': 'wall', 'name': 'In wall', 'position': [0, .2, 2]},
              {'id': 'outside', 'kind': 'destination', 'position': [50, .2, 50]}]
    reports = preserve_places(occupancy, graph, {'nodes': places, 'edges': []})
    assert not any(p['connected'] for p in reports)
    assert all(p in graph['nodes'] for p in places)
    assert not any(e['from'] in ('wall', 'outside') or e['to'] in ('wall', 'outside') for e in graph['edges'])


def test_place_at_generated_junction_reuses_it_and_avoids_id_collisions(occupancy):
    from ..app.routing.navmesh import preserve_places
    graph = build_graph(occupancy)
    position = graph['nodes'][0]['position']
    count = len(graph['nodes'])
    original = {'nodes': [{'id': 'gen-001', 'name': 'Reception', 'kind': 'destination', 'position': position}], 'edges': []}
    reports = preserve_places(occupancy, graph, original)
    assert reports[0]['connected']
    assert len(graph['nodes']) == count
    ids = [n['id'] for n in graph['nodes']]
    assert len(ids) == len(set(ids))
    assert all(e['from'] != e['to'] and e['from'] in ids and e['to'] in ids for e in graph['edges'])


def test_generator_does_not_replace_vertical_or_restricted_routes(occupancy):
    from ..app.routing.navmesh import preserve_places
    for edge in ({'kind': 'stairs'}, {'accessible': False}, {'bidirectional': False}):
        with pytest.raises(ValueError, match='restricted paths'):
            preserve_places(occupancy, build_graph(occupancy), {'nodes': [], 'edges': [edge]})
    with pytest.raises(ValueError, match='single-floor'):
        preserve_places(occupancy, build_graph(occupancy), {'nodes': [{'floor': '1'}, {'floor': '2'}], 'edges': []})


def test_validator_checks_body_clearance_not_just_wall_intersection(occupancy):
    zs, xs = np.nonzero(occupancy.floor & ~occupancy.blocked & ~occupancy.walkable)
    x, z = occupancy.centre(int(xs[0]), int(zs[0]))
    graph = {'nodes': [{'id': 'tight', 'position': [x, occupancy.floor_y, z]}], 'edges': []}
    assert any(i['kind'] == 'node-clearance' for i in validate(occupancy, graph)[0])


def test_line_clearance_is_direction_independent_and_does_not_cut_corners():
    from ..app.routing.navmesh import supercover
    for x in range(-8, 9):
        for z in range(-8, 9):
            assert set(supercover((0, 0), (x, z))) == set(supercover((x, z), (0, 0)))
    assert set(supercover((0, 0), (1, 1))) == {(0, 0), (1, 0), (0, 1), (1, 1)}
