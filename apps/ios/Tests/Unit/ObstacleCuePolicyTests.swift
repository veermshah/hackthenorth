import XCTest
@testable import NavigationAssistant

final class ObstacleCuePolicyTests: XCTestCase {
    let policy = ObstacleCuePolicy()

    /// These tests check which mounts buzz and the headline distance; per-side distances are covered in SideHapticTests.
    private func flags(_ h: HapticCommand) -> HapticCommand {
        var c = h
        c.leftDistance = nil; c.rightDistance = nil; c.backDistance = nil; c.sideRange = nil; c.backRange = nil
        return c
    }

    func testClearSceneProducesNothing() {
        XCTAssertEqual(policy.decide(.empty), .clear)
    }

    func testCenterObstacleStopsAndBuzzesBackPlusObstacleSide() {
        let zones = ObstacleZones(left: nil, center: 0.5, right: nil, gapDirection: 0.8)
        let d = policy.decide(zones)
        XCTAssertEqual(d.cue?.priority, .obstacle)
        XCTAssertTrue(d.cue!.text.contains("right"))
        XCTAssertEqual(d.openSide, .right)
        XCTAssertEqual(flags(d.haptics), HapticCommand(front: true, left: false, right: false, distance: 0.5))
    }

    func testWallAheadOnlyBuzzesFront() {
        // The front camera sees the wall in all three zones; side phones see nothing.
        let now: TimeInterval = 1000
        let zones = ObstacleZones(left: 0.6, center: 0.5, right: 0.6)
        let sides: [DeviceRole: SideClearance] = [
            .left: SideClearance(role: .left, nearest: nil, timestamp: now),
            .right: SideClearance(role: .right, nearest: nil, timestamp: now)
        ]
        let d = policy.decide(zones, sides: sides, now: now)
        XCTAssertEqual(flags(d.haptics), HapticCommand(front: true, left: false, right: false, distance: 0.5))
    }

    func testWallAheadWithoutSidePhonesOnlyBuzzesFront() {
        let d = policy.decide(ObstacleZones(left: 0.6, center: 0.5, right: 0.6))
        XCTAssertEqual(flags(d.haptics), HapticCommand(front: true, left: false, right: false, distance: 0.5))
    }

    func testFrontAndLeftPhoneBlockedBuzzesFrontAndLeft() {
        let now: TimeInterval = 1000
        let zones = ObstacleZones(left: 3.0, center: 0.5, right: 3.0)
        let sides: [DeviceRole: SideClearance] = [
            .left: SideClearance(role: .left, nearest: 0.8, timestamp: now),
            .right: SideClearance(role: .right, nearest: nil, timestamp: now)
        ]
        let d = policy.decide(zones, sides: sides, now: now)
        XCTAssertEqual(flags(d.haptics), HapticCommand(front: true, left: true, right: false, distance: 0.5))
        XCTAssertEqual(d.openSide, .right)
    }

    func testFrontAndRightPhoneBlockedBuzzesFrontAndRight() {
        let now: TimeInterval = 1000
        let zones = ObstacleZones(left: 3.0, center: 0.5, right: 3.0)
        let sides: [DeviceRole: SideClearance] = [.right: SideClearance(role: .right, nearest: 0.8, timestamp: now)]
        let d = policy.decide(zones, sides: sides, now: now)
        XCTAssertEqual(flags(d.haptics), HapticCommand(front: true, left: false, right: true, distance: 0.5))
        XCTAssertEqual(d.openSide, .left)
    }

    func testSidePhoneReadingCanBlockASide() {
        let now: TimeInterval = 1000
        let zones = ObstacleZones(left: 3.0, center: 0.5, right: 3.0)
        let sides: [DeviceRole: SideClearance] = [.left: SideClearance(role: .left, nearest: 0.7, timestamp: now)]
        let d = policy.decide(zones, sides: sides, now: now)
        XCTAssertEqual(flags(d.haptics), HapticCommand(front: true, left: true, right: false, distance: 0.5))
    }

    func testSidePhoneReadingOverridesFrontGuess() {
        // Front sees the gap on the right, but the right phone reports a wall at 0.5 m.
        let now: TimeInterval = 1000
        let zones = ObstacleZones(left: 2.0, center: 0.5, right: 2.5, gapDirection: 0.8)
        let sides: [DeviceRole: SideClearance] = [
            .right: SideClearance(role: .right, nearest: 0.5, timestamp: now),
            .left: SideClearance(role: .left, nearest: nil, timestamp: now)
        ]
        let d = policy.decide(zones, sides: sides, now: now)
        XCTAssertEqual(d.openSide, .left)
        XCTAssertTrue(d.cue!.text.contains("left"))
        XCTAssertEqual(flags(d.haptics), HapticCommand(front: true, left: false, right: true, distance: 0.5))
    }

    func testStaleSideReadingIsIgnored() {
        let now: TimeInterval = 1000
        let zones = ObstacleZones(left: 2.0, center: 0.5, right: 2.5, gapDirection: 0.8)
        let sides: [DeviceRole: SideClearance] = [
            .right: SideClearance(role: .right, nearest: 0.5, timestamp: now - 5)
        ]
        XCTAssertEqual(policy.decide(zones, sides: sides, now: now).openSide, .right)
    }

    func testBothSidesBlockedBuzzesEverything() {
        let now: TimeInterval = 1000
        let zones = ObstacleZones(left: 0.8, center: 0.5, right: 0.9)
        let sides: [DeviceRole: SideClearance] = [
            .left: SideClearance(role: .left, nearest: 0.8, timestamp: now),
            .right: SideClearance(role: .right, nearest: 0.9, timestamp: now)
        ]
        let d = policy.decide(zones, sides: sides, now: now)
        XCTAssertNil(d.openSide)
        XCTAssertTrue(d.cue!.text.contains("Turn around"))
        XCTAssertEqual(flags(d.haptics), HapticCommand(front: true, left: true, right: true, distance: 0.5))
    }

    func testPeerMessagesRoundTrip() throws {
        let messages: [PeerMessage] = [
            .haptic(HapticCommand(left: true, distance: 0.7)),
            .clearance(SideClearance(role: .left, nearest: nil, timestamp: 12)),
            .hello(.back)
        ]
        for m in messages {
            let data = try JSONEncoder().encode(m)
            XCTAssertEqual(try JSONDecoder().decode(PeerMessage.self, from: data), m)
        }
    }

    func testLeftPhoneVeryCloseBuzzesLeftPhoneOnly() {
        let now: TimeInterval = 1000
        let sides: [DeviceRole: SideClearance] = [.left: SideClearance(role: .left, nearest: 0.15, timestamp: now)]
        let d = policy.decide(.empty, sides: sides, now: now)
        XCTAssertEqual(flags(d.haptics), HapticCommand(left: true, distance: 0.15))
        XCTAssertTrue(d.haptics.shouldBuzz(.left))
        XCTAssertFalse(d.haptics.shouldBuzz(.right))
        XCTAssertFalse(d.haptics.shouldBuzz(.front))
        XCTAssertFalse(d.haptics.shouldBuzz(.back))
        XCTAssertEqual(d.cue?.text, "Obstacle on your left. Move right.")
    }

    func testRightPhoneVeryCloseBuzzesRightPhoneOnly() {
        let now: TimeInterval = 1000
        let sides: [DeviceRole: SideClearance] = [.right: SideClearance(role: .right, nearest: 0.15, timestamp: now)]
        let d = policy.decide(.empty, sides: sides, now: now)
        XCTAssertEqual(flags(d.haptics), HapticCommand(right: true, distance: 0.15))
    }

    func testFrontEdgeZoneVeryCloseBuzzesFrontNotSides() {
        let d = policy.decide(ObstacleZones(left: 0.15, center: nil, right: nil))
        XCTAssertEqual(flags(d.haptics), HapticCommand(front: true, distance: 0.15))
        XCTAssertEqual(d.cue?.text, "Obstacle close on your left. Move right.")
    }

    func testFarObstaclesAreIgnored() {
        let d = policy.decide(ObstacleZones(left: 2.0, center: 3.0, right: 2.5))
        XCTAssertEqual(d, .clear)
        // A side phone at 0.35 m alone is not "very close": no cue, but that phone pulses.
        let now: TimeInterval = 1000
        let sides: [DeviceRole: SideClearance] = [.left: SideClearance(role: .left, nearest: 0.35, timestamp: now)]
        let near = policy.decide(.empty, sides: sides, now: now)
        XCTAssertNil(near.cue)
        XCTAssertTrue(near.haptics.left && !near.haptics.front && !near.haptics.right)
        // Beyond the warning range nothing happens at all.
        let far: [DeviceRole: SideClearance] = [.left: SideClearance(role: .left, nearest: 1.4, timestamp: now)]
        XCTAssertEqual(policy.decide(.empty, sides: far, now: now), .clear)
    }

    func testObstacleOutranksRoute() {
        XCTAssertTrue(SpokenCue.Priority.route < .obstacle)
    }
}
