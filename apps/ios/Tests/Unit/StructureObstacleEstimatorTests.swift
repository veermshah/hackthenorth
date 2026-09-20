import XCTest
import simd
@testable import NavigationAssistant

final class StructureObstacleEstimatorTests: XCTestCase {
    private let identity = matrix_identity_float4x4

    /// Camera at the origin looking down -z; a wall facing the camera at z = -1.5.
    private var wall: VerticalPlane {
        var t = matrix_identity_float4x4
        t.columns.0 = simd_float4(1, 0, 0, 0)   // local x -> world x
        t.columns.1 = simd_float4(0, 0, 1, 0)   // local y (normal) -> world +z, facing the camera
        t.columns.2 = simd_float4(0, -1, 0, 0)  // local z -> world -y
        t.columns.3 = simd_float4(0, 0, -1.5, 1)
        return VerticalPlane(transform: t, center: .zero, extent: simd_float2(4, 2))
    }

    /// A patch of `count` points spread over a surface at forward distance `z` and sideways offset `x`.
    private func patch(x: Float, z: Float, count: Int = 10) -> [simd_float3] {
        (0..<count).map { i in simd_float3(x + Float(i % 5) * 0.04 - 0.08, Float(i / 5) * 0.1 - 0.05, -z) }
    }

    /// Runs the same frame several times so persistence is satisfied.
    private func settle(_ e: inout StructureObstacleEstimator, points: [simd_float3], planes: [VerticalPlane] = [],
                        from t: TimeInterval = 1) -> ObstacleZones {
        var zones = ObstacleZones.empty
        for i in 0..<4 {
            zones = e.analyze(points: points, planes: planes, cameraTransform: identity, timestamp: t + Double(i) * 0.07)
        }
        return zones
    }

    func testNothingInViewIsClear() {
        var e = StructureObstacleEstimator()
        let zones = settle(&e, points: [])
        XCTAssertNil(zones.left); XCTAssertNil(zones.center); XCTAssertNil(zones.right)
        XCTAssertEqual(zones.gapDirection, 0, accuracy: 0.001)
    }

    func testClustersLandInTheRightZonesAndFloorAndStraysAreIgnored() {
        var e = StructureObstacleEstimator()
        var points = patch(x: 0, z: 0.8)                                     // ahead
        points += patch(x: -0.6, z: 1.0)                                     // ~31° left
        points += (0..<20).map { simd_float3(Float($0) * 0.1 - 1, -1.3, -0.5) }  // floor: ignored
        points += [simd_float3(0.3, 0, -0.4), simd_float3(0.5, 0.1, -0.9), simd_float3(0.4, 0, -2.5)]  // strays right
        let zones = settle(&e, points: points)
        XCTAssertEqual(zones.center ?? -1, 0.8, accuracy: 0.05)
        XCTAssertEqual(zones.left ?? -1, 1.0, accuracy: 0.05)
        XCTAssertNil(zones.right, "a few scattered points are not an obstacle")
        XCTAssertGreaterThan(zones.gapDirection, 0, "the right is clearer")
    }

    func testTheSamePointSeenEveryFrameCountsOnce() {
        var e = StructureObstacleEstimator()
        // Three stray points re-reported for 40 frames under stable ids must never become a surface.
        let strays = [simd_float3(0.05, 0, -0.7), simd_float3(-0.05, 0.1, -0.75), simd_float3(0, -0.1, -0.72)]
        var zones = ObstacleZones.empty
        for i in 0..<40 {
            zones = e.analyze(points: strays, identifiers: [1, 2, 3], planes: [], cameraTransform: identity,
                              timestamp: 1 + Double(i) / 60)
        }
        XCTAssertNil(zones.center)
        XCTAssertEqual(e.stats.remembered, 3)
    }

    func testASingleFrameOfNoiseDoesNotReport() {
        var e = StructureObstacleEstimator()
        let once = e.analyze(points: patch(x: 0, z: 0.8), planes: [], cameraTransform: identity, timestamp: 1)
        XCTAssertNil(once.center, "needs to persist before it is reported")
    }

    func testVerticalPlaneCountsAsWallImmediately() {
        var e = StructureObstacleEstimator()
        let zones = e.analyze(points: [], planes: [wall], cameraTransform: identity, timestamp: 1)
        XCTAssertEqual(zones.center ?? -1, 1.5, accuracy: 0.01)
        XCTAssertEqual(zones.left ?? -1, 1.5 / cosf(23.5 * .pi / 180), accuracy: 0.02)
        XCTAssertEqual(zones.right ?? -1, 1.5 / cosf(23.5 * .pi / 180), accuracy: 0.02)
    }

    func testPointsExpireAfterTheWindow() {
        var e = StructureObstacleEstimator()
        _ = settle(&e, points: patch(x: 0, z: 0.7))
        let later = e.analyze(points: [], planes: [], cameraTransform: identity, timestamp: 1.5)
        XCTAssertNotNil(later.center, "recent points are still remembered")
        var expired = ObstacleZones.empty
        for i in 0..<4 { expired = e.analyze(points: [], planes: [], cameraTransform: identity, timestamp: 3 + Double(i) * 0.1) }
        XCTAssertNil(expired.center)
    }

    func testTiltedCameraMeasuresNothing() {
        var e = StructureObstacleEstimator()
        var down = matrix_identity_float4x4
        down.columns.2 = simd_float4(0, 1, 0, 0)  // camera -z points straight down
        let zones = e.analyze(points: patch(x: 0, z: 0.8), planes: [wall], cameraTransform: down, timestamp: 1)
        XCTAssertTrue(e.stats.tilted)
        XCTAssertNil(zones.center)
    }
}
