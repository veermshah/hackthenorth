import Foundation
import simd

/// Posts VPS fixes, in-between ARKit poses and the SDK's image queries to the
/// Wander backend, at most a few times a second, and remembers the session the
/// backend hands back.
@MainActor
final class LocalizationReporter: ObservableObject {
    @Published private(set) var sessionId: String?
    @Published private(set) var worldId: String?
    @Published private(set) var lastResponse: LocalizeResponse?
    @Published private(set) var lastError: String?
    @Published private(set) var fixesSent = 0
    @Published private(set) var posesSent = 0
    /// Destination candidates from the world's navigation graph.
    @Published private(set) var destinations: [GraphNode] = []
    @Published private(set) var destination: GraphNode?
    /// Newest `progressUpdate` from `POST /sessions/{id}/pose`.
    @Published private(set) var lastProgress: ProgressUpdate?
    /// Called on the main actor with every `speak` phrase the backend returns.
    var onSpeak: ((String) -> Void)?
    /// Image queries mirrored to `POST /worlds/{id}/localize/query`.
    @Published private(set) var queriesSent = 0
    @Published private(set) var queriesFailed = 0
    @Published private(set) var queriesSkipped = 0
    @Published private(set) var lastQueryResponse: LocalizationQueryResponse?
    /// The JPEG of the newest uploaded query, for the on-device thumbnail.
    @Published private(set) var lastQueryJPEG: Data?
    @Published private(set) var lastQueryError: String?

    private var client: WanderBackendClient?
    private var siteId = ""
    private var deviceId = ""
    private var role: DeviceRole = .front
    private var lastFixSend: TimeInterval = 0
    private var lastPoseSend: TimeInterval = 0
    private var inFlight = false
    /// The chosen destination has been accepted for the current session.
    private var destinationApplied = false
    private var destinationInFlight = false
    var minInterval: TimeInterval = 0.2

    private var uploadQueryImages = true
    private var uploadFailedQueries = true
    private var encoder = FrameEncoder(maxDimension: 640, quality: 0.6)
    private var queryInFlight = false
    private var lastQuerySend: TimeInterval = 0
    /// Newest query that arrived while an upload was running; sent next so the last one is never lost.
    private var queuedQuery: (query: VPSImageQuery, currentPose: SitePose?)?
    var minQueryInterval: TimeInterval = 0.15

    func configure(settings: CameraSettings, deviceId: String, role: DeviceRole) {
        self.deviceId = deviceId
        self.role = role
        siteId = settings.nianticSiteId
        worldId = settings.worldId.isEmpty ? nil : settings.worldId
        uploadQueryImages = settings.uploadQueryImages
        uploadFailedQueries = settings.uploadFailedQueries
        encoder = FrameEncoder(maxDimension: settings.maxImageDimension, quality: settings.jpegQuality)
        if let base = settings.backendBaseURL, !settings.backendAPIKey.isEmpty {
            client = WanderBackendClient(baseURL: base, apiKey: settings.backendAPIKey)
            Task {
                if worldId == nil { await resolveWorld() }
                await loadDestinations()
            }
        } else {
            client = nil
        }
    }

    private func loadDestinations() async {
        guard let client, let worldId else { return }
        do {
            let nodes = try await client.graphNodes(worldId: worldId)
            // Notes pinned in the web viewer are routable too (`note:<id>`, see navigation.schema.json).
            let notes = (try? await client.notes(worldId: worldId)) ?? []
            // Destinations first, then anything else that has a name, then the notes.
            destinations = nodes.filter { $0.kind == "destination" } + nodes.filter { $0.kind != "destination" && $0.name != nil }
                + notes.map { GraphNode(id: "note:\($0.id)", name: $0.title, kind: "destination") }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Choose where to go. Applied to the current session now, and to any session the
    /// backend hands back later, since `/localize` creates sessions without a destination.
    func select(destination node: GraphNode?) {
        destination = node
        lastProgress = nil
        destinationApplied = false
        applyDestination()
    }

    /// The backend already changed the destination (the voice guide's `set_destination` or
    /// `stop_navigation`): mirror it without sending it back.
    func adopt(destinationId: String?, name: String?) {
        if let destinationId {
            destination = destinations.first { $0.id == destinationId }
                ?? GraphNode(id: destinationId, name: name, kind: destinationId.hasPrefix("note:") ? "destination" : nil)
        } else {
            destination = nil
        }
        lastProgress = nil
        destinationApplied = true
    }

    /// Stop guidance on the backend and locally.
    func clearDestination() {
        destination = nil
        lastProgress = nil
        destinationApplied = true
        guard let client, let sessionId else { return }
        Task {
            do {
                try await client.clearDestination(sessionId: sessionId)
                lastError = nil
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    /// The session id, creating a session up front when no VPS fix has produced one yet. A voice
    /// call needs it before the wearer is localized; `/localize` later joins the same session.
    func ensureSession() async throws -> String {
        if let sessionId { return sessionId }
        guard let client else { throw WanderBackendClient.HTTPError(status: 0, body: "Backend is not configured") }
        if worldId == nil { await resolveWorld() }
        guard let worldId else { throw WanderBackendClient.HTTPError(status: 0, body: lastError ?? "No world configured") }
        let created = try await client.createSession(worldId: worldId, deviceId: deviceId)
        if sessionId == nil {
            sessionId = created
            destinationApplied = false
            applyDestination()
        }
        return sessionId ?? created
    }

    private func applyDestination() {
        guard let client, let sessionId, let destination, !destinationApplied, !destinationInFlight else { return }
        destinationInFlight = true
        Task {
            defer { destinationInFlight = false }
            do {
                try await client.setDestination(sessionId: sessionId, nodeId: destination.id)
                destinationApplied = self.destination == destination && self.sessionId == sessionId
                lastError = nil
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    var isConfigured: Bool { client != nil }

    /// Look the world up by Niantic site ID when none was configured.
    private func resolveWorld() async {
        guard let client else { return }
        do {
            let worlds = try await client.worlds()
            if let match = worlds.first(where: { $0.nianticSiteId == siteId && !siteId.isEmpty }) {
                worldId = match.id
            } else if worlds.count == 1 {
                worldId = worlds[0].id
            } else {
                lastError = "no world matches site \(siteId)"
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// A VPS fix from the SDK. Sent through /localize.
    func report(fix: LocalizationFix) {
        guard let client, let worldId else { return }
        let now = Date().timeIntervalSince1970
        guard now - lastFixSend >= minInterval, !inFlight else { return }
        lastFixSend = now
        inFlight = true
        let dictionary = WanderBackendClient.localizationBody(
            deviceId: deviceId, role: role, siteId: siteId, pose: fix.pose,
            confidence: fix.confidence, state: fix.state, timestamp: fix.timestamp, sessionId: sessionId)
        guard let body = try? JSONSerialization.data(withJSONObject: dictionary) else { return }
        Task {
            defer { inFlight = false }
            do {
                let response = try await client.localize(worldId: worldId, body: body)
                if sessionId != response.sessionId {
                    sessionId = response.sessionId
                    destinationApplied = false
                }
                lastResponse = response
                lastError = nil
                fixesSent += 1
                applyDestination()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    /// An ARKit pose between fixes, converted with the last known anchor transform.
    /// The backend answers with route progress and the phrase to speak, if any. Poses flow
    /// whether or not a destination is set: the voice guide may start guidance server-side at
    /// any moment and `set_destination` needs a fresh pose (under 15 s old) to route from.
    func report(cameraTransform: simd_float4x4, using fix: LocalizationFix) {
        guard let client, let sessionId, !destinationInFlight else { return }
        let now = Date().timeIntervalSince1970
        guard now - lastPoseSend >= minInterval, !inFlight else { return }
        lastPoseSend = now
        let pose = SitePose.deviceInAnchorFrame(anchor: fix.anchorTransform, device: cameraTransform)
        inFlight = true
        Task {
            defer { inFlight = false }
            do {
                let progress = try await client.pose(sessionId: sessionId, pose: pose, state: fix.state, timestamp: Date())
                posesSent += 1
                lastProgress = progress
                lastError = nil
                if let phrase = progress.speak { onSpeak?(phrase) }
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    /// Image queries the SDK finished since the last frame. Only the newest
    /// eligible one is uploaded per call; if an upload is already running it is
    /// queued and sent right after, so the dashboard always ends on the latest.
    func report(queries: [VPSImageQuery], currentPose: SitePose?) {
        guard uploadQueryImages, client != nil, worldId != nil else { return }
        let eligible = queries.filter { $0.succeeded || uploadFailedQueries }
        guard let newest = eligible.last else { return }
        queriesSkipped += max(0, eligible.count - 1)
        if queryInFlight {
            if queuedQuery != nil { queriesSkipped += 1 }
            queuedQuery = (newest, currentPose)
            return
        }
        send(query: newest, currentPose: currentPose)
    }

    private func send(query: VPSImageQuery, currentPose: SitePose?) {
        guard let client, let worldId else { return }
        guard query.pixelBuffer != nil else {
            // The frame fell out of the ring before the SDK reported the request; nothing to show.
            queriesSkipped += 1
            lastQueryError = "query frame not retained (\(query.frameMatch.rawValue))"
            return
        }
        let now = Date().timeIntervalSince1970
        let wait = max(0, minQueryInterval - (now - lastQuerySend))
        lastQuerySend = now + wait
        queryInFlight = true
        let encoder = self.encoder
        let sessionId = self.sessionId
        let deviceId = self.deviceId, role = self.role, siteId = self.siteId
        Task {
            defer {
                queryInFlight = false
                if let next = queuedQuery {
                    queuedQuery = nil
                    send(query: next.query, currentPose: next.currentPose)
                }
            }
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            // `query` is @unchecked Sendable so the pixel buffer can cross to the encoder thread.
            let encoded = await Task.detached(priority: .utility) { query.pixelBuffer.flatMap { encoder.encode($0) } }.value
            guard let encoded else {
                queriesFailed += 1
                lastQueryError = "could not encode query frame"
                return
            }
            let dictionary = WanderBackendClient.queryBody(
                deviceId: deviceId, role: role, siteId: siteId, sessionId: sessionId,
                query: query, jpeg: encoded.data, imageWidth: encoded.width, imageHeight: encoded.height,
                currentPose: currentPose)
            guard let body = try? JSONSerialization.data(withJSONObject: dictionary) else {
                queriesFailed += 1
                lastQueryError = "could not serialise query"
                return
            }
            do {
                lastQueryResponse = try await client.uploadQuery(worldId: worldId, body: body)
                lastQueryJPEG = encoded.data
                lastQueryError = nil
                queriesSent += 1
            } catch {
                queriesFailed += 1
                lastQueryError = error.localizedDescription
            }
        }
    }

    func reset() {
        sessionId = nil
        destinationApplied = false
        lastProgress = nil
        lastResponse = nil
        lastError = nil
        lastQueryResponse = nil
        lastQueryJPEG = nil
        lastQueryError = nil
        queuedQuery = nil
    }
}
