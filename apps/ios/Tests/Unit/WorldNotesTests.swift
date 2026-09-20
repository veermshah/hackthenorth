import XCTest
import simd
@testable import NavigationAssistant

final class WorldNotesTests: XCTestCase {
    private func note(_ id: String, _ position: [Float]) -> WorldNote {
        WorldNote(id: id, title: id.capitalized, location: nil, description: nil,
                  position: position, author: nil, createdAt: "2026-09-19T12:00:00Z")
    }

    private func pose(_ position: SIMD3<Float>, yawDeg: Float = 0) -> SitePose {
        SitePose(position: position,
                 rotation: simd_quatf(angle: yawDeg * .pi / 180, axis: SIMD3<Float>(0, 1, 0)))
    }

    /// Facing the camera's default −Z: straight ahead, hard right, hard left, behind.
    func testBearingsAroundAnUnrotatedDevice() {
        let notes = [note("ahead", [0, 0, -5]), note("right", [5, 0, 0]),
                     note("left", [-5, 0, 0]), note("behind", [0, 0, 5])]
        let ranked = NoteGeometry.bearings(for: notes, from: pose(.zero))
        let byId = Dictionary(uniqueKeysWithValues: ranked.map { ($0.note.id, $0) })

        XCTAssertEqual(byId["ahead"]!.bearingDeg, 0, accuracy: 0.01)
        XCTAssertEqual(byId["right"]!.bearingDeg, 90, accuracy: 0.01)
        XCTAssertEqual(byId["left"]!.bearingDeg, -90, accuracy: 0.01)
        XCTAssertEqual(abs(byId["behind"]!.bearingDeg), 180, accuracy: 0.01)
        XCTAssertEqual(byId["ahead"]!.side, .ahead)
        XCTAssertEqual(byId["right"]!.side, .right)
        XCTAssertEqual(byId["left"]!.side, .left)
        XCTAssertEqual(byId["behind"]!.side, .behind)
        for bearing in ranked { XCTAssertEqual(bearing.distance, 5, accuracy: 1e-4) }
    }

    /// Yawed 90° about +Y the device faces −X, so a note at −Z is now on its right.
    func testBearingFollowsDeviceHeading() {
        let ranked = NoteGeometry.bearings(for: [note("a", [0, 0, -5]), note("b", [-5, 0, 0])],
                                           from: pose(.zero, yawDeg: 90))
        let byId = Dictionary(uniqueKeysWithValues: ranked.map { ($0.note.id, $0) })
        XCTAssertEqual(byId["a"]!.bearingDeg, 90, accuracy: 0.01)
        XCTAssertEqual(byId["a"]!.side, .right)
        XCTAssertEqual(byId["b"]!.bearingDeg, 0, accuracy: 0.01)
        XCTAssertEqual(byId["b"]!.side, .ahead)
    }

    /// Height is reported separately and must not leak into the horizontal bearing.
    func testHeightIsSeparateFromBearingAndSortsNearestFirst() {
        let ranked = NoteGeometry.bearings(
            for: [note("far", [0, 0, -12]), note("high", [0, 2, -4]), note("near", [1, 0, -1])],
            from: pose(SIMD3<Float>(0, 0, 0)))
        XCTAssertEqual(ranked.map(\.note.id), ["near", "high", "far"])
        let high = ranked[1]
        XCTAssertEqual(high.bearingDeg, 0, accuracy: 0.01)
        XCTAssertEqual(high.heightDelta, 2, accuracy: 1e-4)
        XCTAssertEqual(high.distance, sqrt(20), accuracy: 1e-4)
    }

    /// The pose's own position is subtracted, so bearings are relative, not absolute.
    func testBearingIsRelativeToTheDevicePosition() {
        let ranked = NoteGeometry.bearings(for: [note("a", [2, 1, -9])],
                                           from: pose(SIMD3<Float>(2, 1, -3)))
        XCTAssertEqual(ranked[0].distance, 6, accuracy: 1e-4)
        XCTAssertEqual(ranked[0].bearingDeg, 0, accuracy: 0.01)
        XCTAssertEqual(ranked[0].heightDelta, 0, accuracy: 1e-4)
    }

    @MainActor
    func testStoreAnnouncesOnceUntilTheWearerLeavesTheRadius() {
        // 3 m ahead, inside announceWithin.
        let store = WorldNotesStore(notes: [note("door", [0, 0, -3])])

        XCTAssertEqual(store.update(pose: pose(.zero)).map(\.note.id), ["door"])
        // Still close: already announced, so it stays quiet.
        XCTAssertTrue(store.update(pose: pose(.zero)).isEmpty)
        // Walked past it but not yet beyond announceAgainBeyond.
        XCTAssertTrue(store.update(pose: pose(SIMD3<Float>(0, 0, 3))).isEmpty)
        // Well clear, then back again: it announces a second time.
        XCTAssertTrue(store.update(pose: pose(SIMD3<Float>(0, 0, 8))).isEmpty)
        XCTAssertEqual(store.update(pose: pose(.zero)).map(\.note.id), ["door"])
    }

    @MainActor
    func testNoPoseClearsBearingsAndSaysNothing() {
        let store = WorldNotesStore(notes: [note("door", [0, 0, -3])])
        XCTAssertFalse(store.update(pose: pose(.zero)).isEmpty)
        XCTAssertTrue(store.update(pose: nil).isEmpty)
        XCTAssertTrue(store.bearings.isEmpty)
    }

    func testSpokenCueNamesDistanceAndSide() {
        let ranked = NoteGeometry.bearings(for: [note("kerb", [4, 0, 0])], from: pose(.zero))
        XCTAssertEqual(ranked[0].spokenCue, "Kerb, 4 metres on your right.")
    }

    func testNotesDecodeFromTheContractPayload() throws {
        let json = Data("""
        {"schema":"wander.notes/v1","worldId":"demo","notes":[
          {"id":"n1","title":"Broken handrail","location":"Stairwell B",
           "position":[1.5,0,-2],"createdAt":"2026-09-19T12:00:00Z"}]}
        """.utf8)
        struct File: Decodable { let notes: [WorldNote] }
        let notes = try JSONDecoder().decode(File.self, from: json).notes
        XCTAssertEqual(notes.count, 1)
        XCTAssertEqual(notes[0].title, "Broken handrail")
        XCTAssertEqual(notes[0].location, "Stairwell B")
        XCTAssertNil(notes[0].description)
        XCTAssertEqual(notes[0].point, SIMD3<Float>(1.5, 0, -2))
    }
}
