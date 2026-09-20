import SwiftUI

/// Edits the shared camera and Niantic capture settings.
struct CameraSettingsView: View {
    @EnvironmentObject private var settingsStore: CameraSettingsStore
    @EnvironmentObject private var roleStore: RoleStore
    @Environment(\.dismiss) private var dismiss
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan world QR code", systemImage: "qrcode.viewfinder")
                    }
                    .accessibilityIdentifier("settings.scanWorld")
                    if !settingsStore.settings.worldId.isEmpty {
                        LabeledContent("World", value: settingsStore.settings.worldId)
                    }
                } header: {
                    Text("Connect to a world")
                } footer: {
                    Text("The world viewer shows a QR code per world (Live tab › Connect a phone). Scanning fills in the world, Niantic Site ID and backend URL below; tokens and keys stay on this phone.")
                }

                Section("ARKit session") {
                    Picker("Frame rate", selection: $settingsStore.settings.preferredFrameRate) {
                        Text("30 fps").tag(30)
                        Text("60 fps").tag(60)
                    }
                    .accessibilityIdentifier("settings.frameRate")
                    Toggle("LiDAR scene depth", isOn: $settingsStore.settings.sceneDepthEnabled)
                        .accessibilityIdentifier("settings.sceneDepth")
                    Toggle("Smoothed depth", isOn: $settingsStore.settings.smoothedDepth)
                        .disabled(!settingsStore.settings.sceneDepthEnabled)
                }

                Section {
                    HStack {
                        Text("Detection range")
                        Slider(value: $settingsStore.settings.obstacleRangeMeters, in: 1.0...5.0, step: 0.5)
                            .accessibilityIdentifier("settings.obstacleRange")
                        Text(String(format: "%.1f m", settingsStore.settings.obstacleRangeMeters))
                            .font(.system(.body, design: .monospaced))
                    }
                    HStack {
                        Text("Side buzz range")
                        Slider(value: $settingsStore.settings.sideBuzzRangeMeters, in: 0.2...2.0, step: 0.1)
                            .accessibilityIdentifier("settings.sideBuzzRange")
                        Text(String(format: "%.1f m", settingsStore.settings.sideBuzzRangeMeters))
                            .font(.system(.body, design: .monospaced))
                    }
                        .accessibilityIdentifier("settings.sideSensing")
                } header: {
                    Text("Obstacles")
                } footer: {
                    Text("Obstacles beyond this distance are ignored. iPhone LiDAR is reliable to about 5 m. With side sensing on, the left and right phones report what they see so the front can pick the open side.")
                }

                Section {
                    Picker("Capture interval", selection: $settingsStore.settings.captureIntervalMs) {
                        ForEach([100, 200, 300, 500, 1000], id: \.self) { ms in
                            Text("\(ms) ms").tag(ms)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("settings.captureInterval")
                    Stepper(value: $settingsStore.settings.maxImageDimension, in: 160...1920, step: 160) {
                        LabeledContent("Max image side", value: "\(settingsStore.settings.maxImageDimension) px")
                    }
                    HStack {
                        Text("JPEG quality")
                        Slider(value: $settingsStore.settings.jpegQuality, in: 0.1...1.0, step: 0.1)
                        Text(String(format: "%.1f", settingsStore.settings.jpegQuality))
                            .font(.system(.body, design: .monospaced))
                    }
                } header: {
                    Text("Niantic capture")
                } footer: {
                    Text("The front phone snapshots the camera at this interval and posts each frame to Niantic Spatial.")
                }

                Section {
                    TextField("Endpoint URL", text: $settingsStore.settings.nianticEndpoint)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .accessibilityIdentifier("settings.endpoint")
                    SecureField("Developer token", text: $settingsStore.settings.nianticToken)
                        .accessibilityIdentifier("settings.token")
                    TextField("Site ID", text: $settingsStore.settings.nianticSiteId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("settings.siteId")
                } header: {
                    Text("Niantic")
                } footer: {
                    Text(settingsStore.settings.canLocalizeWithNSDK
                         ? "The Niantic SDK will localize against this Site."
                         : "Token and Site ID enable SDK localization. Without them the REST loop runs and is logged.")
                }

                Section {
                    TextField("Backend URL", text: $settingsStore.settings.backendURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .accessibilityIdentifier("settings.backendURL")
                    SecureField("API key", text: $settingsStore.settings.backendAPIKey)
                        .accessibilityIdentifier("settings.backendKey")
                    TextField("World ID (blank = match site)", text: $settingsStore.settings.worldId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("settings.worldId")
                    LabeledContent("Device ID", value: String(settingsStore.deviceId.prefix(8)))
                } header: {
                    Text("Wander backend")
                } footer: {
                    Text(settingsStore.settings.hasBackend ? "Fixes are posted to the worlds API." : "Backend URL and key are needed to report position.")
                }

                Section {
                    Toggle("Voice guide", isOn: $settingsStore.settings.voiceAgentEnabled)
                        .accessibilityIdentifier("settings.voiceAgent")
                    SecureField("Voice access token", text: $settingsStore.settings.voiceAccessToken)
                        .accessibilityIdentifier("settings.voiceToken")
                    Toggle("Start call with the camera", isOn: $settingsStore.settings.voiceAgentAutoStart)
                        .disabled(!settingsStore.settings.voiceAgentEnabled)
                        .accessibilityIdentifier("settings.voiceAutoStart")
                } header: {
                    Text("Voice guide")
                } footer: {
                    Text(settingsStore.settings.canStartVoiceCall
                         ? "Talk to the guide: ask where you are, what is nearby, or say “guide me to Bed 1”. The voice is AI generated; turn-by-turn cues are spoken by the guide during a call. Needs the backend URL and key above."
                         : "Needs the backend URL and key above plus the backend's VOICE_ACCESS_TOKEN (not the OpenAI key). The voice is AI generated.")
                }

                Section {
                    Toggle("Voice cues", isOn: $settingsStore.settings.voiceCuesEnabled)
                        .accessibilityIdentifier("settings.voiceCues")
                    Toggle("Upload query images", isOn: $settingsStore.settings.uploadQueryImages)
                        .accessibilityIdentifier("settings.uploadQueries")
                    Toggle("Include failed queries", isOn: $settingsStore.settings.uploadFailedQueries)
                        .disabled(!settingsStore.settings.uploadQueryImages)
                        .accessibilityIdentifier("settings.uploadFailedQueries")
                } header: {
                    Text("Image queries")
                } footer: {
                    Text("Every camera frame the Niantic SDK sends to VPS is mirrored to the backend with the pose it produced, so the web viewer can show the image next to where the phone was localized on the splat. Uses the max image side and JPEG quality above.")
                }

                if let error = settingsStore.settings.validationError {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(AppTheme.coral)
                            .accessibilityIdentifier("settings.validationError")
                    }
                }

                Section("Device") {
                    LabeledContent("Role", value: roleStore.role?.title ?? "Not set")
                    Button("Change role") {
                        roleStore.clear()
                        dismiss()
                    }
                    .accessibilityIdentifier("settings.changeRole")
                    Button("Reset settings", role: .destructive) {
                        settingsStore.reset()
                    }
                    .accessibilityIdentifier("settings.reset")
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.canvas)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showScanner) { ConnectWorldSheet() }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("settings.done")
                }
            }
        }
    }
}
