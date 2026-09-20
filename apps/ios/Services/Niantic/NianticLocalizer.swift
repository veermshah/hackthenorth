import Foundation
import ARKit
import Combine
import UIKit
#if canImport(NSDK)
import NSDK
#endif

/// One VPS fix: the device pose in the Site's anchor frame plus quality.
struct LocalizationFix: Equatable, Sendable {
    var pose: SitePose
    var state: BackendTrackingState
    var confidence: Float
    var timestamp: Date
    /// Anchor transform in ARKit space, kept so ARKit poses between fixes can be
    /// converted into the site frame.
    var anchorTransform: simd_float4x4
}

/// Wraps the Niantic Spatial SDK: one NSDK session fed by our ARKit session,
/// a VPS2 session tracking the Site's anchor, and the resulting device pose in
/// the site frame. The SDK submits camera frames itself at the configured rate;
/// `LocalizationQueryTracker` mirrors each of those image queries so they can be
/// shown on the dashboard next to the pose they produced.
@MainActor
final class NianticLocalizer: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle
        case unavailable(String)
        case starting
        case fetchingAnchor
        case coarse
        case tracking(BackendTrackingState)
        case failed(String)

        var label: String {
            switch self {
            case .idle: "Idle"
            case .unavailable(let why): "Unavailable: \(why)"
            case .starting: "Starting SDK"
            case .fetchingAnchor: "Fetching site anchor"
            case .coarse: "Searching for site"
            case .tracking(let s): s == .localized ? "Localized" : (s == .limited ? "Limited" : "Lost")
            case .failed(let why): "Failed: \(why)"
            }
        }
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var isAuthorized = false
    @Published private(set) var latestFix: LocalizationFix?
    @Published private(set) var anchorUpdates = 0
    @Published private(set) var framesSubmitted = 0
    @Published private(set) var siteId = ""
    /// Human-readable anchor state including the SDK's reason (e.g. "limited(noVisualLocalization)").
    @Published private(set) var anchorDetail = "–"
    /// Newest finalised VPS image query (success, failure or rejection).
    @Published private(set) var latestQuery: VPSImageQuery?
    @Published private(set) var queryStats = VPSQueryStats()
    /// Called with every finalised image query, oldest first. Set by the pipeline to upload them.
    var onQueries: (([VPSImageQuery]) -> Void)?

    private var lastCameraTransform = matrix_identity_float4x4
    private let tracker = LocalizationQueryTracker()
    private weak var arSession: ARSession?

    /// Frames per second requested from the VPS service before the first fix.
    /// 5 matches the 200 ms cadence the team asked for.
    var initialRequestsPerSecond: Float = 5
    var continuousRequestsPerSecond: Float = 1

    #if canImport(NSDK)
    private var nsdk: NSDKSession?
    private var dataSource: DefaultSessionDataSource?
    private var vps: NSDKVps2Session?
    private var cancellables = Set<AnyCancellable>()
    #endif

    static var isAvailable: Bool {
        #if canImport(NSDK)
        return true
        #else
        return false
        #endif
    }

    func start(token: String, siteId: String, anchorPayload: String?, arSession: ARSession) {
        self.siteId = siteId
        self.arSession = arSession
        #if canImport(NSDK)
        stop()
        phase = .starting
        let session = NSDKSession(accessToken: token, useLidar: true)
        nsdk = session
        let source = DefaultSessionDataSource(session: arSession, orientationReporter: self)
        dataSource = source
        session.dataSource = source
        isAuthorized = session.isAuthorized

        let vps = session.acquireVps2Session()
        self.vps = vps
        do {
            try vps.configure(with: NSDKVps2Session.Configuration(
                universalLocalizationEnabled: false,
                vpsMapLocalizationEnabled: true,
                initialVpsRequestsPerSecond: initialRequestsPerSecond,
                continuousVpsRequestsPerSecond: continuousRequestsPerSecond,
                anchorDistanceGateMeters: -1
            ))
        } catch {
            phase = .failed("configure: \(error.localizedDescription)")
            return
        }
        vps.anchorUpdated
            .sink { [weak self] _, update in self?.handle(update) }
            .store(in: &cancellables)
        // Every VPS network request the SDK issues, as a delta since the last frame.
        vps.localizationRequestRecords
            .sink { [weak self] records in self?.handle(records) }
            .store(in: &cancellables)
        vps.start()
        phase = .coarse

        Task { [weak self] in
            guard let self else { return }
            let payload: String
            if let anchorPayload, !anchorPayload.isEmpty {
                payload = anchorPayload
            } else {
                self.phase = .fetchingAnchor
                do {
                    payload = try await self.fetchAnchorPayload(session: session, siteId: siteId)
                } catch {
                    self.phase = .failed("site assets: \(error.localizedDescription)")
                    return
                }
            }
            do {
                _ = try vps.trackAnchor(payload: payload)
                self.phase = .coarse
            } catch {
                self.phase = .failed("trackAnchor: \(error.localizedDescription)")
            }
        }
        #else
        phase = .unavailable("NSDK package not linked")
        #endif
    }

    /// Call once per ARKit frame so the SDK ingests it. `snapshot` is the frame
    /// our delegate saw; the SDK's data source reads `ARSession.currentFrame`,
    /// so that is what gets remembered as the submitted query image.
    func update(frame snapshot: FrameSnapshot) {
        #if canImport(NSDK)
        guard let nsdk else { return }
        lastCameraTransform = snapshot.cameraTransform
        let fed = liveSnapshot() ?? snapshot
        nsdk.update()
        framesSubmitted += 1
        // Written as optionals so this compiles whether the SDK exposes the frame as optional or not.
        let current: NSDKFrameData? = nsdk.currentFrame
        tracker.recordFedFrame(frameId: UInt64(current?.frameId ?? 0),
                               cameraTimestampMs: UInt64(current?.cameraTimestampMs ?? 0),
                               snapshot: fed)
        tracker.expireAwaiting(fallbackAnchor: latestFix?.anchorTransform, fallbackState: latestFix?.state ?? .lost)
        publishFinishedQueries()
        if isAuthorized != nsdk.isAuthorized { isAuthorized = nsdk.isAuthorized }
        #endif
    }

    func stop() {
        #if canImport(NSDK)
        cancellables.removeAll()
        vps?.stop()
        nsdk?.destroyAll()
        vps = nil
        dataSource = nil
        nsdk = nil
        #endif
        tracker.reset()
        queryStats = VPSQueryStats()
        latestQuery = nil
        anchorDetail = "–"
        phase = .idle
        latestFix = nil
    }

    /// The frame `DefaultSessionDataSource` hands to the SDK on `update()`.
    private func liveSnapshot() -> FrameSnapshot? {
        guard let frame = arSession?.currentFrame else { return nil }
        return FrameSnapshot(
            timestamp: frame.timestamp,
            cameraTransform: frame.camera.transform,
            intrinsics: frame.camera.intrinsics,
            capturedImage: frame.capturedImage,
            depthMap: nil,
            imageResolution: frame.camera.imageResolution
        )
    }

    /// The SDK's anchor timestamp is not guaranteed to be Unix time (the backend
    /// rejected fixes as stale). Use it only when it is within a minute of now.
    static func fixDate(sdkMillis: some BinaryInteger) -> Date {
        let candidate = Date(timeIntervalSince1970: TimeInterval(sdkMillis) / 1000)
        return abs(candidate.timeIntervalSinceNow) < 60 ? candidate : Date()
    }

    private func publishFinishedQueries() {
        let done = tracker.drainFinished()
        queryStats = tracker.stats
        guard !done.isEmpty else { return }
        latestQuery = done.last
        onQueries?(done)
    }

    #if canImport(NSDK)
    private func fetchAnchorPayload(session: NSDKSession, siteId: String) async throws -> String {
        nonisolated(unsafe) let sites = session.acquireSitesSession()
        let result = try await sites.requestAssetsForSite(siteId: siteId)
        let assets: [AssetInfo] = result.assets
        guard let vpsAsset = assets.first(where: { $0.assetType == .vpsInfo && $0.deployment == .production })
                ?? assets.first(where: { $0.assetType == .vpsInfo }) else {
            throw NSError(domain: "NianticLocalizer", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Site has no production VPS asset"])
        }
        guard let payload = vpsAsset.vpsData?.anchorPayload, !payload.isEmpty else {
            throw NSError(domain: "NianticLocalizer", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "VPS asset has no anchor payload"])
        }
        return payload
    }

    private func handle(_ update: VpsAnchorUpdate) {
        anchorUpdates += 1
        let state: BackendTrackingState
        let anchorState: String
        switch update.trackingState {
        case .tracked: (state, anchorState) = (.localized, "tracked")
        case .limited: (state, anchorState) = (.limited, "limited")
        case .notTracked: (state, anchorState) = (.lost, "notTracked")
        }
        anchorDetail = String(describing: update.trackingState)
        phase = .tracking(state)
        guard let data = update.trackingData else {
            if state == .lost, var fix = latestFix {
                fix.state = .lost
                fix.timestamp = Date()
                latestFix = fix
            }
            tracker.attachAnchor(transform: nil, state: anchorState, confidence: nil, tracking: state)
            publishFinishedQueries()
            return
        }
        let pose = SitePose.deviceInAnchorFrame(anchor: data.targetAnchorTransform, device: lastCameraTransform)
        latestFix = LocalizationFix(
            pose: pose, state: state, confidence: data.confidence,
            timestamp: Self.fixDate(sdkMillis: data.timestampMs),
            anchorTransform: data.targetAnchorTransform
        )
        tracker.attachAnchor(transform: data.targetAnchorTransform, state: anchorState,
                             confidence: data.confidence, tracking: state)
        publishFinishedQueries()
    }

    private func handle(_ records: [Vps2LocalizationRequestRecord]) {
        for record in records {
            tracker.ingest(identifier: record.identifier,
                           type: Self.requestType(record.type),
                           status: Self.status(record.status),
                           error: String(describing: record.error),
                           frameId: UInt64(record.frameId),
                           startTimeMs: UInt64(record.startTimeMs),
                           endTimeMs: UInt64(record.endTimeMs))
        }
        publishFinishedQueries()
    }

    private static func requestType(_ type: Vps2LocalizationRequestType) -> VPSImageQuery.RequestType {
        switch type {
        case .vpsLocalize: .vpsLocalize
        case .universalLocalize: .universalLocalize
        case .getGraph: .getGraph
        case .getReplacedNodes: .getReplacedNodes
        case .registerNode: .registerNode
        case .unknown: .unknown
        @unknown default: .unknown
        }
    }

    private static func status(_ status: Vps2LocalizationRequestStatus) -> VPSImageQuery.Status {
        switch status {
        case .pending: .pending
        case .completed: .completed
        case .failed: .failed
        case .frameRejected: .frameRejected
        case .unknown: .unknown
        @unknown default: .unknown
        }
    }
    #endif
}

#if canImport(NSDK)
extension NianticLocalizer: UIOrientationReporter {
    nonisolated var currentOrientation: NSDKScreenOrientation { .portrait }
}
#endif
