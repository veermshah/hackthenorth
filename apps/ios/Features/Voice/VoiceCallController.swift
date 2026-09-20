import Foundation
import Combine

/// One voice call with the Wander backend's GPT-Live bridge: owns the socket, the microphone
/// stream and playback, keeps captions, and hands navigation side effects to the pipeline.
///
/// The backend speaks every navigation cue while a call is active, so the pipeline turns its
/// own spoken cues off for the duration (see `FrontPipeline`). Obstacle haptics are unaffected.
@MainActor
final class VoiceCallController: ObservableObject {
    enum State: Equatable, Sendable {
        case idle
        case connecting
        case listening
        case speaking
        case reconnecting
        case ending

        var label: String {
            switch self {
            case .idle: "Off"
            case .connecting: "Connecting"
            case .listening: "Listening"
            case .speaking: "Speaking"
            case .reconnecting: "Reconnecting"
            case .ending: "Ending"
            }
        }
    }

    struct Caption: Identifiable, Equatable, Sendable {
        let id: Int
        let speaker: String
        var text: String
    }

    /// Where to connect and how to authenticate; built from `CameraSettings`.
    struct Config: Equatable, Sendable {
        let backendURL: URL
        let apiKey: String
        let token: String

        init?(settings: CameraSettings) {
            guard let url = settings.backendBaseURL, !settings.backendAPIKey.isEmpty, !settings.voiceAccessToken.isEmpty else { return nil }
            backendURL = url
            apiKey = settings.backendAPIKey
            token = settings.voiceAccessToken
        }

        init(backendURL: URL, apiKey: String, token: String) {
            self.backendURL = backendURL
            self.apiKey = apiKey
            self.token = token
        }
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var captions: [Caption] = []
    @Published private(set) var lastAssistantText: String?
    @Published private(set) var usageSeconds: Double = 0
    @Published private(set) var lastError: String?
    @Published private(set) var isMuted = false
    @Published private(set) var liveSessionId: String?
    @Published private(set) var sessionId: String?

    /// Navigation side effects reported by the backend agent (`set_destination`, `stop_navigation`).
    var onAction: ((AssistantAction) -> Void)?
    /// Mirrored session events (`progress`, `rerouted`, `arrived`, …).
    var onNavigation: ((NavigationEvent) -> Void)?

    var isActive: Bool { state != .idle }
    var maxReconnects = 3
    var reconnectDelays: [Duration] = [.seconds(1), .seconds(2), .seconds(4)]
    /// How long after the last audio chunk the state falls back from speaking to listening.
    var speakingHold: Duration = .milliseconds(500)
    /// Injected so tests do not hit the microphone permission prompt.
    var requestPermission: @Sendable () async -> Bool = { await AudioSessionCoordinator.requestRecordPermission() }

    private let audio: any VoiceAudio
    private let makeTransport: @Sendable () -> any VoiceTransport
    private var transport: (any VoiceTransport)?
    private var config: Config?
    private var wantsCall = false
    private var generation = 0
    private var reconnects = 0
    private var receiveTask: Task<Void, Never>?
    private var senderTask: Task<Void, Never>?
    private var frames: AsyncStream<Data>.Continuation?
    private var speakingTimer: Task<Void, Never>?
    /// When the guide is considered to have stopped speaking; extended by each audio chunk.
    private var speakingUntil: ContinuousClock.Instant?
    private var audioStarted = false
    private var captionCounter = 0
    private let captionLimit = 12

    init(audio: (any VoiceAudio)? = nil, transport: @escaping @Sendable () -> any VoiceTransport = { VoiceWebSocket() }) {
        self.audio = audio ?? VoiceAudioIO()
        self.makeTransport = transport
    }

    // MARK: - Public

    /// Begin a call on an existing navigation session. Safe to call while one is active (no-op).
    func start(config: Config, sessionId: String) {
        guard !isActive else { return }
        self.config = config
        self.sessionId = sessionId
        wantsCall = true
        reconnects = 0
        lastError = nil
        captions = []
        lastAssistantText = nil
        usageSeconds = 0
        generation += 1
        state = .connecting
        let current = generation
        Task { [weak self] in
            guard let self, await self.requestPermission() else {
                self?.failed("Microphone access is needed for the voice guide.")
                return
            }
            guard self.generation == current, self.wantsCall else { return }
            self.connect()
        }
    }

    /// Ask the backend to end the call; the state returns to idle once it confirms (or after a timeout).
    func end() {
        guard isActive, state != .ending else { return }
        wantsCall = false
        guard let transport else {
            // Nothing to hang up yet (still asking permission or connecting).
            finish()
            return
        }
        state = .ending
        frames?.finish()
        let current = generation
        Task { [weak self] in
            try? await transport.send(.close)
            // `closed` normally arrives first and finishes the call with its usage; this is the fallback.
            try? await Task.sleep(for: .seconds(3))
            guard let self, self.generation == current else { return }
            self.finish()
        }
    }

    func toggleMute() {
        guard isActive else { return }
        isMuted.toggle()
        audio.setMuted(isMuted)
        let transport = self.transport, muted = isMuted
        Task { try? await transport?.send(muted ? .mute : .unmute) }
    }

    /// Typed request through the same path as speech (simulator, tests, noisy rooms).
    func send(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isActive, !trimmed.isEmpty, let transport else { return }
        appendCaption(speaker: "user", text: trimmed, merge: false)
        Task { try? await transport.send(.text(trimmed)) }
    }

    // MARK: - Connection

    private func connect() {
        guard let config, let sessionId, let url = config.backendURL.voiceSocketURL(sessionId: sessionId) else {
            failed("Backend URL is not valid for a voice call.")
            return
        }
        let transport = makeTransport()
        self.transport = transport
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            do {
                let events = try await transport.connect(url: url, apiKey: config.apiKey)
                try await transport.send(.auth(token: config.token))
                for await event in events {
                    guard let self, !Task.isCancelled else { return }
                    self.handle(event)
                }
                guard let self, !Task.isCancelled else { return }
                self.dropped(transport)
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.dropped(transport, error: error.localizedDescription)
            }
        }
    }

    private func handle(_ event: VoiceServerMessage) {
        switch event {
        case .ready(let ready):
            liveSessionId = ready.liveSessionId
            reconnects = 0
            startAudioIfNeeded()
            if state != .idle { state = .listening }
        case .audio(let pcm):
            audio.enqueue(pcm)
            markSpeaking()
        case .transcript(let fragment):
            appendCaption(speaker: fragment.speaker, text: fragment.delta, merge: true)
        case .assistantResponse(let response):
            if !response.text.isEmpty { lastAssistantText = response.text }
            for action in response.actions {
                onAction?(action)
            }
        case .navigation(let navigation):
            onNavigation?(navigation)
        case .usage(let seconds):
            usageSeconds = seconds
        case .warning(let code):
            print("[voice] warning from backend: \(code)")
        case .renewed(let identifier):
            liveSessionId = identifier
            audio.flush()
        case .closed(let reason, let seconds, let renewing):
            usageSeconds = seconds
            if renewing { return }
            if !wantsCall || reason == "close_requested" || reason == "max_duration" {
                finish()
            } else {
                // The socket closes next; `dropped` decides whether to reconnect.
                lastError = "Voice ended: \(reason.replacingOccurrences(of: "_", with: " "))"
            }
        case .error(let message):
            lastError = message
        case .unknown:
            break
        }
    }

    /// The socket finished. Reconnect with backoff while the wearer still wants the call.
    private func dropped(_ transport: any VoiceTransport, error: String? = nil) {
        guard self.transport === transport else { return }
        self.transport = nil
        if let error { lastError = error }
        guard wantsCall else {
            finish()
            return
        }
        guard reconnects < maxReconnects else {
            failed(lastError ?? "Voice connection lost.")
            return
        }
        let delay = reconnectDelays[min(reconnects, reconnectDelays.count - 1)]
        reconnects += 1
        state = .reconnecting
        let current = generation
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, self.generation == current, self.wantsCall else { return }
            self.connect()
        }
    }

    private func failed(_ message: String) {
        lastError = message
        finish()
    }

    private func finish() {
        speakingTimer?.cancel()
        speakingTimer = nil
        speakingUntil = nil
        receiveTask?.cancel()
        receiveTask = nil
        senderTask?.cancel()
        senderTask = nil
        frames?.finish()
        frames = nil
        transport?.close()
        transport = nil
        if audioStarted {
            audio.stop()
            audioStarted = false
        }
        isMuted = false
        wantsCall = false
        state = .idle
    }

    // MARK: - Audio

    private func startAudioIfNeeded() {
        guard !audioStarted else { return }
        // One ordered stream from the audio thread to one sender keeps frames in sequence;
        // independent Tasks per frame could reorder them.
        let (stream, continuation) = AsyncStream.makeStream(of: Data.self, bufferingPolicy: .bufferingNewest(50))
        frames = continuation
        do {
            try audio.start { frame in continuation.yield(frame) }
        } catch {
            failed(error.localizedDescription)
            return
        }
        audioStarted = true
        senderTask = Task { [weak self] in
            for await frame in stream {
                guard let self, let transport = self.transport else { continue }
                try? await transport.send(.audio(pcm: frame))
            }
        }
    }

    private func markSpeaking() {
        guard state == .listening || state == .speaking else { return }
        // Audio arrives in small chunks. Re-publishing `state` and rebuilding the hold timer on each
        // one rebuilds the whole front screen dozens of times a second, on top of ARKit at 60 Hz.
        // Extend a deadline that one running timer reads instead, and publish only real changes.
        speakingUntil = ContinuousClock.now.advanced(by: speakingHold)
        if state != .speaking { state = .speaking }
        guard speakingTimer == nil else { return }
        speakingTimer = Task { [weak self] in
            while true {
                guard let self, let until = self.speakingUntil else { return }
                if ContinuousClock.now >= until { break }
                try? await Task.sleep(until: until, clock: .continuous)
                if Task.isCancelled { return }
            }
            guard let self, !Task.isCancelled else { return }
            self.speakingTimer = nil
            self.speakingUntil = nil
            if self.state == .speaking { self.state = .listening }
        }
    }

    private func appendCaption(speaker: String, text: String, merge: Bool) {
        if merge, let last = captions.last, last.speaker == speaker {
            captions[captions.count - 1].text += text
        } else {
            captionCounter += 1
            captions.append(Caption(id: captionCounter, speaker: speaker, text: text))
        }
        if captions.count > captionLimit {
            captions.removeFirst(captions.count - captionLimit)
        }
    }
}
