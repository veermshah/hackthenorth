import Foundation
import simd

/// A device pose in the Niantic site frame, ready for the backend.
struct SitePose: Equatable, Sendable {
    var position: SIMD3<Float>
    /// Unit quaternion as x, y, z, w.
    var rotation: simd_quatf

    /// Device pose relative to a tracked anchor: both transforms are in ARKit
    /// world space, so the device in anchor space is anchor⁻¹ · device.
    static func deviceInAnchorFrame(anchor: simd_float4x4, device: simd_float4x4) -> SitePose {
        let relative = anchor.inverse * device
        let position = SIMD3<Float>(relative.columns.3.x, relative.columns.3.y, relative.columns.3.z)
        let rotation = simd_quatf(relative).normalized
        return SitePose(position: position, rotation: rotation)
    }

    var positionArray: [Float] { [position.x, position.y, position.z] }
    var rotationArray: [Float] { [rotation.vector.x, rotation.vector.y, rotation.vector.z, rotation.vector.w] }
}

/// Backend's view of localization quality.
enum BackendTrackingState: String, Codable, Sendable {
    case localized, limited, lost
}

/// What the backend answered to a localization fix.
struct LocalizeResponse: Decodable, Equatable, Sendable {
    struct NearestNode: Decodable, Equatable, Sendable {
        let id: String
        let name: String?
        let distanceMetres: Double
    }
    let sessionId: String
    let worldId: String
    let nearestNode: NearestNode?
    let offGraphMetres: Double?
}

/// Stored record the backend returns for an uploaded image query.
struct LocalizationQueryResponse: Decodable, Equatable, Sendable {
    let id: String
    let worldId: String
    let nearestNode: LocalizeResponse.NearestNode?
    let offGraphMetres: Double?
}

/// A note pinned to a point on the scan in the web viewer, mirroring
/// `notes.schema.json`. Positions are in the world frame, in metres — the same
/// frame `SitePose` reports, so the two can be compared directly.
struct WorldNote: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    /// Human-readable place, e.g. "2nd floor, outside room 204".
    let location: String?
    let description: String?
    let position: [Float]
    let author: String?
    let createdAt: String

    var point: SIMD3<Float> {
        position.count == 3 ? SIMD3(position[0], position[1], position[2]) : .zero
    }
}

struct WorldSummary: Decodable, Sendable {
    let id: String
    let name: String
    let nianticSiteId: String?
}

/// A navigation graph node the user can pick as a destination.
struct GraphNode: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String?
    let kind: String?
    var label: String { name ?? id }
}

/// What the backend answered to a pose update: `progressUpdate` in the contract.
/// `speak` is the exact phrase the phone should say now, if anything.
struct ProgressUpdate: Decodable, Equatable, Sendable {
    struct Instruction: Decodable, Equatable, Sendable {
        let atNode: String
        let turn: String
        let text: String
        let distanceMetres: Double?
    }
    let state: String
    let remainingMetres: Double
    let distanceToNextMetres: Double?
    let nextNode: GraphNode?
    let instruction: Instruction?
    let offRouteMetres: Double?
    let headingDeg: Double?
    let speak: String?
}

/// Talks to the Wander worlds API on Modal. Every request carries the team key.
struct WanderBackendClient: Sendable {
    let baseURL: URL
    let apiKey: String
    var session: URLSession = .shared

    nonisolated(unsafe) private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func timestamp(_ date: Date) -> String { iso.string(from: date) }

    func request(_ method: String, _ path: String, body: [String: Any]? = nil) -> URLRequest {
        request(method, path, data: body.flatMap { try? JSONSerialization.data(withJSONObject: $0) })
    }

    func request(_ method: String, _ path: String, data: Data?) -> URLRequest {
        // Keep any "?query" intact: appendingPathComponent would percent-encode the "?".
        let parts = path.split(separator: "?", maxSplits: 1).map(String.init)
        var url = baseURL.appendingPathComponent(parts[0])
        if parts.count == 2, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.percentEncodedQuery = parts[1]
            url = components.url ?? url
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 8
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let data {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = data
        }
        return request
    }

    /// Body for `POST /worlds/{id}/localize`, matching `localizationUpdate` in the contract.
    static func localizationBody(deviceId: String, role: DeviceRole, siteId: String, pose: SitePose,
                                 confidence: Float, state: BackendTrackingState, timestamp: Date,
                                 sessionId: String?) -> [String: Any] {
        var body: [String: Any] = [
            "deviceId": deviceId,
            "role": role == .front ? "chest" : role.rawValue,
            "nianticSiteId": siteId,
            "pose": ["position": pose.positionArray, "rotation": pose.rotationArray],
            "confidence": max(0, min(1, confidence)),
            "trackingState": state.rawValue,
            "timestamp": Self.timestamp(timestamp)
        ]
        if let sessionId { body["sessionId"] = sessionId }
        return body
    }

    func localize(worldId: String, body: Data) async throws -> LocalizeResponse {
        let (data, response) = try await session.data(for: request("POST", "worlds/\(worldId)/localize", data: body))
        try Self.check(response, data)
        return try JSONDecoder().decode(LocalizeResponse.self, from: data)
    }

    /// Body for `POST /worlds/{id}/localize/query`, matching `localizationQueryUpload` in the contract:
    /// the JPEG the SDK submitted, its request record, and the pose it produced.
    static func queryBody(deviceId: String, role: DeviceRole, siteId: String, sessionId: String?,
                          query: VPSImageQuery, jpeg: Data, imageWidth: Int, imageHeight: Int,
                          currentPose: SitePose?) -> [String: Any] {
        var request: [String: Any] = [
            "identifier": query.id,
            "frameId": Int(clamping: query.frameId),
            "type": query.type.rawValue,
            "status": query.status.rawValue,
            "error": query.error,
            "startedAt": Self.timestamp(query.startedAt),
            "frameMatch": query.frameMatch.rawValue
        ]
        if let ended = query.endedAt { request["endedAt"] = Self.timestamp(ended) }
        if let ms = query.latencyMs { request["latencyMs"] = max(0, ms) }

        var result: [String: Any] = ["trackingState": query.trackingState.rawValue]
        if let anchorState = query.anchorState { result["anchorState"] = anchorState }
        if let confidence = query.confidence { result["confidence"] = max(0, min(1, confidence)) }
        if let pose = query.sitePose { result["pose"] = ["position": pose.positionArray, "rotation": pose.rotationArray] }
        if let currentPose { result["currentPose"] = ["position": currentPose.positionArray, "rotation": currentPose.rotationArray] }

        // The encoder rotates the landscape sensor frame 90° CW into portrait, so the
        // portrait image's horizontal FOV is the sensor's vertical one and vice versa.
        var image: [String: Any] = ["width": imageWidth, "height": imageHeight, "orientation": "portrait"]
        if let fov = Self.portraitFov(intrinsics: query.intrinsics, resolution: query.imageResolution) {
            image["fovDeg"] = ["horizontal": fov.horizontal, "vertical": fov.vertical]
        }

        var body: [String: Any] = [
            "deviceId": deviceId,
            "role": role == .front ? "chest" : role.rawValue,
            "nianticSiteId": siteId,
            "capturedAt": Self.timestamp(query.capturedAt),
            "imageBase64": jpeg.base64EncodedString(),
            "image": image,
            "request": request,
            "result": result
        ]
        if let sessionId { body["sessionId"] = sessionId }
        return body
    }

    /// Field of view of the portrait upload from ARKit's landscape intrinsics (column-major: fx = [0][0], fy = [1][1]).
    static func portraitFov(intrinsics: simd_float3x3, resolution: CGSize) -> (horizontal: Double, vertical: Double)? {
        let fx = Double(intrinsics.columns.0.x), fy = Double(intrinsics.columns.1.y)
        guard fx > 1, fy > 1, resolution.width > 0, resolution.height > 0 else { return nil }
        let sensorH = 2 * atan((Double(resolution.width) / 2) / fx) * 180 / .pi
        let sensorV = 2 * atan((Double(resolution.height) / 2) / fy) * 180 / .pi
        guard sensorH > 0, sensorV > 0, sensorH < 179, sensorV < 179 else { return nil }
        return (horizontal: sensorV, vertical: sensorH)
    }

    func uploadQuery(worldId: String, body: Data) async throws -> LocalizationQueryResponse {
        var request = request("POST", "worlds/\(worldId)/localize/query", data: body)
        request.timeoutInterval = 12
        let (data, response) = try await session.data(for: request)
        try Self.check(response, data)
        return try JSONDecoder().decode(LocalizationQueryResponse.self, from: data)
    }

    /// `POST /sessions/{id}/pose` for high-rate ARKit poses between VPS fixes.
    /// The answer carries the live instruction and the exact phrase to speak.
    func pose(sessionId: String, pose: SitePose, state: BackendTrackingState, timestamp: Date) async throws -> ProgressUpdate {
        let body: [String: Any] = [
            "pose": ["position": pose.positionArray, "rotation": pose.rotationArray],
            "trackingState": state.rawValue,
            "timestamp": Self.timestamp(timestamp)
        ]
        let (data, response) = try await session.data(for: request("POST", "sessions/\(sessionId)/pose", body: body))
        try Self.check(response, data)
        return try JSONDecoder().decode(ProgressUpdate.self, from: data)
    }

    /// `PUT /sessions/{id}/destination`; the backend routes from the session's last pose.
    /// `nodeId` is a graph node id or `note:<id>` for a note pinned in the web viewer.
    func setDestination(sessionId: String, nodeId: String) async throws {
        let (data, response) = try await session.data(
            for: request("PUT", "sessions/\(sessionId)/destination", body: ["destination": nodeId]))
        try Self.check(response, data)
    }

    /// `DELETE /sessions/{id}/destination`: stop guidance, keep the session and its pose stream.
    func clearDestination(sessionId: String) async throws {
        let (data, response) = try await session.data(for: request("DELETE", "sessions/\(sessionId)/destination"))
        try Self.check(response, data)
    }

    /// `POST /sessions {worldId, deviceId}`: a session before any VPS fix, so the voice guide can
    /// answer questions while the phone is still localizing.
    func createSession(worldId: String, deviceId: String) async throws -> String {
        let (data, response) = try await session.data(
            for: request("POST", "sessions", body: ["worldId": worldId, "deviceId": deviceId]))
        try Self.check(response, data)
        struct Created: Decodable { let sessionId: String }
        return try JSONDecoder().decode(Created.self, from: data).sessionId
    }

    /// Nodes of the world's navigation graph, from `GET /worlds/{id}`.
    func graphNodes(worldId: String) async throws -> [GraphNode] {
        let (data, response) = try await session.data(for: request("GET", "worlds/\(worldId)"))
        try Self.check(response, data)
        struct Graph: Decodable { let nodes: [GraphNode] }
        struct World: Decodable { let navigationGraph: Graph? }
        return try JSONDecoder().decode(World.self, from: data).navigationGraph?.nodes ?? []
    }

    /// Externally triggered buzzes queued since `since` (`GET /haptics/pending`).
    struct PendingPulses: Decodable, Sendable {
        struct Pulse: Decodable, Sendable { let id: Int; let role: String; let ms: Int }
        let pulses: [Pulse]
        let last: Int
    }

    func pendingPulses(since: Int) async throws -> PendingPulses {
        let (data, response) = try await session.data(for: request("GET", "haptics/pending?since=\(since)"))
        try Self.check(response, data)
        return try JSONDecoder().decode(PendingPulses.self, from: data)
    }

    /// Static map layers for the phone's map obstacle sensor.
    func occupancy(worldId: String) async throws -> MapOccupancyPayload {
        let (data, response) = try await session.data(for: request("GET", "worlds/\(worldId)/occupancy"))
        try Self.check(response, data)
        return try JSONDecoder().decode(MapOccupancyPayload.self, from: data)
    }

    func hazards(worldId: String) async throws -> [MapHazard] {
        let (data, response) = try await session.data(for: request("GET", "worlds/\(worldId)/hazards"))
        try Self.check(response, data)
        return try JSONDecoder().decode(MapHazardsPayload.self, from: data).hazards
    }

    /// `GET /worlds/{id}/notes`. An empty list when the world has none; the
    /// backend answers 404 only when the world itself is missing.
    func notes(worldId: String) async throws -> [WorldNote] {
        let (data, response) = try await session.data(for: request("GET", "worlds/\(worldId)/notes"))
        try Self.check(response, data)
        struct File: Decodable { let notes: [WorldNote] }
        return try JSONDecoder().decode(File.self, from: data).notes
    }

    func worlds() async throws -> [WorldSummary] {
        let (data, response) = try await session.data(for: request("GET", "worlds"))
        try Self.check(response, data)
        if let list = try? JSONDecoder().decode([WorldSummary].self, from: data) { return list }
        struct Wrapped: Decodable { let worlds: [WorldSummary] }
        return try JSONDecoder().decode(Wrapped.self, from: data).worlds
    }

    struct HTTPError: Error, LocalizedError {
        let status: Int
        let body: String
        var errorDescription: String? { "HTTP \(status): \(body.prefix(160))" }
    }

    private static func check(_ response: URLResponse, _ data: Data) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else {
            throw HTTPError(status: status, body: String(decoding: data, as: UTF8.self))
        }
    }
}
