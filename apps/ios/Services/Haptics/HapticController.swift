import Foundation
import CoreHaptics
import UIKit

/// Plays haptics on the side and back phones. Supports a one-off buzz and a
/// proximity pulse whose speed, intensity, and sharpness follow the obstacle distance.
@MainActor
final class HapticController: ObservableObject {
    @Published private(set) var isAvailable = false
    @Published private(set) var lastBuzz: Date?
    @Published private(set) var buzzCount = 0
    @Published private(set) var isPulsing = false
    @Published private(set) var currentPulse: ProximityHapticProfile.Pulse?
    @Published private(set) var currentDistance: Float?

    var profile = ProximityHapticProfile()

    private var engine: CHHapticEngine?
    private var pulseTask: Task<Void, Never>?
    private var tapTask: Task<Void, Never>?

    init() {
        isAvailable = CHHapticEngine.capabilitiesForHardware().supportsHaptics
        guard isAvailable else { return }
        do {
            engine = try CHHapticEngine()
            // Haptics only, so the engine stops sharing the audio session: a voice call switches the
            // session to .playAndRecord/.voiceChat and deactivates it on hang-up, which would
            // otherwise stop the buzzes mid-walk on the chest phone.
            engine?.playsHapticsOnly = true
            engine?.resetHandler = { [weak self] in
                Task { @MainActor in try? self?.engine?.start() }
            }
            // Interruptions and app suspension stop the engine; bring it back so buzzing resumes.
            engine?.stoppedHandler = { [weak self] reason in
                guard reason != .engineDestroyed else { return }
                Task { @MainActor in try? self?.engine?.start() }
            }
            try engine?.start()
        } catch {
            print("[Haptics] engine error: \(error)")
            isAvailable = false
        }
    }

    /// A continuous buzz for `duration` seconds at `intensity` 0...1.
    func buzz(duration: TimeInterval = 0.4, intensity: Float = 0.9, sharpness: Float = 0.5) {
        buzzCount += 1
        lastBuzz = Date()
        play(eventType: .hapticContinuous, intensity: intensity, sharpness: sharpness, duration: duration)
    }

    /// Update the obstacle distance. Starts, retunes, or stops the pulse accordingly.
    func setProximity(_ distance: Float?) {
        currentDistance = distance
        let pulse = profile.pulse(for: distance)
        currentPulse = pulse
        guard pulse != nil else {
            stopPulsing()
            return
        }
        guard !isPulsing else { return } // the running loop reads currentPulse each beat
        // An obstacle outranks a route cue on the same mount.
        tapTask?.cancel()
        tapTask = nil
        isPulsing = true
        pulseTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let pulse = self.currentPulse else { break }
                self.buzzCount += 1
                self.lastBuzz = Date()
                // A full-strength continuous buzz, not a tap: taps are lost in a pocket.
                self.play(eventType: .hapticContinuous, intensity: pulse.intensity, sharpness: pulse.sharpness,
                          duration: pulse.duration)
                try? await Task.sleep(for: .seconds(pulse.interval))
            }
            self?.isPulsing = false
        }
    }

    func stopPulsing() {
        pulseTask?.cancel()
        pulseTask = nil
        isPulsing = false
        currentPulse = nil
    }

    /// A short burst of firm bumps: the route's rhythm, told apart from an obstacle by being
    /// a countable burst rather than a pulse that quickens as something nears. Skipped while
    /// this mount is warning about an obstacle, because two meanings felt at once are worse
    /// than one missed — the voice still speaks the turn.
    func tap(times: Int, interval: TimeInterval = 0.18, duration: TimeInterval = 0.09) {
        guard !isPulsing else { return }
        let count = max(1, min(times, 4))
        tapTask?.cancel()
        tapTask = Task { [weak self] in
            for index in 0..<count {
                guard let self, !Task.isCancelled, !self.isPulsing else { return }
                self.buzzCount += 1
                self.lastBuzz = Date()
                // Short and sharp, but still a continuous event: a transient tap is lost
                // through a strap or a pocket, which is where these phones live.
                self.play(eventType: .hapticContinuous, intensity: 1, sharpness: 0.8, duration: duration)
                if index < count - 1 { try? await Task.sleep(for: .seconds(interval)) }
            }
            if !Task.isCancelled { self?.tapTask = nil }
        }
    }

    /// Drop a burst still in flight, e.g. when the screen stops.
    func stopTapping() {
        tapTask?.cancel()
        tapTask = nil
    }

    private func play(eventType: CHHapticEvent.EventType, intensity: Float, sharpness: Float, duration: TimeInterval) {
        guard let engine, isAvailable else {
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
            return
        }
        do {
            let parameters = [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness)
            ]
            let event = eventType == .hapticContinuous
                ? CHHapticEvent(eventType: eventType, parameters: parameters, relativeTime: 0, duration: duration)
                : CHHapticEvent(eventType: eventType, parameters: parameters, relativeTime: 0)
            let pattern = try CHHapticPattern(events: [event], parameters: [])
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            print("[Haptics] play error: \(error)")
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        }
    }
}
