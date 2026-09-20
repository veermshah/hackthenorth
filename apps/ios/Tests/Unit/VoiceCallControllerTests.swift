import XCTest
@testable import NavigationAssistant

/// A scripted backend voice socket.
final class FakeVoiceTransport: VoiceTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var messages: [VoiceClientMessage] = []
    private var continuation: AsyncStream<VoiceServerMessage>.Continuation?
    private(set) var url: URL?
    private(set) var apiKey: String?
    private(set) var closed = false
    var connectError: Error?

    var sent: [VoiceClientMessage] { lock.withLock { messages } }

    func connect(url: URL, apiKey: String) async throws -> AsyncStream<VoiceServerMessage> {
        if let connectError { throw connectError }
        lock.withLock {
            self.url = url
            self.apiKey = apiKey
        }
        let (stream, continuation) = AsyncStream.makeStream(of: VoiceServerMessage.self)
        lock.withLock { self.continuation = continuation }
        return stream
    }

    func send(_ message: VoiceClientMessage) async throws {
        lock.withLock { messages.append(message) }
    }

    func close() {
        lock.withLock {
            closed = true
            continuation?.finish()
        }
    }

    func emit(_ message: VoiceServerMessage) {
        lock.withLock { continuation?.yield(message) }
    }

    /// The server closed the socket.
    func finish() {
        lock.withLock { continuation?.finish() }
    }
}

@MainActor
final class FakeVoiceAudio: VoiceAudio {
    var inputLevel: Float = 0
    var started = 0
    var stopped = 0
    var flushed = 0
    var muted = false
    var enqueued: [Data] = []
    var onFrame: (@Sendable (Data) -> Void)?

    func start(onFrame: @escaping @Sendable (Data) -> Void) throws {
        started += 1
        self.onFrame = onFrame
    }

    func stop() { stopped += 1 }
    func enqueue(_ pcm: Data) { enqueued.append(pcm) }
    func flush() { flushed += 1 }
    func setMuted(_ muted: Bool) { self.muted = muted }
}

@MainActor
final class VoiceCallControllerTests: XCTestCase {
    private let config = VoiceCallController.Config(backendURL: URL(string: "https://x.modal.run")!, apiKey: "k", token: "demo")
    private var transports: [FakeVoiceTransport] = []
    private var audio: FakeVoiceAudio!
    private var controller: VoiceCallController!

    override func setUp() {
        super.setUp()
        audio = FakeVoiceAudio()
        let box = TransportBox()
        controller = VoiceCallController(audio: audio, transport: { box.make() })
        controller.requestPermission = { true }
        controller.reconnectDelays = [.milliseconds(20)]
        controller.speakingHold = .milliseconds(60)
        transportsBox = box
    }

    private var transportsBox: TransportBox!

    /// Hands out transports and remembers them; `@unchecked Sendable` because tests read it on the main actor only.
    final class TransportBox: @unchecked Sendable {
        private let lock = NSLock()
        private(set) var made: [FakeVoiceTransport] = []
        func make() -> FakeVoiceTransport {
            let transport = FakeVoiceTransport()
            lock.withLock { made.append(transport) }
            return transport
        }
    }

    private func eventually(_ condition: @escaping @MainActor () -> Bool, timeout: Duration = .seconds(2)) async {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while !condition() {
            if clock.now > deadline { return XCTFail("Condition not met in time") }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    private func startCall() async -> FakeVoiceTransport {
        controller.start(config: config, sessionId: "s1")
        XCTAssertEqual(controller.state, .connecting)
        await eventually { self.transportsBox.made.first?.sent.isEmpty == false }
        let transport = transportsBox.made[0]
        XCTAssertEqual(transport.url?.absoluteString, "wss://x.modal.run/ws/sessions/s1/voice")
        XCTAssertEqual(transport.apiKey, "k")
        XCTAssertEqual(transport.sent.first, .auth(token: "demo"))
        return transport
    }

    func testCallLifecycleRelaysAudioCaptionsAndActions() async throws {
        let transport = await startCall()
        transport.emit(.ready(VoiceReady(format: "pcm16le", rate: 24000, channels: 1, aiGeneratedVoice: true, voice: "marin", liveSessionId: "live_1")))
        await eventually { self.controller.state == .listening }
        XCTAssertEqual(audio.started, 1)
        XCTAssertEqual(controller.liveSessionId, "live_1")

        // Microphone frames go up in order through one sender.
        let frames = [Data([1, 0]), Data([2, 0]), Data([3, 0])]
        for frame in frames { audio.onFrame?(frame) }
        await eventually { transport.sent.count >= 4 }
        XCTAssertEqual(Array(transport.sent.dropFirst()), frames.map { VoiceClientMessage.audio(pcm: $0) })

        // Server audio is played and flips the state to speaking, then back to listening.
        transport.emit(.audio(Data([0, 0, 0, 0])))
        await eventually { self.controller.state == .speaking }
        XCTAssertEqual(audio.enqueued, [Data([0, 0, 0, 0])])
        await eventually { self.controller.state == .listening }

        // Fragments of one speaker merge into a caption; a new speaker starts a new bubble.
        transport.emit(.transcript(VoiceTranscript(speaker: "user", delta: "Guide me", startMs: 0, endMs: 500)))
        transport.emit(.transcript(VoiceTranscript(speaker: "user", delta: " to bed one.", startMs: 500, endMs: 900)))
        transport.emit(.transcript(VoiceTranscript(speaker: "assistant", delta: "Starting guidance to Bed 1.", startMs: 2000, endMs: 3000)))
        await eventually { self.controller.captions.count == 2 }
        XCTAssertEqual(controller.captions.map(\.text), ["Guide me to bed one.", "Starting guidance to Bed 1."])

        var actions: [AssistantAction] = []
        controller.onAction = { actions.append($0) }
        var events: [NavigationEvent] = []
        controller.onNavigation = { events.append($0) }
        let action = AssistantAction(type: "set_destination", destinationId: "note:n1", destinationName: "Bed 1", accessibleOnly: false)
        transport.emit(.assistantResponse(try JSONDecoder().decode(AssistantResponse.self, from: Data("""
        {"text":"Starting guidance to Bed 1, about 5 metres.","actions":[{"type":"set_destination","destination_id":"note:n1","destination_name":"Bed 1","accessible_only":false}]}
        """.utf8))))
        transport.emit(.navigation(try JSONDecoder().decode(NavigationEvent.self, from: Data("{\"type\":\"progress\",\"progress\":{\"state\":\"navigating\",\"remainingMetres\":5}}".utf8))))
        transport.emit(.usage(seconds: 42))
        await eventually { self.controller.usageSeconds == 42 }
        XCTAssertEqual(actions, [action])
        XCTAssertEqual(events.map(\.type), ["progress"])
        XCTAssertEqual(controller.lastAssistantText, "Starting guidance to Bed 1, about 5 metres.")

        controller.toggleMute()
        XCTAssertTrue(audio.muted)
        await eventually { transport.sent.contains(.mute) }
        controller.send(text: "  how far is it? ")
        await eventually { transport.sent.contains(.text("how far is it?")) }
        XCTAssertEqual(controller.captions.last?.text, "how far is it?")

        controller.end()
        XCTAssertEqual(controller.state, .ending)
        await eventually { transport.sent.contains(.close) }
        transport.emit(.closed(reason: "close_requested", seconds: 60, renewing: false))
        await eventually { self.controller.state == .idle }
        XCTAssertEqual(audio.stopped, 1)
        XCTAssertTrue(transport.closed)
        XCTAssertEqual(controller.usageSeconds, 60)
        XCTAssertFalse(controller.isMuted)
    }

    func testDroppedSocketReconnectsWithoutRestartingAudio() async {
        let first = await startCall()
        first.emit(.ready(VoiceReady(format: "pcm16le", rate: 24000, channels: 1, aiGeneratedVoice: true, voice: nil, liveSessionId: "live_1")))
        await eventually { self.controller.state == .listening }
        first.emit(.closed(reason: "connection_lost", seconds: 10, renewing: false))
        first.finish()
        await eventually { self.transportsBox.made.count == 2 }
        XCTAssertEqual(controller.state, .reconnecting)
        let second = transportsBox.made[1]
        await eventually { second.sent.first == .auth(token: "demo") }
        second.emit(.ready(VoiceReady(format: "pcm16le", rate: 24000, channels: 1, aiGeneratedVoice: true, voice: nil, liveSessionId: "live_2")))
        await eventually { self.controller.state == .listening }
        XCTAssertEqual(audio.started, 1, "the microphone keeps running across a reconnect")
        XCTAssertEqual(controller.liveSessionId, "live_2")
        // Frames captured now go to the new socket.
        audio.onFrame?(Data([7, 0]))
        await eventually { second.sent.contains(.audio(pcm: Data([7, 0]))) }
        controller.end()
        second.emit(.closed(reason: "close_requested", seconds: 12, renewing: false))
        await eventually { self.controller.state == .idle }
    }

    func testGivesUpAfterRepeatedDropsAndReportsTheError() async {
        controller.maxReconnects = 1
        let first = await startCall()
        first.finish()
        // The second transport only has a stream to finish once the controller connected through it.
        await eventually { self.transportsBox.made.count == 2 && !self.transportsBox.made[1].sent.isEmpty }
        transportsBox.made[1].finish()
        await eventually { self.controller.state == .idle }
        XCTAssertEqual(controller.lastError, "Voice connection lost.")
        XCTAssertEqual(audio.started, 0, "audio never started because voice_ready never arrived")
    }

    func testServerEndingTheCallReturnsToIdle() async {
        let transport = await startCall()
        transport.emit(.ready(VoiceReady(format: "pcm16le", rate: 24000, channels: 1, aiGeneratedVoice: true, voice: nil, liveSessionId: nil)))
        await eventually { self.controller.state == .listening }
        transport.emit(.closed(reason: "max_duration", seconds: 3600, renewing: false))
        await eventually { self.controller.state == .idle }
        XCTAssertEqual(audio.stopped, 1)
        XCTAssertEqual(controller.usageSeconds, 3600)
    }

    func testRenewalKeepsTheCallAndFlushesStaleAudio() async {
        let transport = await startCall()
        transport.emit(.ready(VoiceReady(format: "pcm16le", rate: 24000, channels: 1, aiGeneratedVoice: true, voice: nil, liveSessionId: "live_1")))
        await eventually { self.controller.state == .listening }
        transport.emit(.closed(reason: "expired", seconds: 100, renewing: true))
        transport.emit(.renewed(liveSessionId: "live_2"))
        await eventually { self.controller.liveSessionId == "live_2" }
        XCTAssertEqual(controller.state, .listening)
        XCTAssertEqual(audio.flushed, 1)
        XCTAssertEqual(transportsBox.made.count, 1)
    }

    func testPermissionDeniedEndsBeforeConnecting() async {
        controller.requestPermission = { false }
        controller.start(config: config, sessionId: "s1")
        await eventually { self.controller.state == .idle && self.controller.lastError != nil }
        XCTAssertTrue(transportsBox.made.isEmpty)
    }

    func testEndTimesOutWhenTheServerNeverConfirms() async {
        let transport = await startCall()
        transport.emit(.ready(VoiceReady(format: "pcm16le", rate: 24000, channels: 1, aiGeneratedVoice: true, voice: nil, liveSessionId: nil)))
        await eventually { self.controller.state == .listening }
        controller.end()
        await eventually({ self.controller.state == .idle }, timeout: .seconds(5))
        XCTAssertTrue(transport.closed)
    }
}
