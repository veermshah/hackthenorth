"""World heading convention and horizontal geometry shared by routing and progress.

Headings are degrees clockwise viewed from above with 0 = -Z, 90 = +X (the direction an
ARKit camera faces when its rotation is the identity). Graph nodes sit on the floor and the
chest phone is about 1.3 m above it, so every threshold uses horizontal (XZ) distance.
The legacy `/legacy` contract keeps its documented 0 = +Z heading; `legacy_heading` converts.
"""
import math


def rotate(point, quaternion):
    x, y, z, w = quaternion
    a, b, c = point
    tx, ty, tz = 2*(y*c-z*b), 2*(z*a-x*c), 2*(x*b-y*a)
    return [a+w*tx+y*tz-z*ty, b+w*ty+z*tx-x*tz, c+w*tz+x*ty-y*tx]


def horizontal(a, b):
    return math.hypot(b[0]-a[0], b[2]-a[2])


def bearing(a, b):
    return math.degrees(math.atan2(b[0]-a[0], -(b[2]-a[2]))) % 360


def yaw(quaternion):
    """Heading of the camera's forward (-Z) axis in the world convention."""
    forward = rotate([0, 0, -1], quaternion)
    if math.hypot(forward[0], forward[2]) < 1e-6:
        return None
    return math.degrees(math.atan2(forward[0], -forward[2])) % 360


def legacy_heading(heading):
    return (heading + 180) % 360


def relative(target, reference):
    """Signed turn in (-180, 180]; positive is clockwise (right)."""
    return (target-reference+180) % 360-180


def turn(angle):
    magnitude = abs(angle)
    if magnitude < 20:
        return 'straight'
    if magnitude >= 160:
        return 'u-turn'
    return ('slight-' if magnitude < 45 else 'sharp-' if magnitude > 120 else '') + ('right' if angle > 0 else 'left')


def phrase(kind, metres):
    distance = f'{metres:.0f} metres' if metres >= 3 else f'{metres:.1f} metres'
    if kind == 'straight':
        return f'Continue straight for {distance}.'
    if kind == 'u-turn':
        return f'Turn around, then continue {distance}.'
    return f"{kind.replace('-', ' ').capitalize()}, then continue {distance}."
