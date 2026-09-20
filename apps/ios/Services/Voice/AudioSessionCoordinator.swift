import AVFoundation

/// The one owner of `AVAudioSession`. Spoken cues want plain playback; a voice call needs
/// play-and-record with Apple's voice processing (echo cancellation and gain control), so the
/// chest-mounted speaker does not feed the microphone. Switching lives here so
/// `SpeechCoordinator` and `VoiceAudioIO` never fight over the category.
@MainActor
final class AudioSessionCoordinator {
    enum Mode: Equatable, Sendable {
        case idle
        case speech
        case call
    }

    static let shared = AudioSessionCoordinator()

    private(set) var mode: Mode = .idle

    /// Configure and activate the session for `mode`; a no-op when already there unless `force`
    /// (after an interruption the system may have deactivated the session behind our back).
    func activate(_ mode: Mode, force: Bool = false) throws {
        guard force || mode != self.mode else { return }
        let session = AVAudioSession.sharedInstance()
        switch mode {
        case .idle:
            try session.setActive(false, options: .notifyOthersOnDeactivation)
        case .speech:
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        case .call:
            // Bluetooth HFP lets a headset carry both directions; the built-in mic/speaker are the fallback.
            try session.setCategory(.playAndRecord, mode: .voiceChat,
                                    options: [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers])
            try session.setPreferredSampleRate(PCM.sampleRate)
            try session.setPreferredIOBufferDuration(0.02)
            try session.setActive(true)
        }
        self.mode = mode
    }

    /// Ask for microphone permission; returns whether recording is allowed.
    static func requestRecordPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }
}
