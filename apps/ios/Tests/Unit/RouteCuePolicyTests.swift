import XCTest
@testable import NavigationAssistant

/// The mount that buzzes is pushing the wearer, so every expectation here reads
/// "buzz X" = "go the other way".
final class RouteCuePolicyTests: XCTestCase {
    private var policy = RouteCuePolicy()
    private let allMounts: [DeviceRole] = [.left, .right, .back]

    override func setUp() {
        super.setUp()
        policy = RouteCuePolicy()
    }

    /// The backend recomputes `turn` from the wearer's live heading on every pose, so a test
    /// only has to name the turn word and the node the current leg starts from.
    private func progress(_ state: String, turn: String?, atNode: String = "n1") -> ProgressUpdate {
        let instruction = turn.map { ProgressUpdate.Instruction(atNode: atNode, turn: $0, text: "", distanceMetres: 5) }
        return ProgressUpdate(state: state, remainingMetres: 20, distanceToNextMetres: 5, nextNode: nil,
                              instruction: instruction, offRouteMetres: 0, headingDeg: 90, speak: nil)
    }

    private func decide(_ state: String, turn: String?, atNode: String = "n1",
                        connected: [DeviceRole]? = nil, at now: TimeInterval = 0) -> [RouteCue] {
        policy.decide(progress(state, turn: turn, atNode: atNode), connected: connected ?? allMounts, now: now)
    }

    // MARK: - The push mapping

    func testTurningLeftIsAPushFromTheRight() {
        XCTAssertEqual(decide("navigating", turn: "left"), [RouteCue(role: .right, kind: .turn, atNode: "n1")])
    }

    func testTurningRightIsAPushFromTheLeft() {
        XCTAssertEqual(decide("navigating", turn: "sharp-right").map(\.role), [.left])
    }

    func testTurningAroundIsAPushFromTheChest() {
        // The chest phone owns its own haptics, so this needs no linked mount at all.
        XCTAssertEqual(decide("navigating", turn: "u-turn", connected: []).map(\.role), [.front])
    }

    func testEveryPushIsTwoTapsAndArrivalIsThree() {
        XCTAssertEqual(RouteCue.Kind.turn.taps, 2)
        XCTAssertEqual(RouteCue.Kind.forward.taps, 2)
        XCTAssertEqual(RouteCue.Kind.arrive.taps, 3)
    }

    func testUnknownTurnsAndMissingInstructionsSayNothing() {
        XCTAssertTrue(decide("navigating", turn: "sideways").isEmpty)
        XCTAssertTrue(decide("navigating", turn: nil).isEmpty)
        XCTAssertTrue(policy.decide(nil, connected: allMounts, now: 0).isEmpty)
    }

    /// Walking drift is constant; a mount that buzzes for every 30 degrees stops meaning anything.
    func testSlightTurnsAreSilentUnlessAskedFor() {
        XCTAssertTrue(decide("navigating", turn: "slight-left").isEmpty)

        var eager = RouteCuePolicy()
        eager.cueSlightTurns = true
        XCTAssertEqual(eager.decide(progress("navigating", turn: "slight-left"), connected: allMounts, now: 0).map(\.role), [.right])
    }

    // MARK: - Walk on

    /// The back mount confirms a correction landed, and says it once.
    func testForwardFiresOnlyAfterACorrection() {
        XCTAssertTrue(decide("navigating", turn: "straight", at: 0).isEmpty, "a straight leg must not buzz on its own")
        XCTAssertEqual(decide("navigating", turn: "right", at: 1).map(\.role), [.left])
        let forward = decide("navigating", turn: "straight", at: 2)
        XCTAssertEqual(forward, [RouteCue(role: .back, kind: .forward, atNode: "n1")])
        XCTAssertTrue(decide("navigating", turn: "straight", at: 3).isEmpty, "walk on is said once, not all the way down the leg")
        XCTAssertTrue(decide("navigating", turn: "straight", at: 30).isEmpty)
    }

    func testDriftingAgainAfterWalkingOnPushesImmediately() {
        XCTAssertFalse(decide("navigating", turn: "right", at: 0).isEmpty)
        XCTAssertFalse(decide("navigating", turn: "straight", at: 1).isEmpty)
        XCTAssertEqual(decide("navigating", turn: "right", at: 2).map(\.role), [.left])
    }

    func testForwardCanBeTurnedOff() {
        var quiet = RouteCuePolicy()
        quiet.confirmForward = false
        XCTAssertFalse(quiet.decide(progress("navigating", turn: "left"), connected: allMounts, now: 0).isEmpty)
        XCTAssertTrue(quiet.decide(progress("navigating", turn: "straight"), connected: allMounts, now: 1).isEmpty)
    }

    // MARK: - Repeats

    func testSameNudgeIsNotRepeatedInsideTheWindow() {
        XCTAssertFalse(decide("navigating", turn: "right", at: 0).isEmpty)
        XCTAssertTrue(decide("navigating", turn: "right", at: 1).isEmpty)
        XCTAssertTrue(decide("navigating", turn: "right", at: 4.9).isEmpty)
        // Still facing the wrong way after the window: remind, do not stutter.
        XCTAssertFalse(decide("navigating", turn: "right", at: 5.1).isEmpty)
    }

    /// A turn tightening as the wearer nears the corner is the same instruction.
    func testTighteningTheSameTurnDoesNotRebuzz() {
        XCTAssertFalse(decide("navigating", turn: "right", at: 0).isEmpty)
        XCTAssertTrue(decide("navigating", turn: "sharp-right", at: 1).isEmpty)
    }

    func testOvershootingPushesBackTheOtherWay() {
        XCTAssertEqual(decide("navigating", turn: "right", at: 0).map(\.role), [.left])
        XCTAssertEqual(decide("navigating", turn: "left", at: 1).map(\.role), [.right])
    }

    func testTheNextLegPushesImmediately() {
        XCTAssertFalse(decide("navigating", turn: "right", atNode: "n1", at: 0).isEmpty)
        XCTAssertFalse(decide("navigating", turn: "right", atNode: "n2", at: 1).isEmpty)
    }

    // MARK: - Arrival and dead ends

    /// A push from every side is a push nowhere: the one pattern that is not a direction.
    func testArrivalFiresEveryMountAtOnce() {
        let cues = decide("arrived", turn: "arrive", atNode: "note:bed1")
        XCTAssertEqual(Set(cues.map(\.role)), [.front, .left, .right, .back])
        XCTAssertTrue(cues.allSatisfy { $0.kind == .arrive && $0.atNode == "note:bed1" })
        XCTAssertTrue(decide("arrived", turn: "arrive", atNode: "note:bed1", at: 1).isEmpty)
    }

    func testArrivalStillReachesTheChestWithNothingLinked() {
        XCTAssertEqual(decide("arrived", turn: "arrive", connected: []).map(\.role), [.front])
    }

    func testUntrustworthyStatesAreSilentAndClearTheWindow() {
        XCTAssertFalse(decide("navigating", turn: "left", at: 0).isEmpty)
        XCTAssertTrue(decide("off-route", turn: "left", at: 1).isEmpty)
        XCTAssertTrue(decide("lost", turn: "left", at: 2).isEmpty)
        XCTAssertTrue(decide("localizing", turn: "left", at: 3).isEmpty)
        XCTAssertFalse(decide("navigating", turn: "left", at: 4).isEmpty, "the reroute must be felt at once")
    }

    func testNoCueWhenThePushingMountIsNotLinked() {
        // Turning left pushes from the right, which is not there.
        XCTAssertTrue(decide("navigating", turn: "left", connected: [.left, .back], at: 0).isEmpty)
        // And the window was not armed by a cue that never went out.
        XCTAssertFalse(decide("navigating", turn: "left", connected: [.right], at: 0.1).isEmpty)
    }

    func testResetForgetsTheLastCue() {
        XCTAssertFalse(decide("navigating", turn: "left", at: 0).isEmpty)
        policy.reset()
        XCTAssertFalse(decide("navigating", turn: "left", at: 0.1).isEmpty)
    }

    func testRouteCueSurvivesTheWire() throws {
        let cue = RouteCue(role: .back, kind: .forward, atNode: "n1")
        let data = try JSONEncoder().encode(PeerMessage.route(cue))
        guard case .route(let decoded) = try JSONDecoder().decode(PeerMessage.self, from: data) else {
            return XCTFail("Expected a route message")
        }
        XCTAssertEqual(decoded, cue)
    }
}
