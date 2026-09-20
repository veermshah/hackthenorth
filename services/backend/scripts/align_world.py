"""Solve a world's splat-to-VPS alignment from matched points and PATCH it.

Stand at two or more spots, note the VPS pose the phone reports there (the
web viewer's Live tab, or the localizations index), and pick the same spots
on the splat in the viewer. Feed the pairs here:

    python -m services.backend.scripts.align_world hotelroom \
        --pair SPLAT_X,SPLAT_Y,SPLAT_Z=VPS_X,VPS_Y,VPS_Z \
        --pair ... [--apply]

The transform is rigid with unit scale: a rotation about the vertical axis
plus a translation, which is what two gravity-aligned scans of the same room
differ by. `--apply` PATCHes the world and rebuilds its occupancy grid; without
it the solved alignment and residuals are only printed.
"""
import argparse
import json
import math
import os
import sys
import urllib.request

import numpy as np


def solve(splat_points, vps_points):
    """Rotation about y and translation mapping splat -> vps (least squares)."""
    s = np.asarray(splat_points, dtype=np.float64)
    v = np.asarray(vps_points, dtype=np.float64)
    if len(s) < 2:
        raise SystemExit('Need at least two pairs')
    sc, vc = s.mean(axis=0), v.mean(axis=0)
    ds, dv = s - sc, v - vc
    # 2D Procrustes on the horizontal plane (x, z).
    a = ds[:, [0, 2]]
    b = dv[:, [0, 2]]
    h = a.T @ b
    u, _, wt = np.linalg.svd(h)
    r2 = wt.T @ u.T
    if np.linalg.det(r2) < 0:
        wt[-1] *= -1
        r2 = wt.T @ u.T
    theta = math.atan2(r2[1, 0], r2[0, 0])  # rotation from splat xz to vps xz
    # Quaternion for a rotation about +y by theta (xyzw). In the x,z plane a +y
    # rotation maps (x, z) -> (x cos + z sin, -x sin + z cos); match the sign.
    def rotate(points, angle):
        c, s_ = math.cos(angle), math.sin(angle)
        out = points.copy()
        out[:, 0] = c * points[:, 0] + s_ * points[:, 2]
        out[:, 2] = -s_ * points[:, 0] + c * points[:, 2]
        return out
    best = None
    for angle in (theta, -theta):
        rotated = rotate(ds, angle)
        residual = np.linalg.norm((rotated[:, [0, 2]] - dv[:, [0, 2]]), axis=1).mean()
        if best is None or residual < best[0]:
            best = (residual, angle)
    _, angle = best
    rotation = [0.0, math.sin(angle / 2), 0.0, math.cos(angle / 2)]
    position = vc - rotate(sc[None, :], angle)[0]
    applied = rotate(s, angle) + position
    residuals = np.linalg.norm(applied - v, axis=1)
    return {'frame': 'niantic-vps', 'position': [float(x) for x in position],
            'rotation': rotation, 'scale': 1.0}, residuals, math.degrees(angle)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('world')
    parser.add_argument('--pair', action='append', required=True, help='sx,sy,sz=vx,vy,vz (splat=vps)')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--base', default=os.environ.get('WANDER_BACKEND_URL', 'https://veermshah--htn-navigation-backend-fastapi-app.modal.run'))
    parser.add_argument('--key', default=os.environ.get('WANDER_API_KEY', ''))
    args = parser.parse_args()
    splat, vps = [], []
    for pair in args.pair:
        left, right = pair.split('=')
        splat.append([float(x) for x in left.split(',')])
        vps.append([float(x) for x in right.split(',')])
    alignment, residuals, degrees = solve(splat, vps)
    print('alignment:', json.dumps(alignment))
    print(f'rotation about vertical: {degrees:.1f} deg; residual per pair (m): {np.round(residuals, 2).tolist()}')
    if not args.apply:
        return
    if not args.key:
        sys.exit('Set WANDER_API_KEY or pass --key to apply')
    body = json.dumps({'alignment': alignment}).encode()
    for method, path in (('PATCH', f'/worlds/{args.world}'), ('GET', f'/worlds/{args.world}/occupancy?rebuild=1')):
        request = urllib.request.Request(args.base + path, data=body if method == 'PATCH' else None, method=method,
                                         headers={'X-API-Key': args.key, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=180) as response:
            result = json.load(response)
        print(method, path, '->', {k: result.get(k) for k in ('id', 'alignment', 'count')})


if __name__ == '__main__':
    main()
