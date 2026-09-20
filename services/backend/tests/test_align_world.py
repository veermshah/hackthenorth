import math

import numpy as np

from services.backend.scripts.align_world import solve


def test_solve_recovers_rotation_and_translation():
    # VPS frame = splat rotated 30 deg about y and shifted by (1.5, 0.2, -0.7).
    angle = math.radians(30)
    c, s = math.cos(angle), math.sin(angle)
    splat = np.array([[0, 0, 0], [2, 0, 0], [0, 0, 3], [2, 0.1, 3]], dtype=float)
    vps = np.stack([c * splat[:, 0] + s * splat[:, 2], splat[:, 1], -s * splat[:, 0] + c * splat[:, 2]], axis=1)
    vps += [1.5, 0.2, -0.7]
    alignment, residuals, degrees = solve(splat, vps)
    assert abs(degrees - 30) < 0.01
    assert residuals.max() < 0.01
    assert np.allclose(alignment['position'], [1.5, 0.2, -0.7], atol=0.01)
    q = alignment['rotation']
    assert abs(sum(x * x for x in q) - 1) < 1e-6
