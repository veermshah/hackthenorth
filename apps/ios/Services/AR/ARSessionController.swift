import Foundation
import ARKit
import Combine

/// A snapshot of the most recent ARKit frame that other services can read off
/// the main actor. Pixel buffers are retained by the snapshot.
struct FrameSnapshot: @unchecked Sendable {
    let timestamp: TimeInterval
    let cameraTransform: simd_float4x4
    let intrinsics: simd_float3x3
    let capturedImage: CVPixelBuffer
    let depthMap: CVPixelBuffer?
    let imageResolution: CGSize
    /// Sparse world-space feature points and vertical planes; filled only when
    /// there is no depth map, for the structure-based obstacle estimate.
    var featurePoints: [simd_float3] = []
    var featurePointIDs: [UInt64] = []
    var verticalPlanes: [VerticalPlane] = []
}

/// Owns the one ARKit session for the front phone. Every consumer, including the
/// obstacle detector and the Niantic capture loop, reads frames from here, so the
/// session is configured exactly once from `CameraSettings`.
@MainActor
final class ARSessionController: NSObject, ObservableObject {
    enum State: Equatable {
        case idle
        case unsupported
        case running
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var frameCount = 0
    @Published private(set) var lastFrameTime: TimeInterval = 0
    @Published private(set) var depthAvailable = false

    let session = ARSession()
    private(set) var latestSnapshot: FrameSnapshot?
    private var frameHandlers: [(FrameSnapshot) -> Void] = []

    /// True on LiDAR iPhones and false on the simulator and older phones.
    static var isSupported: Bool { ARWorldTrackingConfiguration.isSupported }

    override init() {
        super.init()
        session.delegate = self
    }

    func addFrameHandler(_ handler: @escaping (FrameSnapshot) -> Void) {
        frameHandlers.append(handler)
    }

    func start(settings: CameraSettings) {
        guard Self.isSupported else {
            state = .unsupported
            return
        }
        let config = settings.makeARConfiguration()
        depthAvailable = !config.frameSemantics.isDisjoint(with: [.sceneDepth, .smoothedSceneDepth])
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
        state = .running
    }

    func stop() {
        session.pause()
        if state == .running { state = .idle }
    }

    private func ingest(_ snapshot: FrameSnapshot) {
        latestSnapshot = snapshot
        frameCount += 1
        lastFrameTime = snapshot.timestamp
        for handler in frameHandlers { handler(snapshot) }
    }
}

extension ARSessionController: ARSessionDelegate {
    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let depth = frame.smoothedSceneDepth?.depthMap ?? frame.sceneDepth?.depthMap
        var snapshot = FrameSnapshot(
            timestamp: frame.timestamp,
            cameraTransform: frame.camera.transform,
            intrinsics: frame.camera.intrinsics,
            capturedImage: frame.capturedImage,
            depthMap: depth,
            imageResolution: frame.camera.imageResolution
        )
        if depth == nil {
            snapshot.featurePoints = frame.rawFeaturePoints?.points ?? []
            snapshot.featurePointIDs = frame.rawFeaturePoints?.identifiers ?? []
            snapshot.verticalPlanes = frame.anchors.compactMap { anchor -> VerticalPlane? in
                guard let plane = anchor as? ARPlaneAnchor, plane.alignment == .vertical else { return nil }
                return VerticalPlane(transform: plane.transform, center: plane.center,
                                     extent: simd_float2(plane.planeExtent.width, plane.planeExtent.height))
            }
        }
        Task { @MainActor in self.ingest(snapshot) }
    }

    nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
        let message = error.localizedDescription
        Task { @MainActor in self.state = .failed(message) }
    }
}
