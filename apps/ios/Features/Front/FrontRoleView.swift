import SwiftUI
import RealityKit
import ARKit

/// Chest phone screen: live camera, obstacle readout, and the Niantic query loop status.
struct FrontRoleView: View {
    @EnvironmentObject private var settingsStore: CameraSettingsStore
    @StateObject private var pipeline: FrontPipeline
    @State private var showSettings = false
    @State private var showScanner = false
    @State private var showNotes = false

    init() {
        // The store is read again in onAppear; this seeds the pipeline with defaults.
        _pipeline = StateObject(wrappedValue: FrontPipeline(settings: CameraSettingsStore().settings))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppTheme.s16) {
                header
                cameraCard
                voiceCard
                navigationCard
                nianticCard
                notesCard
                imageQueryCard
                localizationCard
                obstacleCard
                controls
            }
            .padding(.horizontal, AppTheme.s16)
            .padding(.bottom, AppTheme.s32)
        }
        .background(AppTheme.canvas.ignoresSafeArea())
        .sheet(isPresented: $showSettings) { CameraSettingsView() }
        .sheet(isPresented: $showScanner) { ConnectWorldSheet() }
        .sheet(isPresented: $showNotes) {
            WorldNotesView(store: pipeline.notes,
                           localized: pipeline.notesLocalized,
                           worldId: settingsStore.settings.worldId,
                           onReload: { pipeline.loadNotes() })
        }
        .onChange(of: settingsStore.settings) { _, new in pipeline.applySettings(new) }
        .onDisappear { pipeline.stop() }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: AppTheme.s4) {
                Text("Front")
                    .font(.system(size: 40, weight: .semibold))
                    .tracking(-1)
                    .foregroundStyle(AppTheme.ink)
                Text("Camera, obstacles, localization")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.inkSecondary)
            }
            Spacer()
            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(AppTheme.ink)
                    .frame(width: 44, height: 44)
                    .background(AppTheme.card)
                    .clipShape(RoundedRectangle(cornerRadius: AppTheme.radiusButton, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: AppTheme.radiusButton, style: .continuous).stroke(AppTheme.hairline))
            }
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("front.settings")
        }
        .padding(.top, AppTheme.s16)
    }

    private var cameraCard: some View {
        ZStack(alignment: .topLeading) {
            Group {
                if ARSessionController.isSupported {
                    ARPreview(session: pipeline.arSession.session)
                } else {
                    VStack(spacing: AppTheme.s8) {
                        Image(systemName: "camera.metering.unknown")
                            .font(.system(size: 28))
                        Text("ARKit is not available here. Using placeholder frames.")
                            .font(.system(size: 14))
                            .multilineTextAlignment(.center)
                    }
                    .foregroundStyle(.white.opacity(0.9))
                    .padding(AppTheme.s24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(AppTheme.midnight)
                }
            }
            .frame(height: 260)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.radiusCard, style: .continuous))
            .overlay(
                NoteOverlay(pins: pipeline.notePins, onSize: { pipeline.overlaySize = $0 })
                    .clipShape(RoundedRectangle(cornerRadius: AppTheme.radiusCard, style: .continuous))
            )

            PillTag(text: sessionLabel, fill: sessionColor, foreground: .white, identifier: "front.sessionState")
                .padding(AppTheme.s12)
        }
    }

    private var sessionLabel: String {
        switch pipeline.arSession.state {
        case .idle: "Idle"
        case .unsupported: "No ARKit"
        case .running: pipeline.arSession.depthAvailable ? "Running · LiDAR" : "Running · camera estimate"
        case .failed: "Failed"
        }
    }

    private var sessionColor: Color {
        switch pipeline.arSession.state {
        case .running: AppTheme.primary
        case .failed: AppTheme.coral
        default: AppTheme.graphite
        }
    }

    /// The live voice guide: a call button, captions and the last answer.
    private var voiceCard: some View {
        VoiceCallCard(
            voice: pipeline.voice,
            configured: settingsStore.settings.canStartVoiceCall,
            error: pipeline.voiceError,
            onStart: { pipeline.startVoice(settings: settingsStore.settings, deviceId: settingsStore.deviceId) },
            onEnd: { pipeline.endVoice() })
    }

    /// Destination choice plus the backend's live guidance, spoken as it arrives.
    private var navigationCard: some View {
        VStack(alignment: .leading, spacing: AppTheme.s12) {
            let rep = pipeline.reporter
            HStack {
                Text("Navigation")
                    .font(.system(size: 22, weight: .bold))
                    .tracking(-0.24)
                Spacer()
                PillTag(text: navigationLabel, fill: navigationColor, foreground: .white, identifier: "front.navState")
            }
            Menu {
                Button("No destination") { rep.clearDestination() }
                ForEach(rep.destinations) { node in
                    Button(node.label) { rep.select(destination: node) }
                }
            } label: {
                HStack {
                    Text(rep.destination?.label ?? (rep.destinations.isEmpty ? "No destinations loaded" : "Choose a destination"))
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(AppTheme.primary)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(AppTheme.primary)
                }
                .padding(.vertical, AppTheme.s8)
                .padding(.horizontal, AppTheme.s12)
                .background(AppTheme.skyTint)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.radiusButton, style: .continuous))
            }
            .disabled(rep.destinations.isEmpty)
            .accessibilityLabel("Destination")
            .accessibilityIdentifier("front.destination")
            // Poses now flow before a destination exists; a bare `localizing` answer is not progress.
            if let progress = rep.lastProgress, rep.destination != nil || progress.instruction != nil {
                if let instruction = progress.instruction {
                    Text(instruction.text)
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(AppTheme.ink)
                        .accessibilityIdentifier("front.instruction")
                }
                StatRow(label: "Remaining", value: String(format: "%.1f m", progress.remainingMetres))
                if let next = progress.nextNode, let ahead = progress.distanceToNextMetres {
                    StatRow(label: "Next", value: String(format: "%@ · %.1f m", next.label, ahead))
                }
                if let heading = progress.headingDeg {
                    StatRow(label: "Heading", value: String(format: "%.0f°", heading))
                }
            } else if rep.destination != nil {
                Text("Waiting for a VPS fix before routing.")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.inkSecondary)
            }
            if let spoken = pipeline.speech.lastSpoken {
                StatRow(label: "Last spoken", value: spoken)
            }
        }
        .card()
    }

    private var navigationLabel: String {
        pipeline.reporter.lastProgress?.state.replacingOccurrences(of: "-", with: " ").capitalized
            ?? (pipeline.reporter.destination == nil ? "Idle" : "Localizing")
    }

    private var navigationColor: Color {
        switch pipeline.reporter.lastProgress?.state {
        case "navigating": AppTheme.primary
        case "arrived": AppTheme.midnight
        case "off-route", "lost": AppTheme.coral
        default: AppTheme.graphite
        }
    }

    private var nianticCard: some View {
        VStack(alignment: .leading, spacing: AppTheme.s12) {
            HStack {
                Text("Localization")
                    .font(.system(size: 22, weight: .bold))
                    .tracking(-0.24)
                Spacer()
                PillTag(text: pipeline.usingNSDK ? "Niantic SDK" : "No SDK", fill: pipeline.usingNSDK ? AppTheme.marigold : AppTheme.skyTint,
                        identifier: "front.nsdkMode")
            }
            let loc = pipeline.localizer
            StatRow(label: "Site", value: settingsStore.settings.nianticSiteId.isEmpty ? "not set" : settingsStore.settings.nianticSiteId)
            StatRow(label: "State", value: loc.phase.label, identifier: "front.nsdkState")
            StatRow(label: "Authorized", value: loc.isAuthorized ? "yes" : "no")
            StatRow(label: "Frames to SDK", value: "\(loc.framesSubmitted)")
            StatRow(label: "Anchor updates", value: "\(loc.anchorUpdates)")
            StatRow(label: "Anchor", value: loc.anchorDetail)
            if let fix = loc.latestFix {
                StatRow(label: "Site position", value: String(format: "%.2f, %.2f, %.2f", fix.pose.position.x, fix.pose.position.y, fix.pose.position.z))
                StatRow(label: "Confidence", value: String(format: "%.2f", fix.confidence))
            }
            Divider()
            let rep = pipeline.reporter
            StatRow(label: "Backend", value: rep.isConfigured ? (rep.worldId ?? "resolving world") : "not configured")
            StatRow(label: "Session", value: rep.sessionId.map { String($0.prefix(8)) } ?? "–")
            StatRow(label: "Fixes / poses sent", value: "\(rep.fixesSent) / \(rep.posesSent)")
            if let node = rep.lastResponse?.nearestNode {
                StatRow(label: "Nearest node", value: String(format: "%@ · %.1f m", node.name ?? node.id, node.distanceMetres))
            }
            if let error = rep.lastError {
                StatRow(label: "Last error", value: error)
            }
        }
        .card()
    }

    /// Notes pinned to this world in the web viewer. The list always works; the
    /// labels over the camera need a precise fix, so the card says which you have.
    private var notesCard: some View {
        VStack(alignment: .leading, spacing: AppTheme.s12) {
            HStack {
                Text("Notes")
                    .font(.system(size: 22, weight: .bold))
                    .tracking(-0.24)
                Spacer()
                PillTag(text: pipeline.notesLocalized ? "On camera" : "List only",
                        fill: pipeline.notesLocalized ? AppTheme.marigold : AppTheme.skyTint,
                        identifier: "front.notesMode")
            }
            StatRow(label: "Pinned", value: "\(pipeline.notes.notes.count)", identifier: "front.notes.count")
            StatRow(label: "Source", value: pipeline.notes.state.label)
            if let nearest = pipeline.notes.bearings.first {
                StatRow(label: "Nearest", value: String(format: "%@ · %.1f m %@", nearest.note.title,
                                                        nearest.distance, nearest.side.rawValue))
            } else if !pipeline.notes.isEmpty {
                StatRow(label: "Nearest", value: "needs a precise fix")
            }
            Button {
                showNotes = true
            } label: {
                Label(pipeline.notes.isEmpty ? "Open notes" : "Open \(pipeline.notes.notes.count) notes",
                      systemImage: "note.text")
            }
            .buttonStyle(GhostButtonStyle())
            .accessibilityIdentifier("front.openNotes")
        }
        .card()
    }

    /// The camera frames the SDK actually sent to VPS, and how each one did.
    private var imageQueryCard: some View {
        VStack(alignment: .leading, spacing: AppTheme.s12) {
            HStack {
                Text("Image queries")
                    .font(.system(size: 22, weight: .bold))
                    .tracking(-0.24)
                Spacer()
                PillTag(text: settingsStore.settings.uploadQueryImages ? "Mirrored" : "Local only",
                        fill: settingsStore.settings.uploadQueryImages ? AppTheme.marigold : AppTheme.skyTint,
                        identifier: "front.queryMirror")
            }
            let q = pipeline.localizer.queryStats
            let rep = pipeline.reporter
            HStack(alignment: .top, spacing: AppTheme.s12) {
                QueryThumbnail(jpeg: rep.lastQueryJPEG, query: pipeline.localizer.latestQuery)
                VStack(alignment: .leading, spacing: AppTheme.s8) {
                    StatRow(label: "Issued", value: "\(q.issued)", identifier: "front.query.issued")
                    StatRow(label: "Localized", value: "\(q.succeeded)")
                    StatRow(label: "Failed / rejected", value: "\(q.failed) / \(q.rejected)")
                    StatRow(label: "Round trip", value: q.lastLatencyMs.map { "\($0) ms" } ?? "–")
                    StatRow(label: "Frame match", value: q.lastFrameMatch?.rawValue ?? "–")
                    if let error = q.lastError, error != "none" {
                        StatRow(label: "SDK error", value: error)
                    }
                }
            }
            Divider()
            StatRow(label: "Uploaded", value: "\(rep.queriesSent) · \(rep.queriesFailed) failed · \(rep.queriesSkipped) skipped")
            if let response = rep.lastQueryResponse {
                StatRow(label: "Stored as", value: String(response.id.prefix(12)))
                if let node = response.nearestNode {
                    StatRow(label: "Nearest node", value: String(format: "%@ · %.1f m", node.name ?? node.id, node.distanceMetres))
                }
            }
            if let error = rep.lastQueryError {
                StatRow(label: "Upload error", value: error)
            }
        }
        .card()
    }

    private var localizationCard: some View {
        VStack(alignment: .leading, spacing: AppTheme.s12) {
            HStack {
                Text(pipeline.usingNSDK ? "REST fallback (off)" : "Niantic queries")
                    .font(.system(size: 22, weight: .bold))
                    .tracking(-0.24)
                Spacer()
                PillTag(text: pipeline.queryLoop.isRunning ? "Every \(settingsStore.settings.captureIntervalMs) ms" : "Stopped",
                        fill: pipeline.queryLoop.isRunning ? AppTheme.marigold : AppTheme.skyTint,
                        identifier: "front.queryInterval")
            }
            let s = pipeline.queryLoop.stats
            StatRow(label: "Ticks", value: "\(s.ticks)", identifier: "front.stat.ticks")
            StatRow(label: "Sent", value: "\(s.sent)", identifier: "front.stat.sent")
            StatRow(label: "Skipped (no token)", value: "\(s.skipped)", identifier: "front.stat.skipped")
            StatRow(label: "Failed", value: "\(s.failed)", identifier: "front.stat.failed")
            StatRow(label: "Dropped", value: "\(s.droppedNoFrame + s.droppedBusy)")
            StatRow(label: "Last payload", value: s.lastPayloadBytes > 0 ? "\(s.lastPayloadBytes / 1024) KB" : "–")
            StatRow(label: "Last result", value: s.lastOutcome?.label ?? "–")
        }
        .card()
    }

    private var obstacleCard: some View {
        VStack(alignment: .leading, spacing: AppTheme.s12) {
            HStack {
                Text("Obstacles")
                    .font(.system(size: 22, weight: .bold))
                    .tracking(-0.24)
                Spacer()
                PillTag(text: String(format: "Range %.1f m", settingsStore.settings.obstacleRangeMeters))
            }
            HStack(spacing: AppTheme.s8) {
                ZoneTile(title: "Left", distance: pipeline.zones.left, active: pipeline.lastDecision.haptics.left)
                ZoneTile(title: "Center", distance: pipeline.zones.center, active: pipeline.lastDecision.haptics.front)
                ZoneTile(title: "Right", distance: pipeline.zones.right, active: pipeline.lastDecision.haptics.right)
            }
            StatRow(label: "Clear path", value: String(format: "%+.2f", pipeline.zones.gapDirection))
            StatRow(label: "Open side", value: pipeline.lastDecision.openSide?.rawValue ?? "–")
            Divider()
            StatRow(label: "Map", value: pipeline.mapStatus)
            if let m = pipeline.mapReading {
                let fmt: (Float?) -> String = { $0.map { String(format: "%.1f", $0) } ?? "–" }
                StatRow(label: "Map around", value: "L \(fmt(m.left)) · ahead \(fmt(m.zones.center)) · R \(fmt(m.right)) · back \(fmt(m.back))")
                if let hazard = m.nearestHazard, let d = m.nearestHazardDistance {
                    StatRow(label: "Hazard", value: String(format: "%@ · %.1f m", hazard.name, d))
                }
            }
            StatRow(label: "Linked phones", value: pipeline.link.connectedRoles.isEmpty ? "none" : pipeline.link.connectedRoles.map(\.rawValue).joined(separator: ", "),
                    identifier: "front.link")
            StatRow(label: "Left phone sees", value: sideReading(.left))
            StatRow(label: "Right phone sees", value: sideReading(.right))
        }
        .card()
    }

    private var controls: some View {
        VStack(spacing: AppTheme.s8) {
            if pipeline.isActive {
                Button("Stop") { pipeline.stop() }
                    .buttonStyle(GhostButtonStyle())
                    .accessibilityIdentifier("front.stop")
            } else {
                Button("Start") { pipeline.start(settings: settingsStore.settings, deviceId: settingsStore.deviceId) }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("front.start")
            }
            // The scanner needs the camera, so it is only offered while the AR session is stopped.
            Button {
                showScanner = true
            } label: {
                Label(settingsStore.settings.worldId.isEmpty ? "Scan world QR" : "Scan a different world", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(GhostButtonStyle())
            .disabled(pipeline.isActive)
            .opacity(pipeline.isActive ? 0.5 : 1)
            .accessibilityHint(pipeline.isActive ? "Stop the camera first" : "")
            .accessibilityIdentifier("front.scanWorld")
            Button("Test speech") {
                pipeline.speech.speak(SpokenCue(text: "Navigation assistant ready.", priority: .route))
            }
            .buttonStyle(GhostButtonStyle())
            .accessibilityIdentifier("front.testSpeech")
        }
    }
}

extension FrontRoleView {
    fileprivate func sideReading(_ side: DeviceRole) -> String {
        guard let reading = pipeline.sideClearances[side] else { return "no reports" }
        let age = Date().timeIntervalSince1970 - reading.timestamp
        if age > 1 { return String(format: "stale %.0fs", age) }
        return reading.nearest.map { String(format: "%.2f m", $0) } ?? "clear"
    }
}

private struct ZoneTile: View {
    let title: String
    let distance: Float?
    let active: Bool

    var body: some View {
        VStack(spacing: AppTheme.s4) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(active ? .white : AppTheme.inkSecondary)
            Text(distance.map { String(format: "%.1f m", $0) } ?? "clear")
                .font(.system(size: 20, weight: .semibold, design: .monospaced))
                .foregroundStyle(active ? .white : AppTheme.ink)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, AppTheme.s12)
        .background(active ? AppTheme.coral : AppTheme.canvas)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.radiusButton, style: .continuous))
        .animation(.easeInOut(duration: 0.2), value: active)
    }
}

/// The last frame the SDK sent to VPS, with a status ribbon for how the query did.
private struct QueryThumbnail: View {
    let jpeg: Data?
    let query: VPSImageQuery?

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Group {
                if let jpeg, let image = UIImage(data: jpeg) {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    VStack(spacing: AppTheme.s4) {
                        Image(systemName: "photo")
                            .font(.system(size: 22))
                        Text("No query yet")
                            .font(.system(size: 12))
                    }
                    .foregroundStyle(.white.opacity(0.85))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(AppTheme.midnight)
                }
            }
            .frame(width: 96, height: 128)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.radiusButton, style: .continuous))

            if let query {
                Text(label(for: query))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, AppTheme.s8)
                    .padding(.vertical, 3)
                    .background(color(for: query))
                    .clipShape(Capsule())
                    .padding(AppTheme.s4)
            }
        }
        .accessibilityLabel(query.map { "Last image query: \(label(for: $0))" } ?? "No image query yet")
    }

    private func label(for query: VPSImageQuery) -> String {
        if query.succeeded { return query.trackingState == .localized ? "Localized" : query.trackingState.rawValue.capitalized }
        if query.status == .frameRejected { return "Rejected" }
        return "Failed"
    }

    private func color(for query: VPSImageQuery) -> Color {
        if query.succeeded { return query.trackingState == .localized ? AppTheme.primary : AppTheme.marigold }
        return AppTheme.coral
    }
}

/// RealityKit view bound to the shared session; it never configures the session itself.
private struct ARPreview: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        view.session = session
        view.renderOptions = [.disableMotionBlur, .disableDepthOfField, .disablePersonOcclusion]
        return view
    }

    func updateUIView(_ uiView: ARView, context: Context) {}
}
