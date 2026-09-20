import XCTest
@testable import NavigationAssistant

@MainActor
final class LocalizationReporterTests: XCTestCase {
    func testAdoptMirrorsBackendDestinationsWithoutSendingThemBack() {
        let reporter = LocalizationReporter()
        reporter.adopt(destinationId: "note:n1", name: "Bed 1")
        XCTAssertEqual(reporter.destination, GraphNode(id: "note:n1", name: "Bed 1", kind: "destination"))
        XCTAssertNil(reporter.lastProgress)
        reporter.adopt(destinationId: "room-101", name: "Room 101")
        XCTAssertEqual(reporter.destination?.label, "Room 101")
        XCTAssertNil(reporter.destination?.kind)
        reporter.adopt(destinationId: nil, name: nil)
        XCTAssertNil(reporter.destination)
    }

    func testEnsureSessionNeedsAConfiguredBackend() async {
        let reporter = LocalizationReporter()
        do {
            _ = try await reporter.ensureSession()
            XCTFail("expected an error without a backend")
        } catch {
            XCTAssertTrue(error is WanderBackendClient.HTTPError)
        }
        XCTAssertNil(reporter.sessionId)
    }
}
