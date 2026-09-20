import Foundation
import simd

/// A vertical ARKit plane (wall, door, cabinet front) in world space. The plane
/// lies in the anchor's local x-z plane; its normal is the local y axis.
struct VerticalPlane: Equatable, @unchecked Sendable {
    var transform: simd_float4x4
    /// Centre of the detected patch, in the anchor's local frame.
    var center: simd_float3
    /// Width along local x and length along local z, in metres.
    var extent: simd_float2
}

/// Obstacle zones for phones without LiDAR.
///
/// ARKit world tracking still produces two things on every iPhone: sparse 3D
/// feature points (`ARFrame.rawFeaturePoints`) and detected vertical planes.
/// This estimator keeps the last half second of feature points, projects them
/// onto a horizontal fan in front of the camera, ignores the floor and anything
/// above head height, and reports the nearest structure per zone. Walls that are
/// too plain to yield feature points are caught by casting three horizontal rays
/// against the vertical planes. It is coarser than LiDAR and blind to plain,
/// texture-free surfaces that ARKit has not yet turned into a plane.
///
/// Orientation is handled with gravity, not the device roll: forward is the
/// camera's optical axis projected onto the horizontal plane and right is its
/// horizontal perpendicular, so the same code works for a portrait chest mount
/// and a shoulder mount.
struct StructureObstacleEstimator {
    var maxRange: Float = 3.0
    /// Closer than this is the wearer's own body, strap or hand.
    var minRange: Float = 0.3
    /// Half-width of the fan examined either side of forward, in degrees.
    var halfFieldDegrees: Float = 35
    /// Points closer than this to forward belong to the centre zone.
    var zoneBoundaryDegrees: Float = 12
    /// Height band relative to the camera: below rejects the floor, above the ceiling and signs.
    var heightBelow: Float = 0.9
    var heightAbove: Float = 0.5
    /// Distinct tracked points needed in a zone, clustered within `clusterDepth`
    /// of the nearest ones, before the zone counts as an obstacle. ARKit emits
    /// stray points with poor depth while the phone moves; a real surface yields
    /// many points at about the same distance.
    var minPointsPerZone = 8
    var clusterDepth: Float = 0.5
    /// How long a tracked point is remembered after ARKit last reported it.
    var window: TimeInterval = 0.6
    /// A zone must test positive in this many of the last `persistenceWindow`
    /// analyses before it is reported, so a burst of noise does not buzz.
    var persistenceRequired = 3
    var persistenceWindow = 5
    var gapColumns = 16

    private struct Tracked { var point: simd_float3; var lastSeen: TimeInterval }
    private var tracked: [UInt64: Tracked] = [:]
    private var hits: [Int] = [0, 0, 0]  // left, centre, right

    /// What the last call saw, for the status line.
    struct Stats: Equatable, Sendable {
        var rawPoints = 0      // points ARKit delivered this frame
        var remembered = 0     // distinct points in the window
        var inFan = 0          // inside the range, height band and fan
        var planes = 0
        var tilted = false     // camera pointing at floor or ceiling; nothing measured
    }
    private(set) var stats = Stats()

    mutating func reset() {
        tracked.removeAll()
        hits = [0, 0, 0]
    }

    /// Convenience for callers without ARKit identifiers: each index is its own point.
    mutating func analyze(points: [simd_float3], planes: [VerticalPlane], cameraTransform: simd_float4x4,
                          timestamp: TimeInterval) -> ObstacleZones {
        analyze(points: points, identifiers: (0..<points.count).map { UInt64($0) }, planes: planes,
                cameraTransform: cameraTransform, timestamp: timestamp)
    }

    mutating func analyze(points: [simd_float3], identifiers: [UInt64], planes: [VerticalPlane],
                          cameraTransform: simd_float4x4, timestamp: TimeInterval) -> ObstacleZones {
        // ARKit reports the same tracked point every frame under a stable id; keep one copy.
        for (index, p) in points.enumerated() {
            let id = index < identifiers.count ? identifiers[index] : UInt64(index) | (1 << 63)
            tracked[id] = Tracked(point: p, lastSeen: timestamp)
        }
        tracked = tracked.filter { timestamp - $0.value.lastSeen <= window }
        stats = Stats(rawPoints: points.count, remembered: tracked.count, inFan: 0, planes: planes.count, tilted: false)

        let camera = simd_make_float3(cameraTransform.columns.3)
        var forward = -simd_make_float3(cameraTransform.columns.2)
        forward.y = 0
        guard simd_length(forward) > 0.2 else {  // pointing at the floor or ceiling
            stats.tilted = true
            hits = [0, 0, 0]
            return .empty
        }
        forward = simd_normalize(forward)
        let right = simd_normalize(simd_cross(forward, simd_float3(0, 1, 0)))

        // Horizontal fan: (bearing in degrees, forward distance) per distinct point.
        var samples: [(bearing: Float, distance: Float)] = []
        for entry in tracked.values {
            let d = entry.point - camera
            if d.y < -heightBelow || d.y > heightAbove { continue }
            let f = simd_dot(d, forward)
            if f < minRange || f > maxRange { continue }
            let bearing = atan2f(simd_dot(d, right), f) * 180 / .pi
            if abs(bearing) > halfFieldDegrees { continue }
            samples.append((bearing, f))
        }
        stats.inFan = samples.count

        // A zone has a surface when enough distinct points sit within `clusterDepth` of its nearest cluster.
        func clusterDistance(_ range: ClosedRange<Float>) -> Float? {
            let d = samples.filter { range.contains($0.bearing) }.map(\.distance).sorted()
            guard d.count >= minPointsPerZone else { return nil }
            for (index, near) in d.enumerated() {
                let inCluster = d[index...].prefix { $0 - near <= clusterDepth }.count
                if inCluster >= minPointsPerZone { return near }
                if d.count - index < minPointsPerZone { break }
            }
            return nil
        }
        let candidates = [
            clusterDistance(-halfFieldDegrees...(-zoneBoundaryDegrees)),
            clusterDistance(-zoneBoundaryDegrees...zoneBoundaryDegrees),
            clusterDistance(zoneBoundaryDegrees...halfFieldDegrees)
        ]

        // Walls: a horizontal ray through the middle of each zone against every vertical plane.
        let rayBearing = (halfFieldDegrees + zoneBoundaryDegrees) / 2
        func planeHit(bearingDegrees: Float) -> Float? {
            let b = bearingDegrees * .pi / 180
            let dir = forward * cosf(b) + right * sinf(b)
            var nearest: Float?
            for plane in planes {
                let normal = simd_normalize(simd_make_float3(plane.transform.columns.1))
                let denominator = simd_dot(dir, normal)
                if abs(denominator) < 1e-3 { continue }
                let origin = simd_make_float3(plane.transform * simd_float4(plane.center, 1))
                let t = simd_dot(origin - camera, normal) / denominator
                if t < minRange || t > maxRange { continue }
                let hit = camera + dir * t
                let local = simd_make_float3(plane.transform.inverse * simd_float4(hit, 1))
                let margin: Float = 0.15
                if abs(local.x - plane.center.x) > plane.extent.x / 2 + margin { continue }
                if abs(local.z - plane.center.z) > plane.extent.y / 2 + margin { continue }
                nearest = min(nearest ?? .infinity, t)
            }
            return nearest
        }
        func merge(_ a: Float?, _ b: Float?) -> Float? {
            switch (a, b) {
            case (nil, nil): nil
            case (let x?, nil): x
            case (nil, let y?): y
            case (let x?, let y?): min(x, y)
            }
        }
        let walls = [planeHit(bearingDegrees: -rayBearing), planeHit(bearingDegrees: 0), planeHit(bearingDegrees: rayBearing)]

        // Persistence: point clusters must survive several analyses; a detected wall is trusted at once.
        var reported: [Float?] = [nil, nil, nil]
        for zone in 0..<3 {
            hits[zone] = candidates[zone] != nil ? min(hits[zone] + 1, persistenceWindow) : max(hits[zone] - 1, 0)
            let stable = hits[zone] >= persistenceRequired ? candidates[zone] : nil
            reported[zone] = merge(stable, walls[zone])
        }
        var zones = ObstacleZones(left: reported[0], center: reported[1], right: reported[2])

        // Clearance profile across the fan; the clearer half is the way to steer.
        var columnClear = [Float](repeating: maxRange, count: gapColumns)
        let columnWidth = 2 * halfFieldDegrees / Float(gapColumns)
        for s in samples {
            let column = min(gapColumns - 1, max(0, Int((s.bearing + halfFieldDegrees) / columnWidth)))
            columnClear[column] = min(columnClear[column], s.distance)
        }
        for column in 0..<gapColumns {
            let bearing = -halfFieldDegrees + (Float(column) + 0.5) * columnWidth
            if let t = planeHit(bearingDegrees: bearing) { columnClear[column] = min(columnClear[column], t) }
        }
        let half = gapColumns / 2
        let leftClear = columnClear[..<half].reduce(0, +) / Float(half)
        let rightClear = columnClear[half...].reduce(0, +) / Float(gapColumns - half)
        zones.gapDirection = max(-1, min(1, (rightClear - leftClear) / maxRange))
        return zones
    }
}
