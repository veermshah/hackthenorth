import XCTest
import simd
@testable import NavigationAssistant

final class MapObstacleSensorTests: XCTestCase {
    private let cell: Float = 0.15
    private let origin = simd_float3(-5, -2, -5)
    private let size = SIMD3<Int32>(67, 27, 67)

    private func index(_ p: simd_float3) -> Int32 {
        let c = (p - origin) / cell
        return (Int32(floorf(c.x)) * size.y + Int32(floorf(c.y))) * size.z + Int32(floorf(c.z))
    }

    /// A wall filling x in [-2, 2], y in [-1, 1] at z = -2.
    private func wallMap(hazards: [MapHazard] = []) -> StaticMap {
        var cells: [Int32] = []
        for x in stride(from: Float(-2), through: 2, by: cell / 2) {
            for y in stride(from: Float(-1), through: 1, by: cell / 2) {
                cells.append(index(simd_float3(x, y, -2)))
            }
        }
        return StaticMap(cellSize: cell, origin: origin, size: size, cells: cells, hazards: hazards)
    }

    func testWallAheadFillsTheFanAndNothingElse() {
        let reading = MapObstacleSensor().read(map: wallMap(), deviceTransform: matrix_identity_float4x4)!
        XCTAssertEqual(reading.zones.center ?? -1, 2.0, accuracy: 0.16)
        // A zone reports its nearest column, the one just past the 12° boundary.
        XCTAssertEqual(reading.zones.left ?? -1, 2.0 / cosf(14.4 * .pi / 180), accuracy: 0.2)
        XCTAssertEqual(reading.zones.right ?? -1, 2.0 / cosf(14.4 * .pi / 180), accuracy: 0.2)
        XCTAssertNil(reading.left); XCTAssertNil(reading.right); XCTAssertNil(reading.back)
        XCTAssertNil(reading.nearestHazard)
    }

    func testWallBehindIsReportedAsBackAfterTurningAround() {
        var turned = matrix_identity_float4x4
        turned.columns.0 = simd_float4(-1, 0, 0, 0)
        turned.columns.2 = simd_float4(0, 0, -1, 0)  // camera now looks down +z
        let reading = MapObstacleSensor().read(map: wallMap(), deviceTransform: turned)!
        XCTAssertNil(reading.zones.center)
        XCTAssertEqual(reading.back ?? -1, 2.0, accuracy: 0.16)
    }

    func testHazardOnTheRightGivesSideClearanceAndName() {
        let bags = MapHazard(id: "h1", name: "Bags on the floor", category: "obstacle", x: 1.2, y: 0, z: 0)
        let reading = MapObstacleSensor().read(map: wallMap(hazards: [bags]), deviceTransform: matrix_identity_float4x4)!
        // 1.2 m away minus the 0.6 m radius; the 70° ray clips it slightly sooner than the 90° one.
        XCTAssertEqual(reading.right ?? -1, 0.55, accuracy: 0.08)
        XCTAssertNil(reading.left)
        XCTAssertEqual(reading.nearestHazard, bags)
    }

    func testLoneWispCellIsIgnoredButAThickPatchCounts() {
        // One stray cell ahead at camera height, and a 2-cell-deep patch further on.
        var cells = [index(simd_float3(0, 0, -1.0))]
        for z in [Float(-1.6), -1.7] { for y in [Float(-0.05), 0.05] { cells.append(index(simd_float3(0, y, z))) } }
        let map = StaticMap(cellSize: cell, origin: origin, size: size, cells: cells)
        let reading = MapObstacleSensor().read(map: map, deviceTransform: matrix_identity_float4x4)!
        XCTAssertEqual(reading.zones.center ?? -1, 1.6, accuracy: 0.16, "the wisp at 1.0 m is skipped")
    }

    func testTiltedDeviceHasNoReading() {
        var down = matrix_identity_float4x4
        down.columns.2 = simd_float4(0, 1, 0, 0)
        XCTAssertNil(MapObstacleSensor().read(map: wallMap(), deviceTransform: down))
    }

    func testPayloadDecodesLittleEndianCells() {
        var data = Data()
        for value in [Int32(7), Int32(70000)] { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let payload = MapOccupancyPayload(cellSize: 0.15, origin: [-5, -2, -5], size: [67, 27, 67], count: 2,
                                          cells: data.base64EncodedString())
        let map = StaticMap(payload: payload, hazards: [])
        XCTAssertEqual(map?.cellCount, 2)
    }

    func testMergedZonesTakeTheNearest() {
        let sensed = ObstacleZones(left: 1.0, center: nil, right: 2.5, gapDirection: 0.4)
        let mapped = ObstacleZones(left: 1.8, center: 0.9, right: nil, gapDirection: -0.2)
        let merged = ObstacleZones.merged(sensed, mapped)
        XCTAssertEqual(merged.left, 1.0); XCTAssertEqual(merged.center, 0.9); XCTAssertEqual(merged.right, 2.5)
        XCTAssertEqual(merged.gapDirection, 0.1, accuracy: 0.001)
    }
}
