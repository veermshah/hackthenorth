import SwiftUI

/// Shoulder and back phones: no camera, just a buzzer waiting for commands.
struct HapticRoleView: View {
    let role: DeviceRole
    @EnvironmentObject private var roleStore: RoleStore
    @EnvironmentObject private var settingsStore: CameraSettingsStore
    @StateObject private var pipeline: SidePipeline
    private var haptics: HapticController { pipeline.haptics }
    @State private var showSettings = false

    init(role: DeviceRole) {
        self.role = role
        _pipeline = StateObject(wrappedValue: SidePipeline(role: role))
    }
    @State private var simulatedDistance: Float = 1.6
    @State private var simulating = false

    var body: some View {
        ScrollView {
        VStack(spacing: AppTheme.s16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: AppTheme.s4) {
                    Text(role.title)
                        .font(.system(size: 40, weight: .semibold))
                        .tracking(-1)
                        .foregroundStyle(AppTheme.ink)
                        .accessibilityIdentifier("haptic.title")
                    Text(role.summary)
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
                .accessibilityIdentifier("haptic.settings")
            }
            .padding(.top, AppTheme.s16)

            VStack(alignment: .leading, spacing: AppTheme.s12) {
                HStack {
                    Image(systemName: role.symbolName)
                        .font(.system(size: 28, weight: .medium))
                    Spacer()
                    PillTag(text: haptics.isAvailable ? "Haptics ready" : "Haptics unavailable",
                            fill: haptics.isAvailable ? AppTheme.marigold : AppTheme.skyTint,
                            identifier: "haptic.availability")
                }
                StatRow(label: "Buzzes", value: "\(haptics.buzzCount)")
                StatRow(label: "Last buzz", value: haptics.lastBuzz.map { Self.time.string(from: $0) } ?? "–")
                StatRow(label: "Link", value: pipeline.link.connectedRoles.isEmpty ? "searching for front" : "front connected",
                        identifier: "haptic.link")
                StatRow(label: "Commands received", value: "\(pipeline.link.messagesReceived)")
                StatRow(label: "Last command", value: pipeline.lastCommand.shouldBuzz(role)
                        ? String(format: "buzz at %.1f m", pipeline.lastCommand.distance ?? 0) : "quiet")
            }
            .card(background: AppTheme.skyWash.opacity(0.35), bordered: false)

            if role != .front {
                VStack(alignment: .leading, spacing: AppTheme.s12) {
                    HStack {
                        Text("From the map")
                            .font(.system(size: 22, weight: .bold))
                            .tracking(-0.24)
                        Spacer()
                        PillTag(text: pipeline.link.connectedRoles.contains(.front) ? "Front linked" : "Waiting for front",
                                fill: pipeline.link.connectedRoles.contains(.front) ? AppTheme.marigold : AppTheme.skyTint,
                                identifier: "haptic.sensing")
                    }
                    Text("This phone has no camera role. It pulses when the front phone's localization puts a scanned wall or annotated hazard on this side, faster the closer it is.")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.graphite)
                    StatRow(label: "This side", value: pipeline.lastCommand.distance(for: role).map { String(format: "%.2f m", $0) } ?? "clear",
                            identifier: "haptic.nearest")
                    StatRow(label: "Commands received", value: "\(pipeline.link.messagesReceived)")
                    StatRow(label: "Pulses", value: "\(pipeline.pulsesReceived)" + (pipeline.pollingBackend ? " · backend fallback on" : ""))
                }
                .card()
            }

            VStack(alignment: .leading, spacing: AppTheme.s12) {
                HStack {
                    Text("Proximity pulse")
                        .font(.system(size: 22, weight: .bold))
                        .tracking(-0.24)
                    Spacer()
                    PillTag(text: haptics.isPulsing ? "Pulsing" : "Quiet",
                            fill: haptics.isPulsing ? AppTheme.coral : AppTheme.skyTint,
                            foreground: haptics.isPulsing ? .white : AppTheme.ink,
                            identifier: "haptic.pulseState")
                }
                Text("Drag to simulate an obstacle. Closer is faster, stronger, and sharper.")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.graphite)
                HStack {
                    Text("0.3 m").font(.system(size: 12)).foregroundStyle(AppTheme.inkTertiary)
                    Slider(value: $simulatedDistance, in: 0.3...2.0, step: 0.05)
                        .tint(AppTheme.primary)
                        .accessibilityIdentifier("haptic.distanceSlider")
                        .onChange(of: simulatedDistance) { _, new in
                            if simulating { haptics.setProximity(new) }
                        }
                    Text("2.0 m").font(.system(size: 12)).foregroundStyle(AppTheme.inkTertiary)
                }
                StatRow(label: "Distance", value: String(format: "%.2f m", simulatedDistance), identifier: "haptic.distance")
                StatRow(label: "Pulse every", value: haptics.currentPulse.map { String(format: "%.0f ms", $0.interval * 1000) } ?? "–")
                StatRow(label: "Intensity / sharpness", value: haptics.currentPulse.map { String(format: "%.2f / %.2f", $0.intensity, $0.sharpness) } ?? "–")
                Button(simulating ? "Stop simulation" : "Simulate obstacle") {
                    simulating.toggle()
                    if simulating { haptics.setProximity(simulatedDistance) } else { haptics.stopPulsing() }
                }
                .buttonStyle(GhostButtonStyle())
                .accessibilityIdentifier("haptic.simulate")
            }
            .card()

            Spacer()

            Button("Test buzz") { haptics.buzz() }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("haptic.testBuzz")
        }
        .padding(.horizontal, AppTheme.s16)
        .padding(.bottom, AppTheme.s32)
        }
        .background(AppTheme.canvas.ignoresSafeArea())
        .sheet(isPresented: $showSettings) { CameraSettingsView() }
        .onChange(of: settingsStore.settings) { _, new in pipeline.applySettings(new) }
        .onAppear { pipeline.start(settings: settingsStore.settings) }
        .onDisappear { pipeline.stop() }
    }

    private var sensingLabel: String {
        if pipeline.isSensing { return pipeline.arSession.depthAvailable ? "Sensing · LiDAR" : "Sensing · camera" }
        if !ARSessionController.isSupported { return "No ARKit" }
        if !settingsStore.settings.sidePhonesSenseObstacles { return "Off in settings" }
        switch pipeline.arSession.state {
        case .failed: return "Camera error"
        case .running: return "Waiting for frames"
        default: return "Idle"
        }
    }

    private struct SideZone: View {
        let title: String
        let distance: Float?
        var body: some View {
            VStack(spacing: 2) {
                Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(AppTheme.inkSecondary)
                Text(distance.map { String(format: "%.1f", $0) } ?? "–")
                    .font(.system(size: 16, weight: .semibold, design: .monospaced))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, AppTheme.s8)
            .background(AppTheme.canvas)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.radiusButton, style: .continuous))
        }
    }

    private static let time: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()
}
