import XCTest
@testable import NavigationAssistant

@MainActor
final class RoleAndSettingsTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "tests.\(UUID().uuidString)")
    }

    func testRolePersistsAcrossStores() {
        let store = RoleStore(defaults: defaults)
        XCTAssertNil(store.role)
        store.role = .left
        XCTAssertEqual(RoleStore(defaults: defaults).role, .left)
        store.clear()
        XCTAssertNil(RoleStore(defaults: defaults).role)
    }

    func testOnlyFrontUsesCamera() {
        XCTAssertEqual(DeviceRole.allCases.filter(\.usesCamera), [.front])
    }

    func testSettingsRoundTrip() {
        let store = CameraSettingsStore(defaults: defaults, localConfig: [:])
        XCTAssertEqual(store.settings, .default)
        store.settings.captureIntervalMs = 350
        store.settings.nianticToken = "abc"
        let reloaded = CameraSettingsStore(defaults: defaults, localConfig: [:])
        XCTAssertEqual(reloaded.settings.captureIntervalMs, 350)
        XCTAssertEqual(reloaded.settings.captureInterval, 0.35, accuracy: 0.0001)
        XCTAssertTrue(reloaded.settings.hasNianticCredentials)
    }

    func testDefaultsAreTwoHundredMillisecondsAndNoCredentials() {
        let s = CameraSettings.default
        XCTAssertEqual(s.captureIntervalMs, 200)
        XCTAssertEqual(s.obstacleRangeMeters, 5.0)
        XCTAssertFalse(s.hasNianticCredentials)
        XCTAssertNil(s.validationError)
    }

    func testValidationCatchesBadValues() {
        var s = CameraSettings.default
        s.captureIntervalMs = 10
        XCTAssertNotNil(s.validationError)
        s = .default
        s.nianticEndpoint = "not a url"
        XCTAssertNotNil(s.validationError)
    }

    func testARConfigurationReflectsSettings() {
        var s = CameraSettings.default
        s.sceneDepthEnabled = false
        let config = s.makeARConfiguration()
        XCTAssertTrue(config.frameSemantics.isDisjoint(with: [.sceneDepth, .smoothedSceneDepth]))
        // Without depth, walls come from vertical plane detection for the structure estimator.
        XCTAssertEqual(config.planeDetection, [.vertical])
    }

    func testTransportSelectionFollowsCredentials() {
        var s = CameraSettings.default
        XCTAssertTrue(LocalizationQueryLoop.makeTransport(settings: s) is LoggingTransport)
        s.nianticToken = "token"
        XCTAssertTrue(LocalizationQueryLoop.makeTransport(settings: s) is NianticRESTTransport)
    }
}
