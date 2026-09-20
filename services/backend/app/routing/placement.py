"""Deterministic placement of an image observation in the world frame.

A finding the vision model reports at normalised image coordinates (u right, v down, both in
0..1) becomes a ray from the stored camera pose through that pixel, using the query's field of
view and orientation, and is placed where the ray first hits the collision mesh or, without a
mesh (or a hit), where it meets the floor plane. The model never emits coordinates.
"""
import math

import numpy as np

from .heading import rotate

MAX_RANGE = 15.0


def pixel_direction(u, v, image):
    """Unit ray direction in the ARKit camera frame (-Z forward, +Y up, +X right)."""
    fov = image['fovDeg']
    dx = (2*u-1)*math.tan(math.radians(fov['horizontal'])/2)
    dy = (1-2*v)*math.tan(math.radians(fov['vertical'])/2)
    if image.get('orientation', 'landscape') == 'portrait':
        # Image up = camera -X, image right = camera +Y.
        direction = [-dy, dx, -1.0]
    else:
        direction = [dx, dy, -1.0]
    norm = math.sqrt(sum(c*c for c in direction))
    return [c/norm for c in direction]


def world_ray(pose, u, v, image):
    origin = list(pose['position'])
    return origin, rotate(pixel_direction(u, v, image), pose['rotation'])


def hit_floor(origin, direction, floor_y):
    if direction[1] > -1e-6:
        return None
    t = (floor_y-origin[1])/direction[1]
    if not 0 < t <= MAX_RANGE:
        return None
    return [origin[i]+t*direction[i] for i in range(3)]


def hit_mesh(mesh, origin, direction):
    """Nearest triangle hit within range (vectorised Möller–Trumbore; no spatial index needed)."""
    triangles = np.asarray(mesh.triangles, dtype=float)
    if triangles.shape[0] == 0:
        return None
    o, d = np.asarray(origin, dtype=float), np.asarray(direction, dtype=float)
    v0, v1, v2 = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    e1, e2 = v1-v0, v2-v0
    p = np.cross(d, e2)
    det = np.einsum('ij,ij->i', e1, p)
    ok = np.abs(det) > 1e-9
    inv = np.zeros_like(det)
    inv[ok] = 1/det[ok]
    s = o-v0
    u = np.einsum('ij,ij->i', s, p)*inv
    q = np.cross(s, e1)
    v = np.einsum('j,ij->i', d, q)*inv
    t = np.einsum('ij,ij->i', e2, q)*inv
    ok &= (u >= 0) & (v >= 0) & (u+v <= 1) & (t > 1e-6) & (t <= MAX_RANGE)
    if not ok.any():
        return None
    nearest = t[ok].min()
    return (o+nearest*d).tolist()


def place(pose, u, v, image, mesh=None, floor_y=None):
    """Position plus how it was found: {'method': 'mesh' | 'floor', 'distanceMetres'} or None."""
    if image.get('fovDeg') is None:
        return None
    origin, direction = world_ray(pose, u, v, image)
    if mesh is not None:
        point = hit_mesh(mesh, origin, direction)
        if point is not None:
            return {'position': [round(c, 3) for c in point], 'method': 'mesh',
                    'distanceMetres': round(math.dist(origin, point), 2)}
    if floor_y is not None:
        point = hit_floor(origin, direction, floor_y)
        if point is not None:
            return {'position': [round(c, 3) for c in point], 'method': 'floor',
                    'distanceMetres': round(math.dist(origin, point), 2)}
    return None
