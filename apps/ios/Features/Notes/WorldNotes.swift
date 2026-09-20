import Foundation
import simd

/// Where one note sits relative to the device, in the site frame.
///
/// Pure value maths so it can be unit tested without ARKit: the device pose and
/// the note position are both in the world frame the backend uses, so the only
/// work is turning the difference into something speakable.
struct NoteBearing: Equatable, Sendable {
    let note: WorldNote
    /// Straight-line distance in metres.
    let distance: Float
    /// Signed angle from the device's forward axis in degrees: negative is left,
    /// positive is right, 0 is dead ahead, ±180 is directly behind.
    let bearingDeg: Float
    /// Note height above (+) or below (−) the camera, in metres.
    let heightDelta: Float

    enum Side: String, Sendable {
        case ahead, left, right, behind

        var spoken: String {
            switch self {
            case .ahead: "ahead"
            case .left: "on your left"
            case .right: "on your right"
            case .behind: "behind you"
            }
        }
    }

    /// Coarse direction. The ±25° "ahead" cone matches the obstacle policy's
    /// centre zone, so a note called out as ahead is one you are walking at.
    var side: Side {
        let angle = abs(bearingDeg)
        if angle <= 25 { return .ahead }
        if angle >= 155 { return .behind }
        return bearingDeg < 0 ? .left : .right
    }

    /// What the phone says when the wearer comes within range.
    var spokenCue: String {
        let metres = distance < 10 ? String(format: "%.0f metre%@", distance.rounded(), distance.rounded() == 1 ? "" : "s")
                                   : String(format: "%.0f metres", distance.rounded())
        return "\(note.title), \(metres) \(side.spoken)."
    }
}

enum NoteGeometry {
    /// Distance and bearing of every note from a device pose, nearest first.
    ///
    /// ARKit cameras look down their own −Z, so forward in the site frame is the
    /// pose rotation applied to (0, 0, −1). Forward and right are flattened onto
    /// the horizontal plane: a note is "left" or "right" of where you are walking,
    /// not of where you happen to be tilting the phone.
    static func bearings(for notes: [WorldNote], from pose: SitePose) -> [NoteBearing] {
        var forward = pose.rotation.act(SIMD3<Float>(0, 0, -1))
        forward.y = 0
        forward = simd_length_squared(forward) < 1e-6 ? SIMD3(0, 0, -1) : simd_normalize(forward)
        // Right-handed, Y up: forward × up is the camera's right.
        let right = simd_normalize(simd_cross(forward, SIMD3<Float>(0, 1, 0)))

        return notes.map { note in
            let delta = note.point - pose.position
            let flat = SIMD3<Float>(delta.x, 0, delta.z)
            let bearing = simd_length_squared(flat) < 1e-8
                ? 0
                : atan2(simd_dot(flat, right), simd_dot(flat, forward)) * 180 / .pi
            return NoteBearing(note: note, distance: simd_length(delta), bearingDeg: bearing, heightDelta: delta.y)
        }
        .sorted { $0.distance < $1.distance }
    }
}

/// Fetches the notes pinned to a world in the web viewer and keeps them ranked
/// against the phone's current pose.
///
/// The list is useful even with no fix at all — it is the only way to read what
/// was written about a building before you get there — so loading never depends
/// on localization. Distances and the spoken cues appear once a pose arrives.
@MainActor
final class WorldNotesStore: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)

        var label: String {
            switch self {
            case .idle: "not loaded"
            case .loading: "loading…"
            case .loaded: "loaded"
            case .failed(let why): why
            }
        }
    }

    @Published private(set) var notes: [WorldNote] = []
    @Published private(set) var state: LoadState = .idle
    /// Notes ranked against the newest pose; empty until the phone localizes.
    @Published private(set) var bearings: [NoteBearing] = []
    @Published private(set) var fetchedAt: Date?

    /// Speak a note when the wearer comes this close…
    var announceWithin: Float = 5
    /// …and allow it again only after they have left this radius, so standing
    /// near a note does not repeat it.
    var announceAgainBeyond: Float = 8

    private var announced: Set<String> = []
    private var loadTask: Task<Void, Never>?

    /// Seeded notes skip the fetch — used by previews and tests.
    init(notes: [WorldNote] = []) {
        self.notes = notes
        self.state = notes.isEmpty ? .idle : .loaded
    }

    var isEmpty: Bool { notes.isEmpty }

    func load(client: WanderBackendClient?, worldId: String?) {
        guard let client, let worldId, !worldId.isEmpty else {
            state = .failed("no world configured")
            return
        }
        loadTask?.cancel()
        state = .loading
        loadTask = Task { [weak self] in
            do {
                let fetched = try await client.notes(worldId: worldId)
                guard let self, !Task.isCancelled else { return }
                self.notes = fetched
                self.state = .loaded
                self.fetchedAt = Date()
                self.announced.removeAll()
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.state = .failed(error.localizedDescription)
            }
        }
    }

    /// Re-rank against a new pose. Returns the notes that just came into range
    /// and should be spoken; the caller owns the speech queue.
    @discardableResult
    func update(pose: SitePose?) -> [NoteBearing] {
        guard let pose, !notes.isEmpty else {
            if !bearings.isEmpty { bearings = [] } // don't republish an already-empty list
            return []
        }
        let ranked = NoteGeometry.bearings(for: notes, from: pose)
        bearings = ranked

        var due: [NoteBearing] = []
        for bearing in ranked {
            let id = bearing.note.id
            if bearing.distance <= announceWithin, !announced.contains(id) {
                announced.insert(id)
                due.append(bearing)
            } else if bearing.distance > announceAgainBeyond {
                announced.remove(id)
            }
        }
        return due
    }

    func reset() {
        loadTask?.cancel()
        loadTask = nil
        notes = []
        bearings = []
        state = .idle
        fetchedAt = nil
        announced.removeAll()
    }
}
