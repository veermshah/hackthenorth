import Foundation

/// Maps obstacle distance to a pulse. Closer means faster. Every pulse is a
/// full-strength continuous buzz rather than a tap, so it is felt through a
/// pocket or a strap; only the rhythm carries the distance.
/// Pure so the curve can be tuned and unit tested without a Taptic Engine.
struct ProximityHapticProfile: Equatable, Sendable {
    /// Beyond this distance nothing pulses.
    var farDistance: Float = 1.5
    /// At or inside this distance the pulse is at its maximum.
    var nearDistance: Float = 0.3
    /// Seconds from the start of one buzz to the start of the next, at the far and near ends.
    var farInterval: TimeInterval = 1.0
    var nearInterval: TimeInterval = 0.18
    /// How long each buzz lasts at the far and near ends. Always shorter than the interval.
    var farDuration: TimeInterval = 0.35
    var nearDuration: TimeInterval = 0.12
    /// Intensity 0...1 at the far and near ends: always maximum.
    var farIntensity: Float = 1.0
    var nearIntensity: Float = 1.0
    /// Sharpness 0...1. A low value is a deep rumble, which travels through fabric better than a click.
    var farSharpness: Float = 0.3
    var nearSharpness: Float = 0.5

    /// A profile whose ramp spans `range`: slow at the threshold, fastest inside a quarter of it.
    static func spanning(_ range: Float) -> ProximityHapticProfile {
        var profile = ProximityHapticProfile()
        profile.farDistance = max(0.05, range)
        profile.nearDistance = max(0.02, range * 0.25)
        return profile
    }

    struct Pulse: Equatable, Sendable {
        var interval: TimeInterval
        var intensity: Float
        var sharpness: Float
        var duration: TimeInterval = 0.2
    }

    /// 0 at the near distance, 1 at the far distance, clamped.
    func normalized(_ distance: Float) -> Float {
        guard farDistance > nearDistance else { return 0 }
        return min(1, max(0, (distance - nearDistance) / (farDistance - nearDistance)))
    }

    /// Nil when the obstacle is too far to warn about.
    func pulse(for distance: Float?) -> Pulse? {
        guard let distance, distance <= farDistance else { return nil }
        let t = normalized(distance)
        // Interval ramps linearly, so the pulse quickens steadily all the way in.
        let interval = nearInterval + (farInterval - nearInterval) * Double(t)
        let intensity = nearIntensity + (farIntensity - nearIntensity) * t
        let sharpness = nearSharpness + (farSharpness - nearSharpness) * t
        let duration = min(nearDuration + (farDuration - nearDuration) * Double(t), interval * 0.7)
        return Pulse(interval: interval, intensity: intensity, sharpness: sharpness, duration: duration)
    }
}
