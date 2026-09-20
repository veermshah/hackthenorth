import Foundation

/// Turns the backend's route progress into a buzz that **pushes** the wearer: the mount that
/// fires is the one shoving them, and they move away from it.
///
///     back buzzes  -> walk forward        right buzzes -> move left
///     chest buzzes -> turn around         left buzzes  -> move right
///
/// Nothing has to be learned; a shove already means "go the other way". Arrival fires every
/// mount together, because a push from all sides is a push nowhere.
///
/// Pure, so the thresholds can be tuned and tested without a Taptic Engine.
///
/// `instruction.turn` is recomputed on every pose from the wearer's *current* heading towards
/// the next node, so this is steering rather than a schedule: the push keeps coming while they
/// face the wrong way and stops once they are pointed down the leg. Drift under 45 degrees is
/// ignored unless `cueSlightTurns` is on — a blind walker wanders a little with every step, and
/// a mount that buzzes constantly stops meaning anything.
struct RouteCuePolicy {
    /// The same nudge is not re-sent inside this window, so a wearer who is slow to correct
    /// gets a reminder rather than a stutter.
    var repeatInterval: TimeInterval = 5
    /// Whether a 20–45 degree correction is worth a push. Off: those are walking noise.
    var cueSlightTurns = false
    /// Tap the back mount when a correction lands, to say "that is it, walk on". Only ever
    /// straight after a turn push at the same node — an ungated forward cue would buzz all the
    /// way down a straight leg and mean nothing.
    var confirmForward = true

    /// node, signal key and when it fired. Keyed on the signal rather than the mount so that a
    /// turn tightening from "right" to "sharp-right" is the same instruction and does not re-buzz.
    private var lastCue: (node: String, key: String, at: TimeInterval)?

    /// The mount whose buzz pushes the wearer the way `turn` wants them to go, with a key
    /// naming the signal. Nil when the turn deserves no push.
    static func push(for turn: String, cueSlightTurns: Bool = false) -> (role: DeviceRole, key: String)? {
        // Pushed from the front: back off and turn around.
        if turn == "u-turn" { return (.front, "turn:around") }
        // Pushed from behind: walk on. Gated in `decide`, never sent on its own.
        if turn == "straight" { return (.back, "forward") }
        if turn.hasPrefix("slight-"), !cueSlightTurns { return nil }
        // Pushed from the side opposite the one they should move towards.
        if turn.hasSuffix("left") { return (.right, "turn:left") }
        if turn.hasSuffix("right") { return (.left, "turn:right") }
        return nil
    }

    /// The mounts to buzz, empty when nothing should be felt: no usable progress, no direction
    /// to give, that mount is not linked, or the same nudge went out moments ago.
    ///
    /// `connected` is the front phone's live peer list. The chest phone is always reachable —
    /// it owns the haptics it would play — so it is never filtered out.
    mutating func decide(_ progress: ProgressUpdate?, connected: [DeviceRole],
                         now: TimeInterval = Date().timeIntervalSince1970) -> [RouteCue] {
        guard let progress else { return [] }
        let node: String, key: String, kind: RouteCue.Kind
        var roles: [DeviceRole]

        switch progress.state {
        case "arrived":
            guard let atNode = progress.instruction?.atNode ?? progress.nextNode?.id else { return [] }
            (node, key, kind) = (atNode, "arrive", .arrive)
            roles = [.front] + connected.filter { $0 != .front }
        case "navigating":
            guard let instruction = progress.instruction,
                  let push = Self.push(for: instruction.turn, cueSlightTurns: cueSlightTurns) else { return [] }
            node = instruction.atNode
            key = push.key
            if key == "forward" {
                guard confirmForward, let last = lastCue, last.node == node,
                      last.key.hasPrefix("turn:") else { return [] }
                kind = .forward
            } else {
                kind = .turn
            }
            roles = [push.role]
        default:
            // localizing, off-route and lost carry no trustworthy heading. Forget the last cue
            // so the reroute that follows is felt at once instead of hitting the repeat window.
            lastCue = nil
            return []
        }

        roles = roles.filter { $0 == .front || connected.contains($0) }
        guard !roles.isEmpty else { return [] }
        if let last = lastCue, last.node == node, last.key == key, now - last.at < repeatInterval {
            return []
        }
        lastCue = (node, key, now)
        return roles.map { RouteCue(role: $0, kind: kind, atNode: node) }
    }

    /// Guidance changed or stopped: forget what was cued so the next route starts clean.
    mutating func reset() { lastCue = nil }
}
