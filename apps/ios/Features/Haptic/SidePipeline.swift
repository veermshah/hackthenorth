import Foundation
import ARKit
import Combine
import UIKit

/// Side and back phones: stay linked to the front phone, buzz on command, and on
/// the left and right mounts also run LiDAR and stream clearance to the front.
@MainActor
final class SidePipeline: ObservableObject {
    @Published private(set) var zones: ObstacleZones = .empty
    @Published private(set) var lastCommand: HapticCommand = .none
    @Published private(set) var reportsSent = 0
    /// One-off buzzes relayed from the backend's public /haptics endpoints.
    @Published private(set) var pulsesReceived = 0
    /// What the structure estimator saw on the last frame (non-LiDAR phones).
    @Published private(set) var structureStats = StructureObstacleEstimator.Stats()
    private var wantsSensing = false

    /// True only while ARKit is actually delivering frames.
    var isSensing: Bool { arSession.state == .running && arSession.frameCount > 0 }

    let role: DeviceRole
    let link: PeerLink
    let haptics = HapticController()
    let arSession = ARSessionController()

    private var detector = ObstacleDetector()
    private var estimator = StructureObstacleEstimator()
    private var lastDetection: TimeInterval = 0
    private let detectionInterval: TimeInterval = 1.0 / 10
    private var lastReport: TimeInterval = 0
    private let reportInterval: TimeInterval = 0.2
    private var forwarding = Set<AnyCancellable>()
    private var statusTask: Task<Void, Never>?
    /// Fallback for externally triggered pulses when the front phone is not linked:
    /// poll the backend directly for this mount's role.
    private var pollTask: Task<Void, Never>?
    private var lastPulseId = 0
    @Published private(set) var pollingBackend = false

    /// Side phones never run the camera. Their buzzes come from the front phone's
    /// localisation against the world map (walls and annotated hazards beside the wearer).
    var canSense: Bool { false }

    init(role: DeviceRole) {
        self.role = role
        link = PeerLink(role: role)
        link.onMessage = { [weak self] message, _ in self?.handle(message) }
        arSession.addFrameHandler { [weak self] frame in self?.handle(frame) }
        for child in [link.objectWillChange.eraseToAnyPublisher(),
                      haptics.objectWillChange.eraseToAnyPublisher(),
                      arSession.objectWillChange.eraseToAnyPublisher()] {
            child.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &forwarding)
        }
    }

    func start(settings: CameraSettings) {
        link.start()
        pollPulses(settings: settings)
        detector.maxRange = Float(settings.obstacleRangeMeters)
        estimator.maxRange = Float(settings.obstacleRangeMeters)
        wantsSensing = canSense && settings.sidePhonesSenseObstacles
        if wantsSensing { arSession.start(settings: settings) }
        UIApplication.shared.isIdleTimerDisabled = true
        statusTask?.cancel()
        statusTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self else { break }
                let z = self.zones
                let fmt: (Float?) -> String = { $0.map { String(format: "%.2f", $0) } ?? "-" }
                print("[side \(self.role.rawValue)] ar=\(self.arSession.state) frames=\(self.arSession.frameCount) depth=\(self.arSession.depthAvailable) L=\(fmt(z.left)) C=\(fmt(z.center)) R=\(fmt(z.right)) touching=\(z.touching) pulses=\(self.pulsesReceived) pts=\(self.estimator.stats.rawPoints)/\(self.estimator.stats.inFan) planes=\(self.estimator.stats.planes) tilted=\(self.estimator.stats.tilted) link=\(self.link.connectedRoles.map(\.rawValue)) sent=\(self.link.messagesSent) recv=\(self.link.messagesReceived) cmd=\(self.lastCommand.shouldBuzz(self.role) ? "buzz" : "quiet") err=\(self.link.lastError ?? "-")")
            }
        }
    }

    private func pollPulses(settings: CameraSettings) {
        pollTask?.cancel()
        pollingBackend = false
        guard let base = settings.backendBaseURL, !settings.backendAPIKey.isEmpty else { return }
        let client = WanderBackendClient(baseURL: base, apiKey: settings.backendAPIKey)
        pollingBackend = true
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard let self else { break }
                guard let feed = try? await client.pendingPulses(since: self.lastPulseId) else { continue }
                if feed.last < self.lastPulseId { self.lastPulseId = feed.last }
                // Linked: the front relays pulses over the link, so only advance the cursor.
                let linked = self.link.connectedRoles.contains(.front)
                for pulse in feed.pulses {
                    self.lastPulseId = max(self.lastPulseId, pulse.id)
                    guard !linked, pulse.role == self.role.rawValue else { continue }
                    self.pulsesReceived += 1
                    print("[pulse] received #\(pulse.id) \(pulse.ms) ms via backend")
                    self.haptics.buzz(duration: Double(pulse.ms) / 1000, intensity: 1, sharpness: 0.4)
                }
            }
        }
    }

    func stop() {
        link.stop()
        arSession.stop()
        haptics.stopPulsing()
        wantsSensing = false
        statusTask?.cancel()
        pollTask?.cancel()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    func applySettings(_ settings: CameraSettings) {
        detector.maxRange = Float(settings.obstacleRangeMeters)
        estimator.maxRange = Float(settings.obstacleRangeMeters)
        let shouldSense = canSense && settings.sidePhonesSenseObstacles
        if shouldSense, !wantsSensing {
            wantsSensing = true
            arSession.start(settings: settings)
        } else if !shouldSense, wantsSensing {
            wantsSensing = false
            arSession.stop()
            zones = .empty
        }
    }

    private func handle(_ message: PeerMessage) {
        if case .pulse(let pulse) = message {
            guard pulse.role == role else { return }
            pulsesReceived += 1
            print("[pulse] received #\(pulse.id) \(pulse.ms) ms")
            haptics.buzz(duration: Double(pulse.ms) / 1000, intensity: 1, sharpness: 0.4)
            return
        }
        guard case .haptic(let command) = message else { return }
        lastCommand = command
        if let range = role == .back ? command.backRange : command.sideRange {
            haptics.profile = .spanning(range)
        }
        haptics.setProximity(command.shouldBuzz(role) ? (command.distance(for: role) ?? 0.5) : nil)
    }

    private func handle(_ frame: FrameSnapshot) {
        guard frame.timestamp - lastDetection >= detectionInterval else { return }
        lastDetection = frame.timestamp
        if let depth = frame.depthMap {
            zones = detector.analyze(depthMap: depth)
        } else {
            zones = estimator.analyze(points: frame.featurePoints, identifiers: frame.featurePointIDs, planes: frame.verticalPlanes,
                                      cameraTransform: frame.cameraTransform, timestamp: frame.timestamp)
            if estimator.stats != structureStats { structureStats = estimator.stats }
        }
        guard frame.timestamp - lastReport >= reportInterval else { return }
        lastReport = frame.timestamp
        let reading = SideClearance(role: role, nearest: zones.closest, timestamp: Date().timeIntervalSince1970)
        link.send(.clearance(reading), to: [.front], reliable: false)
        reportsSent += 1
    }
}
