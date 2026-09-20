import XCTest
import simd
@testable import NavigationAssistant

/// VPS answers arrive in bursts with `notTracked` gaps between them while ARKit keeps tracking,
/// so the backend must keep hearing poses through a gap and learn about `lost` only once the
/// anchor has gone unconfirmed for the hold.
final class LocalizationReportPolicyTests: XCTestCase {
    private var policy = LocalizationReportPolicy()
    private let epoch = Date(timeIntervalSince1970: 1_000_000)

    override func setUp() {
        super.setUp()
        policy = LocalizationReportPolicy()
        policy.maxAge = 10
    }

    private func fix(_ state: BackendTrackingState, at seconds: TimeInterval, x: Float = 0) -> LocalizationFix {
        LocalizationFix(pose: SitePose(position: SIMD3<Float>(x, 0, 0), rotation: simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)),
                        state: state, confidence: state == .localized ? 0.9 : 0,
                        timestamp: epoch.addingTimeInterval(seconds), anchorTransform: matrix_identity_float4x4)
    }

    private func at(_ seconds: TimeInterval) -> Date { epoch.addingTimeInterval(seconds) }

    func testANewFixIsPostedOnceThenPosesFollowIt() {
        let tracked = fix(.localized, at: 0)
        XCTAssertEqual(policy.decide(tracked, now: at(0)), .fix(tracked))
        XCTAssertEqual(policy.decide(tracked, now: at(0.2)), .pose(using: tracked))
        XCTAssertEqual(policy.decide(tracked, now: at(0.4)), .pose(using: tracked))
        XCTAssertEqual(policy.reporting, tracked)
    }

    func testAGapKeepsPosesFlowingFromTheHeldAnchor() {
        let tracked = fix(.localized, at: 0)
        _ = policy.decide(tracked, now: at(0))
        // The SDK reports notTracked: the phone keeps the previous pose and stamps the moment.
        let gap = fix(.lost, at: 1)
        XCTAssertEqual(policy.decide(gap, now: at(1)), .pose(using: tracked), "no lost fix reaches the backend")
        XCTAssertEqual(policy.decide(gap, now: at(5)), .pose(using: tracked))
        XCTAssertEqual(policy.decide(gap, now: at(10)), .pose(using: tracked), "the hold is inclusive")
        XCTAssertEqual(policy.reporting, tracked)
    }

    func testLostIsReportedOnceTheHoldExpiresAndThenStaysQuiet() {
        let tracked = fix(.localized, at: 0)
        _ = policy.decide(tracked, now: at(0))
        let gap = fix(.lost, at: 1)
        _ = policy.decide(gap, now: at(1))
        XCTAssertEqual(policy.decide(gap, now: at(10.1)), .fix(gap))
        XCTAssertNil(policy.reporting)
        // Nothing to say while lost: no anchor to post ARKit poses against.
        XCTAssertEqual(policy.decide(gap, now: at(11)), .skip)
        // Each further notTracked update carries a new stamp and is forwarded like before.
        let later = fix(.lost, at: 12)
        XCTAssertEqual(policy.decide(later, now: at(12)), .fix(later))
    }

    func testLimitedIsACoarseAnchorAndTreatedLikeAGap() {
        let tracked = fix(.localized, at: 0)
        _ = policy.decide(tracked, now: at(0))
        let coarse = fix(.limited, at: 2, x: 30)
        XCTAssertEqual(policy.decide(coarse, now: at(2)), .pose(using: tracked), "the coarse anchor is not used while the tracked one is fresh")
        XCTAssertEqual(policy.decide(coarse, now: at(11)), .fix(coarse))
        XCTAssertEqual(policy.decide(coarse, now: at(11.2)), .pose(using: coarse), "limited poses still flow; the backend decides what they mean")
    }

    func testANewTrackedFixDuringAGapRestartsTheHold() {
        _ = policy.decide(fix(.localized, at: 0), now: at(0))
        _ = policy.decide(fix(.lost, at: 1), now: at(1))
        let again = fix(.localized, at: 8, x: 1)
        XCTAssertEqual(policy.decide(again, now: at(8)), .fix(again))
        XCTAssertEqual(policy.decide(fix(.lost, at: 9), now: at(17)), .pose(using: again))
        XCTAssertEqual(policy.reporting, again)
    }

    func testResetForgetsEverything() {
        let tracked = fix(.localized, at: 0)
        _ = policy.decide(tracked, now: at(0))
        policy.reset()
        XCTAssertNil(policy.reporting)
        XCTAssertEqual(policy.decide(tracked, now: at(1)), .fix(tracked), "the same fix is new to a fresh session")
    }
}
