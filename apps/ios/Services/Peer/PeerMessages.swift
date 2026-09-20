import Foundation

/// What a side phone saw in its own LiDAR field of view.
struct SideClearance: Codable, Equatable, Sendable {
    let role: DeviceRole
    /// Nearest obstacle in that phone's view, nil when nothing is in range.
    let nearest: Float?
    /// Seconds since 1970 when it was measured, so stale readings can be ignored.
    let timestamp: TimeInterval
}

/// A one-off buzz requested from outside (the backend's public /haptics endpoints).
struct PulseCommand: Codable, Equatable, Sendable {
    let id: Int
    let role: DeviceRole
    /// Buzz length in milliseconds.
    let ms: Int
}

/// A nudge along the route. The buzzing mount **pushes** the wearer, so they move away from
/// it: behind means walk forward, on the right means move left, on the left means move right,
/// on the chest means turn around. Nothing has to be remembered — the body already reads a
/// shove as "go the other way".
///
/// Arrival is the exception, and fires every mount at once: a push from all sides is a push
/// nowhere, which is the one pattern that cannot be misread as a direction.
///
/// Route cues and obstacle buzzes share the same mounts, so they are told apart by rhythm:
/// this is a short countable burst, an obstacle is a continuous buzz that quickens as it
/// nears. The receiving phone drops a cue while that mount is warning about an obstacle, so
/// the two are never felt at once.
struct RouteCue: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        /// Move away from the mount that buzzed.
        case turn
        /// Back mount: the correction worked, walk on.
        case forward
        /// The destination is reached; every mount fires together.
        case arrive

        /// Taps in the burst. Every push is two; arrival is the odd one out at three.
        var taps: Int { self == .arrive ? 3 : 2 }
    }

    let role: DeviceRole
    let kind: Kind
    /// The route node the cue belongs to, so the same nudge is not sent twice.
    let atNode: String
}

/// Everything that travels between the phones. Small JSON payloads over Multipeer.
enum PeerMessage: Codable, Equatable, Sendable {
    /// Front phone tells side and back phones who should buzz and how close the obstacle is.
    case haptic(HapticCommand)
    /// Front phone tells one mount to tap: turn this way, or you have arrived.
    case route(RouteCue)
    /// Front phone relays an externally triggered one-off buzz to the mount it names.
    case pulse(PulseCommand)
    /// Side phone reports its clearance to the front.
    case clearance(SideClearance)
    /// Sent on connect so the receiver knows which mount the peer is.
    case hello(DeviceRole)
}

