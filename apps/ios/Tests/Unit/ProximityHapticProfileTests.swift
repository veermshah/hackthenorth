import XCTest
@testable import NavigationAssistant

final class ProximityHapticProfileTests: XCTestCase {
    let profile = ProximityHapticProfile()

    func testNothingBeyondFarDistance() {
        XCTAssertNil(profile.pulse(for: 1.6))
        XCTAssertNil(profile.pulse(for: nil))
        XCTAssertNotNil(profile.pulse(for: 1.5))
    }

    func testCloserIsFasterAndAlwaysFullStrength() {
        let far = profile.pulse(for: 1.4)!
        let mid = profile.pulse(for: 0.8)!
        let near = profile.pulse(for: 0.35)!
        XCTAssertGreaterThan(far.interval, mid.interval)
        XCTAssertGreaterThan(mid.interval, near.interval)
        for pulse in [far, mid, near] {
            XCTAssertEqual(pulse.intensity, 1.0, accuracy: 0.001, "every buzz is full strength")
            XCTAssertLessThan(pulse.duration, pulse.interval, "buzzes never overlap")
            XCTAssertGreaterThanOrEqual(pulse.duration, 0.1, "long enough to feel through fabric")
        }
    }

    func testEndpointsClamp() {
        let touching = profile.pulse(for: 0.0)!
        XCTAssertEqual(touching.interval, profile.nearInterval, accuracy: 0.0001)
        XCTAssertEqual(touching.intensity, profile.nearIntensity, accuracy: 0.0001)
        XCTAssertEqual(touching.sharpness, profile.nearSharpness, accuracy: 0.0001)
        let edge = profile.pulse(for: profile.farDistance)!
        XCTAssertEqual(edge.interval, profile.farInterval, accuracy: 0.0001)
        XCTAssertEqual(edge.intensity, profile.farIntensity, accuracy: 0.0001)
    }

    func testSpeedUpIsGradual() {
        // Halfway in distance is halfway in interval: a steady ramp, not a late jump.
        let half = profile.pulse(for: 0.9)!
        let midpoint = (profile.farInterval + profile.nearInterval) / 2
        XCTAssertEqual(half.interval, midpoint, accuracy: 0.01)
    }

    func testProfileSpanningARangeStartsAtItsEdge() {
        let short = ProximityHapticProfile.spanning(0.4)
        XCTAssertNil(short.pulse(for: 0.45))
        XCTAssertEqual(short.pulse(for: 0.4)!.interval, short.farInterval, accuracy: 0.0001)
        XCTAssertEqual(short.pulse(for: 0.1)!.interval, short.nearInterval, accuracy: 0.0001)
        XCTAssertGreaterThan(short.pulse(for: 0.3)!.interval, short.pulse(for: 0.2)!.interval)
    }
}
