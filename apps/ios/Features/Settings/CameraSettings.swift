import Foundation
import ARKit

/// One set of camera and capture settings shared by obstacle detection and the
/// Niantic query loop, so both consumers see the same ARKit session configuration.
struct CameraSettings: Codable, Equatable, Sendable {
    /// Preferred ARKit video frame rate. Falls back to the first supported format.
    var preferredFrameRate: Int = 60
    /// Request LiDAR scene depth when the device supports it.
    var sceneDepthEnabled: Bool = true
    /// Use ARKit's temporally smoothed depth instead of raw depth.
    var smoothedDepth: Bool = false
    /// Farthest obstacle distance the detector reports, in metres. LiDAR is reliable to about 5 m.
    var obstacleRangeMeters: Double = 5.0
    /// A scanned wall or hazard closer than this beside the wearer pulses that shoulder phone.
    var sideBuzzRangeMeters: Double = 0.6
    /// Spoken cues (route notes, readiness). Off: the app is haptics only.
    var voiceCuesEnabled: Bool = false
    /// Left and right phones run LiDAR and report clearance to the front phone.
    /// Kept for stored-settings compatibility; side phones no longer sense. Their
    /// buzzes come from the front phone's localisation against the world map.
    var sidePhonesSenseObstacles: Bool = false
    /// How often the front phone snapshots a frame for Niantic, in milliseconds.
    var captureIntervalMs: Int = 200
    /// JPEG quality for uploaded frames, 0...1.
    var jpegQuality: Double = 0.6
    /// Longest side of the uploaded image, in pixels.
    var maxImageDimension: Int = 640
    /// Niantic Spatial endpoint the snapshots are posted to.
    var nianticEndpoint: String = "https://api.nianticspatial.com/web/v1/localize"
    /// Developer token from Scaniverse web. Empty means queries are logged, not sent.
    var nianticToken: String = ""
    /// Scaniverse Site the phone localizes against. Empty disables NSDK localization.
    var nianticSiteId: String = ""
    /// Wander backend (FastAPI on Modal). Fixes are posted here.
    var backendURL: String = ""
    /// Shared X-API-Key for the backend.
    var backendAPIKey: String = ""
    /// Backend world to localize into. Empty means look it up by Niantic site ID.
    var worldId: String = ""
    /// Mirror every VPS image query the SDK issues (frame + result) to the backend so the
    /// dashboard can show what the phone saw and where it was localized.
    var uploadQueryImages: Bool = true
    /// Also upload queries that failed or were rejected, not just successful fixes.
    var uploadFailedQueries: Bool = true
    /// Live voice guide over the backend's GPT-Live bridge (shared/contracts/voice.md).
    var voiceAgentEnabled: Bool = false
    /// Demo access token the voice socket expects in its first message; never the OpenAI key.
    var voiceAccessToken: String = ""
    /// Start the call together with the camera pipeline so the wearer never has to find a button.
    var voiceAgentAutoStart: Bool = true

    static let `default` = CameraSettings()

    init() {}

    /// Tolerant decoding: settings persisted by an older build simply keep the defaults for new keys.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = CameraSettings()
        preferredFrameRate = try c.decodeIfPresent(Int.self, forKey: .preferredFrameRate) ?? d.preferredFrameRate
        sceneDepthEnabled = try c.decodeIfPresent(Bool.self, forKey: .sceneDepthEnabled) ?? d.sceneDepthEnabled
        smoothedDepth = try c.decodeIfPresent(Bool.self, forKey: .smoothedDepth) ?? d.smoothedDepth
        obstacleRangeMeters = try c.decodeIfPresent(Double.self, forKey: .obstacleRangeMeters) ?? d.obstacleRangeMeters
        sideBuzzRangeMeters = try c.decodeIfPresent(Double.self, forKey: .sideBuzzRangeMeters) ?? d.sideBuzzRangeMeters
        voiceCuesEnabled = try c.decodeIfPresent(Bool.self, forKey: .voiceCuesEnabled) ?? d.voiceCuesEnabled
        sidePhonesSenseObstacles = try c.decodeIfPresent(Bool.self, forKey: .sidePhonesSenseObstacles) ?? d.sidePhonesSenseObstacles
        captureIntervalMs = try c.decodeIfPresent(Int.self, forKey: .captureIntervalMs) ?? d.captureIntervalMs
        jpegQuality = try c.decodeIfPresent(Double.self, forKey: .jpegQuality) ?? d.jpegQuality
        maxImageDimension = try c.decodeIfPresent(Int.self, forKey: .maxImageDimension) ?? d.maxImageDimension
        nianticEndpoint = try c.decodeIfPresent(String.self, forKey: .nianticEndpoint) ?? d.nianticEndpoint
        nianticToken = try c.decodeIfPresent(String.self, forKey: .nianticToken) ?? d.nianticToken
        nianticSiteId = try c.decodeIfPresent(String.self, forKey: .nianticSiteId) ?? d.nianticSiteId
        backendURL = try c.decodeIfPresent(String.self, forKey: .backendURL) ?? d.backendURL
        backendAPIKey = try c.decodeIfPresent(String.self, forKey: .backendAPIKey) ?? d.backendAPIKey
        worldId = try c.decodeIfPresent(String.self, forKey: .worldId) ?? d.worldId
        uploadQueryImages = try c.decodeIfPresent(Bool.self, forKey: .uploadQueryImages) ?? d.uploadQueryImages
        uploadFailedQueries = try c.decodeIfPresent(Bool.self, forKey: .uploadFailedQueries) ?? d.uploadFailedQueries
        voiceAgentEnabled = try c.decodeIfPresent(Bool.self, forKey: .voiceAgentEnabled) ?? d.voiceAgentEnabled
        voiceAccessToken = try c.decodeIfPresent(String.self, forKey: .voiceAccessToken) ?? d.voiceAccessToken
        voiceAgentAutoStart = try c.decodeIfPresent(Bool.self, forKey: .voiceAgentAutoStart) ?? d.voiceAgentAutoStart
    }

    var captureInterval: TimeInterval { Double(captureIntervalMs) / 1000 }

    /// The endpoint as a URL, only when it is an absolute http(s) URL with a host.
    var endpointURL: URL? {
        guard let components = URLComponents(string: nianticEndpoint),
              let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = components.host, !host.isEmpty,
              !nianticEndpoint.contains(" ") else { return nil }
        return components.url
    }

    var hasNianticCredentials: Bool {
        !nianticToken.trimmingCharacters(in: .whitespaces).isEmpty && endpointURL != nil
    }

    /// NSDK localization needs a developer token and a Site.
    var canLocalizeWithNSDK: Bool {
        !nianticToken.trimmingCharacters(in: .whitespaces).isEmpty
            && !nianticSiteId.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var backendBaseURL: URL? {
        let trimmed = backendURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed), url.host != nil else { return nil }
        return url
    }

    var hasBackend: Bool { backendBaseURL != nil && !backendAPIKey.isEmpty }

    /// A call can be placed: the toggle is on and the backend plus its voice token are configured.
    var canStartVoiceCall: Bool {
        voiceAgentEnabled && hasBackend && !voiceAccessToken.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Fills empty fields from Resources/LocalConfig.plist so secrets stay out of git.
    mutating func seed(from config: [String: Any]) {
        func take(_ key: String, _ path: WritableKeyPath<CameraSettings, String>) {
            if self[keyPath: path].isEmpty, let value = config[key] as? String, !value.isEmpty {
                self[keyPath: path] = value
            }
        }
        take("NianticToken", \.nianticToken)
        take("NianticSiteId", \.nianticSiteId)
        take("BackendURL", \.backendURL)
        take("BackendAPIKey", \.backendAPIKey)
        take("WorldId", \.worldId)
        take("VoiceAccessToken", \.voiceAccessToken)
    }

    static func localConfig(bundle: Bundle = .main) -> [String: Any] {
        guard let url = bundle.url(forResource: "LocalConfig", withExtension: "plist"),
              let data = try? Data(contentsOf: url),
              let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return [:] }
        return dict
    }

    /// The single ARKit configuration every consumer runs against.
    func makeARConfiguration() -> ARWorldTrackingConfiguration {
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = []
        config.isAutoFocusEnabled = true
        config.worldAlignment = .gravity

        if sceneDepthEnabled {
            if smoothedDepth, ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
                config.frameSemantics.insert(.smoothedSceneDepth)
            } else if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
                config.frameSemantics.insert(.sceneDepth)
            }
        }

        let formats = ARWorldTrackingConfiguration.supportedVideoFormats
        if let match = formats.first(where: { $0.framesPerSecond == preferredFrameRate }) {
            config.videoFormat = match
        } else if let first = formats.first {
            config.videoFormat = first
        }
        if config.frameSemantics.isDisjoint(with: [.sceneDepth, .smoothedSceneDepth]) {
            // No LiDAR: detected walls feed the structure-based obstacle estimate.
            config.planeDetection = [.vertical]
        }
        return config
    }

    /// Validation used by the settings form and tests.
    var validationError: String? {
        if captureIntervalMs < 50 { return "Capture interval must be at least 50 ms." }
        if !(0.1...1.0).contains(jpegQuality) { return "JPEG quality must be between 0.1 and 1.0." }
        if maxImageDimension < 160 { return "Image dimension must be at least 160 px." }
        if !(1.0...5.0).contains(obstacleRangeMeters) { return "Obstacle range must be between 1 and 5 m." }
        if endpointURL == nil { return "Endpoint must be an http(s) URL." }
        return nil
    }
}

/// Loads and saves `CameraSettings` as JSON in UserDefaults.
@MainActor
final class CameraSettingsStore: ObservableObject {
    nonisolated static let key = "cameraSettings.v1"

    @Published var settings: CameraSettings {
        didSet { persist() }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard, localConfig: [String: Any] = CameraSettings.localConfig()) {
        self.defaults = defaults
        var loaded: CameraSettings
        if let data = defaults.data(forKey: Self.key),
           let decoded = try? JSONDecoder().decode(CameraSettings.self, from: data) {
            loaded = decoded
        } else {
            loaded = .default
        }
        loaded.seed(from: localConfig)
        settings = loaded
    }

    /// Stable per-install identifier sent to the backend as `deviceId`.
    var deviceId: String {
        if let id = defaults.string(forKey: "deviceId") { return id }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: "deviceId")
        return id
    }

    func reset() { settings = .default }

    private func persist() {
        if let data = try? JSONEncoder().encode(settings) {
            defaults.set(data, forKey: Self.key)
        }
    }

    nonisolated static func clearPersisted(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }
}
