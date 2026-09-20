import SwiftUI

@main
struct NavigationAssistantApp: App {
    @StateObject private var roleStore = RoleStore()
    @StateObject private var settingsStore = CameraSettingsStore()
    /// Set when a `wander://connect` link (the viewer's QR code) was opened from outside the app.
    @State private var openedLink: WorldConnectLink?
    @State private var openedChanges: [String] = []

    init() {
        // Line-buffer stdout so `devicectl device process launch --console` shows print() output live.
        setvbuf(stdout, nil, _IOLBF, 0)
        LaunchArguments.applyOverrides()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(roleStore)
                .environmentObject(settingsStore)
                .preferredColorScheme(.light)
                .onOpenURL { url in
                    guard let link = WorldConnectLink(url: url) else { return }
                    var settings = settingsStore.settings
                    openedChanges = link.apply(to: &settings)
                    settingsStore.settings = settings
                    openedLink = link
                }
                .alert(
                    "Connected to \(openedLink?.displayName ?? "world")",
                    isPresented: Binding(get: { openedLink != nil }, set: { if !$0 { openedLink = nil } }),
                    presenting: openedLink
                ) { _ in
                    Button("OK") {}
                } message: { link in
                    Text(openedChanges.isEmpty
                         ? "Settings already matched \(link.worldId)."
                         : "Updated " + openedChanges.joined(separator: ", ") + ". Tokens and keys are unchanged.")
                }
        }
    }
}

/// Chooses the screen for the persisted device role, or the picker when none is set.
struct RootView: View {
    @EnvironmentObject private var roleStore: RoleStore

    var body: some View {
        Group {
            switch roleStore.role {
            case .none:
                RolePickerView()
            case .some(.front):
                FrontRoleView()
            case .some(let side):
                HapticRoleView(role: side)
            }
        }
        .background(AppTheme.canvas.ignoresSafeArea())
        .animation(.easeInOut(duration: 0.2), value: roleStore.role)
    }
}

/// Process arguments used by UI tests to put the app in a known state.
enum LaunchArguments {
    static let resetState = "-resetState"

    /// `-role front|left|right|back` presets the role for demos and screenshots.
    static let role = "-role"

    static func applyOverrides() {
        let args = ProcessInfo.processInfo.arguments
        if args.contains(resetState) {
            RoleStore.clearPersisted()
            CameraSettingsStore.clearPersisted()
        }
        if let index = args.firstIndex(of: role), index + 1 < args.count,
           let preset = DeviceRole(rawValue: args[index + 1]) {
            UserDefaults.standard.set(preset.rawValue, forKey: RoleStore.key)
        }
        // `-backend <url> -backendKey <key> -world <id>` point a phone at a dev backend without typing.
        func value(after flag: String) -> String? {
            guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
            return args[index + 1]
        }
        let backend = value(after: "-backend"), key = value(after: "-backendKey"), world = value(after: "-world")
        let voiceToken = value(after: "-voiceToken")
        if backend != nil || key != nil || world != nil || voiceToken != nil {
            let defaults = UserDefaults.standard
            var settings = defaults.data(forKey: CameraSettingsStore.key)
                .flatMap { try? JSONDecoder().decode(CameraSettings.self, from: $0) } ?? .default
            if let backend { settings.backendURL = backend }
            if let key { settings.backendAPIKey = key }
            if let world { settings.worldId = world }
            if let voiceToken { settings.voiceAccessToken = voiceToken }
            if let data = try? JSONEncoder().encode(settings) { defaults.set(data, forKey: CameraSettingsStore.key) }
        }
    }
}
