import XCTest
@testable import NavigationAssistant

/// Side phones pulse from whatever knows what is beside the wearer: their own
/// sensing or the static map, graded by distance and silent unless it is close.
final class SideHapticTests: XCTestCase {
    let policy = ObstacleCuePolicy()
    let now: TimeInterval = 1000

    private func side(_ role: DeviceRole, _ nearest: Float?) -> SideClearance {
        SideClearance(role: role, nearest: nearest, timestamp: now)
    }

    func testWallBesideTheLeftShoulderPulsesOnlyTheLeftPhoneWithoutSpeech() {
        let d = policy.decide(.empty, sides: [.left: side(.left, 0.3), .right: side(.right, nil)], now: now)
        XCTAssertNil(d.cue)
        XCTAssertTrue(d.haptics.left); XCTAssertFalse(d.haptics.right); XCTAssertFalse(d.haptics.front)
        XCTAssertEqual(d.haptics.distance(for: .left), 0.3)
        XCTAssertNil(d.haptics.distance(for: .right))
    }

    func testEachSideGetsItsOwnDistance() {
        let d = policy.decide(.empty, sides: [.left: side(.left, 0.35), .right: side(.right, 0.3)], now: now)
        XCTAssertTrue(d.haptics.left && d.haptics.right)
        XCTAssertEqual(d.haptics.distance(for: .left), 0.35)
        XCTAssertEqual(d.haptics.distance(for: .right), 0.3)
        XCTAssertNil(d.cue, "warning range is haptic only")
    }

    func testVeryCloseSideStillSpeaksAndKeepsTheOtherSidesPulse() {
        let d = policy.decide(.empty, sides: [.left: side(.left, 0.15), .right: side(.right, 0.35)], now: now)
        XCTAssertNotNil(d.cue)
        XCTAssertTrue(d.haptics.left && d.haptics.right)
        XCTAssertEqual(d.haptics.distance(for: .left), 0.15)
        XCTAssertEqual(d.haptics.distance(for: .right), 0.35)
    }

    func testWallBehindPulsesTheBackPhone() {
        let d = policy.decide(.empty, sides: [.back: side(.back, 0.25)], now: now)
        XCTAssertTrue(d.haptics.back); XCTAssertFalse(d.haptics.left)
        XCTAssertEqual(d.haptics.distance(for: .back), 0.25)
        let far = policy.decide(.empty, sides: [.back: side(.back, 0.5)], now: now)
        XCTAssertEqual(far, .clear)
    }

    func testFarWallsDoNotPulse() {
        XCTAssertEqual(policy.decide(.empty, sides: [.left: side(.left, 1.0)], now: now), .clear)
    }

    func testMapFillsInSidesNoPhoneIsWatching() {
        let map = MapObstacleSensor.Reading(zones: .empty, left: 0.8, right: nil, back: 0.6)
        let merged = SideClearanceMerge.merge(live: [:], map: map, now: now)
        XCTAssertEqual(merged[.left]?.nearest, 0.8)
        XCTAssertNil(merged[.right])
        XCTAssertEqual(merged[.back]?.nearest, 0.6)
    }

    func testLivePhoneReadingWinsWhenItIsNearerAndMapWinsWhenTheLiveViewIsClear() {
        let map = MapObstacleSensor.Reading(zones: .empty, left: 0.8, right: 0.9, back: nil)
        let live: [DeviceRole: SideClearance] = [.left: side(.left, 0.5), .right: side(.right, nil)]
        let merged = SideClearanceMerge.merge(live: live, map: map, now: now)
        XCTAssertEqual(merged[.left]?.nearest, 0.5, "the phone saw something nearer than the map")
        XCTAssertEqual(merged[.right]?.nearest, 0.9, "the phone saw nothing but the map knows the wall")
    }

    func testStaleLiveReadingIsDroppedInFavourOfTheMap() {
        let map = MapObstacleSensor.Reading(zones: .empty, left: 1.0, right: nil, back: nil)
        let stale = SideClearance(role: .left, nearest: 0.3, timestamp: now - 5)
        let merged = SideClearanceMerge.merge(live: [.left: stale], map: map, now: now)
        XCTAssertEqual(merged[.left]?.nearest, 1.0)
    }

    func testPulseMessageRoundTrips() throws {
        let message = PeerMessage.pulse(PulseCommand(id: 7, role: .back, ms: 300))
        let data = try JSONEncoder().encode(message)
        XCTAssertEqual(try JSONDecoder().decode(PeerMessage.self, from: data), message)
    }

    func testCommandRoundTripsWithPerSideDistances() throws {
        let command = HapticCommand(front: false, left: true, right: true, back: false, distance: 0.3,
                                    leftDistance: 0.3, rightDistance: 0.35, backDistance: nil, sideRange: 0.4, backRange: 0.3)
        let data = try JSONEncoder().encode(PeerMessage.haptic(command))
        XCTAssertEqual(try JSONDecoder().decode(PeerMessage.self, from: data), .haptic(command))
    }
}
