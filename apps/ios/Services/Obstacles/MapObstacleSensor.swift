import Foundation
import simd

/// An annotated obstacle or hazard from the world's published annotations.
struct MapHazard: Decodable, Equatable, Sendable {
    let id: String
    let name: String
    var category: String?
    let x: Float
    let y: Float
    let z: Float
    var position: simd_float3 { simd_float3(x, y, z) }
}

/// `GET /worlds/{id}/occupancy`: the splat voxelised into the world frame.
struct MapOccupancyPayload: Decodable, Sendable {
    let cellSize: Float
    let origin: [Float]
    let size: [Int32]
    let count: Int
    /// Little-endian Int32 cell indices, base64.
    let cells: String
}

struct MapHazardsPayload: Decodable, Sendable {
    let hazards: [MapHazard]
}

/// Static knowledge of the space in the site frame: which cells the scanned
/// splat fills, plus annotated hazards. Built once per world and shared by
/// every phone role through the front phone's localisation.
struct StaticMap: Sendable {
    let cellSize: Float
    let origin: simd_float3
    let size: SIMD3<Int32>
    let hazards: [MapHazard]
    private let occupied: Set<Int32>

    var cellCount: Int { occupied.count }

    init(cellSize: Float, origin: simd_float3, size: SIMD3<Int32>, cells: [Int32], hazards: [MapHazard] = []) {
        self.cellSize = cellSize
        self.origin = origin
        self.size = size
        self.hazards = hazards
        occupied = Set(cells)
    }

    init?(payload: MapOccupancyPayload, hazards: [MapHazard]) {
        guard payload.origin.count == 3, payload.size.count == 3, payload.cellSize > 0,
              let data = Data(base64Encoded: payload.cells), data.count % 4 == 0 else { return nil }
        let cells: [Int32] = data.withUnsafeBytes { raw in
            raw.bindMemory(to: Int32.self).map { Int32(littleEndian: $0) }
        }
        self.init(cellSize: payload.cellSize,
                  origin: simd_float3(payload.origin[0], payload.origin[1], payload.origin[2]),
                  size: SIMD3(payload.size[0], payload.size[1], payload.size[2]),
                  cells: cells, hazards: hazards)
    }

    func isOccupied(_ p: simd_float3) -> Bool {
        let c = (p - origin) / cellSize
        let i = Int32(floorf(c.x)), j = Int32(floorf(c.y)), k = Int32(floorf(c.z))
        guard i >= 0, j >= 0, k >= 0, i < size.x, j < size.y, k < size.z else { return false }
        return occupied.contains((i * size.y + j) * size.z + k)
    }
}

/// Casts horizontal rays from the localised device pose through the static map
/// and reports the nearest structure per zone, per side and behind. Works for
/// phones with no sensor pointing that way at all, and for any phone role, as
/// long as the front phone is localised.
struct MapObstacleSensor {
    var maxRange: Float = 3.0
    var minRange: Float = 0.1
    var halfFieldDegrees: Float = 35
    var zoneBoundaryDegrees: Float = 12
    var gapColumns = 16
    /// Heights sampled relative to the device so the floor and ceiling are skipped
    /// (a chest or shoulder mount sits about 1.3 m above the floor).
    var heightOffsets: [Float] = [-0.7, -0.35, 0, 0.3]
    /// An annotated hazard counts as this wide.
    var hazardRadius: Float = 0.6
    /// Bearings that count as each side and the back, in degrees clockwise from forward.
    var sideBearings: [Float] = [70, 90, 110]

    struct Reading: Equatable, Sendable {
        var zones: ObstacleZones
        var left: Float?
        var right: Float?
        var back: Float?
        var nearestHazard: MapHazard?
        var nearestHazardDistance: Float?
    }

    /// `deviceTransform` is the device pose in the map's frame (anchor⁻¹ · camera).
    /// Returns nil when the camera looks too far up or down to define a heading.
    func read(map: StaticMap, deviceTransform: simd_float4x4) -> Reading? {
        let camera = simd_make_float3(deviceTransform.columns.3)
        var forward = -simd_make_float3(deviceTransform.columns.2)
        forward.y = 0
        guard simd_length(forward) > 0.2 else { return nil }
        forward = simd_normalize(forward)
        let right = simd_normalize(simd_cross(forward, simd_float3(0, 1, 0)))

        var nearestHazard: MapHazard?
        var nearestHazardDistance = Float.infinity
        func cast(bearingDegrees: Float) -> Float? {
            let b = bearingDegrees * .pi / 180
            let direction = forward * cosf(b) + right * sinf(b)
            var hit: Float?
            let step = map.cellSize / 2
            var t = minRange
            // A hit must be confirmed by a second sample (another height here, or any
            // height one whole cell deeper) so a lone leftover wisp in the splat is ignored.
            func occupiedHeights(at distance: Float) -> Int {
                heightOffsets.reduce(0) { $0 + (map.isOccupied(camera + direction * distance + simd_float3(0, $1, 0)) ? 1 : 0) }
            }
            march: while t <= maxRange {
                let here = occupiedHeights(at: t)
                if here >= 2 || (here == 1 && occupiedHeights(at: t + map.cellSize) >= 1) {
                    hit = t
                    break march
                }
                t += step
            }
            for hazard in map.hazards {
                let d = hazard.position - camera
                guard abs(d.y) < 1.5 else { continue }
                let along = simd_dot(simd_float3(d.x, 0, d.z), direction)
                let across = simd_length(simd_float3(d.x, 0, d.z) - direction * along)
                guard along > 0, across < hazardRadius else { continue }
                let distance = max(minRange, along - hazardRadius)
                guard distance <= maxRange else { continue }
                if distance < (hit ?? .infinity) { hit = distance }
                if distance < nearestHazardDistance { nearestHazardDistance = distance; nearestHazard = hazard }
            }
            return hit
        }

        // Fan ahead: one ray per column; a zone is the nearest of its columns.
        var columnClear = [Float](repeating: maxRange, count: gapColumns)
        var zones = ObstacleZones()
        let columnWidth = 2 * halfFieldDegrees / Float(gapColumns)
        for column in 0..<gapColumns {
            let bearing = -halfFieldDegrees + (Float(column) + 0.5) * columnWidth
            guard let t = cast(bearingDegrees: bearing) else { continue }
            columnClear[column] = min(columnClear[column], t)
            if bearing < -zoneBoundaryDegrees {
                zones.left = min(zones.left ?? .infinity, t)
            } else if bearing > zoneBoundaryDegrees {
                zones.right = min(zones.right ?? .infinity, t)
            } else {
                zones.center = min(zones.center ?? .infinity, t)
            }
        }
        let half = gapColumns / 2
        let leftClear = columnClear[..<half].reduce(0, +) / Float(half)
        let rightClear = columnClear[half...].reduce(0, +) / Float(gapColumns - half)
        zones.gapDirection = max(-1, min(1, (rightClear - leftClear) / maxRange))

        func side(_ sign: Float) -> Float? {
            sideBearings.compactMap { cast(bearingDegrees: sign * $0) }.min()
        }
        return Reading(zones: zones, left: side(-1), right: side(1), back: cast(bearingDegrees: 180),
                       nearestHazard: nearestHazard,
                       nearestHazardDistance: nearestHazard == nil ? nil : nearestHazardDistance)
    }
}

/// Combines what the side phones report with what the static map says is beside
/// and behind the localised wearer: per mount, the nearer of the two.
enum SideClearanceMerge {
    static func merge(live: [DeviceRole: SideClearance], map: MapObstacleSensor.Reading?, now: TimeInterval,
                      maxAge: TimeInterval = 1.5) -> [DeviceRole: SideClearance] {
        var sides = live.filter { now - $0.value.timestamp <= maxAge }
        guard let map else { return sides }
        for (role, distance) in [(DeviceRole.left, map.left), (.right, map.right), (.back, map.back)] {
            guard let distance else { continue }
            if let existing = sides[role], let nearest = existing.nearest, nearest <= distance { continue }
            sides[role] = SideClearance(role: role, nearest: distance, timestamp: now)
        }
        return sides
    }
}

extension ObstacleZones {
    /// Nearest of two readings per zone; the steering hint averages.
    static func merged(_ a: ObstacleZones, _ b: ObstacleZones) -> ObstacleZones {
        func nearest(_ x: Float?, _ y: Float?) -> Float? {
            switch (x, y) {
            case (nil, nil): nil
            case (let v?, nil): v
            case (nil, let v?): v
            case (let v?, let w?): min(v, w)
            }
        }
        return ObstacleZones(left: nearest(a.left, b.left), center: nearest(a.center, b.center),
                             right: nearest(a.right, b.right), gapDirection: (a.gapDirection + b.gapDirection) / 2,
                             touching: a.touching || b.touching)
    }
}
