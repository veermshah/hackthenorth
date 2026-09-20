import AVFoundation
import Foundation
import os

/// What a voice call needs from the audio hardware, so the controller can be tested without it.
@MainActor
protocol VoiceAudio: AnyObject {
    var inputLevel: Float { get }
    /// Start capturing; `onFrame` receives 100 ms PCM16 frames on an arbitrary thread, in order.
    func start(onFrame: @escaping @Sendable (Data) -> Void) throws
    func stop()
    /// Queue a chunk of PCM16 24 kHz mono for playback.
    func enqueue(_ pcm: Data)
    /// Drop everything not yet heard.
    func flush()
    func setMuted(_ muted: Bool)
}

enum VoiceAudioError: Error, LocalizedError {
    case noInput
    case converter

    var errorDescription: String? {
        switch self {
        case .noInput: "No microphone input is available."
        case .converter: "The microphone format cannot be converted to 24 kHz PCM."
        }
    }
}

/// State the realtime input tap touches; everything behind one lock and nothing main-actor.
final class CaptureState: @unchecked Sendable {
    private struct Guarded {
        var converter: AVAudioConverter?
        var inputFormat: AVAudioFormat?
        var chunker = PCMChunker()
        var muted = false
        var rebuilds = 0
        /// Seconds of below-threshold audio since the last speech, for the uplink gate.
        var silence = CaptureState.hangoverSeconds
        /// The tail of what the gate dropped, replayed ahead of the next speech so onsets survive.
        var preroll = Data()
        var onFrame: (@Sendable (Data) -> Void)?
        var onLevel: (@Sendable (Float) -> Void)?
    }

    /// The uplink is the scarcest thing the phone has: a call spends 64 KB/s on 24 kHz PCM for as
    /// long as it is up, which is roughly one VPS query image every second, and the phone uploads
    /// those one at a time. So the stream is gated on speech.
    ///
    /// This deliberately costs the voice guide a little: the Live session hears silence only for
    /// `hangoverSeconds` after each utterance rather than continuously, and speech quieter than
    /// `gateLevel` at the chest mount is dropped. The hangover is what the server's turn detection
    /// needs to hear to end a turn, so it stays generous.
    static let gateLevel: Float = 0.015
    static let hangoverSeconds: Double = 1.0
    static let prerollSeconds: Double = 0.2

    // Unchecked: the converter and closures are not Sendable, but only ever touched under this lock.
    private let lock = OSAllocatedUnfairLock(uncheckedState: Guarded())
    private let target: AVAudioFormat

    init(target: AVAudioFormat) {
        self.target = target
    }

    /// Point the capture at `inputFormat`, or `nil` to tear it down. False when no converter to
    /// 24 kHz Int16 exists for that format, which the caller reports as `VoiceAudioError.converter`.
    @discardableResult
    func reset(inputFormat: AVAudioFormat?, onFrame: (@Sendable (Data) -> Void)?, onLevel: (@Sendable (Float) -> Void)?) -> Bool {
        lock.withLockUnchecked { state -> Bool in
            state.chunker = PCMChunker()
            state.onFrame = onFrame
            state.onLevel = onLevel
            state.inputFormat = inputFormat
            guard let inputFormat else {
                state.converter = nil
                return true
            }
            state.converter = AVAudioConverter(from: inputFormat, to: target)
            return state.converter != nil
        }
    }

    /// How often a buffer arrived in a format the converter was not built for; diagnostics only.
    var rebuildCount: Int { lock.withLockUnchecked { $0.rebuilds } }

    func setMuted(_ muted: Bool) {
        lock.withLockUnchecked { $0.muted = muted }
    }

    /// Called on the audio thread with the hardware-format buffer from the input tap.
    func process(_ buffer: AVAudioPCMBuffer) {
        let format = buffer.format
        // A route change (Bluetooth, a headset, the speaker/receiver switch) can hand the tap a new
        // hardware format before the main-queue configuration-change handler has rebuilt the engine.
        // Converting such a buffer with the previous converter raises an Objective-C exception that
        // Swift cannot catch, so every buffer is checked and the converter replaced in place. The
        // zero checks also keep the capacity arithmetic below off infinity and NaN.
        guard format.sampleRate > 0, format.channelCount > 0, buffer.frameLength > 0 else { return }
        var frames: [Data] = []
        var level: Float = 0
        var callbacks: ((@Sendable (Data) -> Void)?, (@Sendable (Float) -> Void)?) = (nil, nil)
        lock.withLockUnchecked { state in
            guard let current = state.inputFormat else { return }
            if !current.isEqual(format) {
                guard let rebuilt = AVAudioConverter(from: format, to: target) else { return }
                state.converter = rebuilt
                state.inputFormat = format
                state.chunker = PCMChunker()
                state.rebuilds += 1
            }
            guard let converter = state.converter else { return }
            let converted = Double(buffer.frameLength) * target.sampleRate / format.sampleRate
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(converted.rounded(.up)) + 16) else { return }
            var consumed = false
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, outStatus in
                if consumed {
                    outStatus.pointee = .noDataNow
                    return nil
                }
                consumed = true
                outStatus.pointee = .haveData
                return buffer
            }
            guard status != .error, out.frameLength > 0, let channel = out.int16ChannelData else { return }
            var data = Data(bytes: channel[0], count: Int(out.frameLength) * PCM.bytesPerSample)
            level = PCM.level(data)
            callbacks = (state.onFrame, state.onLevel)
            // Muted: send nothing at all. The Live session is told with session.input_audio.mute,
            // so its timeline does not need a stream of zeros -- and zeros cost the same uplink as
            // speech, which is uplink the query images are queued behind.
            if state.muted {
                state.chunker = PCMChunker()
                state.preroll.removeAll()
                state.silence = Self.hangoverSeconds
                callbacks.0 = nil
                return
            }
            state.silence = level >= Self.gateLevel ? 0 : state.silence + PCM.seconds(bytes: data.count)
            guard state.silence < Self.hangoverSeconds else {
                // Gate shut: hold only enough of the room to cover the next word's onset.
                state.preroll.append(data)
                let keep = Int(PCM.sampleRate * Self.prerollSeconds) * PCM.bytesPerSample
                if state.preroll.count > keep { state.preroll.removeFirst(state.preroll.count - keep) }
                _ = state.chunker.drain()
                callbacks.0 = nil
                return
            }
            if !state.preroll.isEmpty {
                data = state.preroll + data
                state.preroll.removeAll()
            }
            frames = state.chunker.append(data)
        }
        callbacks.1?(level)
        for frame in frames {
            callbacks.0?(frame)
        }
    }
}

/// Microphone capture and PCM playback for a call through one `AVAudioEngine`.
///
/// Capture: hardware format → 24 kHz mono Int16 → 100 ms frames. Playback: the backend's 24 kHz
/// Int16 stream, scheduled only a quarter second ahead so that when the wearer interrupts, little
/// stale speech is already committed to the hardware; the rest waits here and can be flushed.
@MainActor
final class VoiceAudioIO: ObservableObject, VoiceAudio {
    @Published private(set) var inputLevel: Float = 0
    @Published private(set) var isRunning = false
    /// False when Apple's voice-processing unit refused to start: the guide will hear itself
    /// through the loudspeaker. Diagnostics for the console; the call runs either way.
    private(set) var echoCancellation = true

    /// Playback committed to the player node at any time.
    var aheadSeconds: Double = 0.25
    /// Safety valve: beyond this much unplayed audio the oldest is dropped.
    var maxQueuedSeconds: Double = 1.5

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: PCM.sampleRate, channels: 1, interleaved: false)!
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: PCM.sampleRate, channels: 1, interleaved: true)!
    private lazy var capture = CaptureState(target: target)
    private var pending: [AVAudioPCMBuffer] = []
    private var scheduledSeconds: Double = 0
    private var onFrame: (@Sendable (Data) -> Void)?
    private var muted = false
    private var attached = false
    private var observers: [NSObjectProtocol] = []

    func start(onFrame: @escaping @Sendable (Data) -> Void) throws {
        self.onFrame = onFrame
        try AudioSessionCoordinator.shared.activate(.call)
        try startEngine()
        if observers.isEmpty {
            let center = NotificationCenter.default
            // A headset plugging in or Bluetooth connecting changes the input format: rebuild the tap.
            observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.restart() }
            })
            observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
                let ended = raw == AVAudioSession.InterruptionType.ended.rawValue
                Task { @MainActor in
                    if ended { self?.restart() } else { self?.pause() }
                }
            })
        }
    }

    private func startEngine() throws {
        let input = engine.inputNode
        // Apple's voice-processing I/O unit cancels our own loudspeaker out of the microphone;
        // without it the chest speaker's reply feeds straight back into the request. It has to be
        // set on a stopped engine and it changes the input format, so it comes before the read below.
        if !input.isVoiceProcessingEnabled {
            do {
                try input.setVoiceProcessingEnabled(true)
                echoCancellation = true
            } catch {
                // Not fatal: the call still works, and on a headset nothing is lost. On the
                // loudspeaker the guide hears itself, so say so rather than swallowing it.
                echoCancellation = false
                print("[voice] voice processing unavailable, echo cancellation is off: \(error)")
            }
        }
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { throw VoiceAudioError.noInput }
        guard capture.reset(inputFormat: inputFormat, onFrame: onFrame, onLevel: { [weak self] level in
            Task { @MainActor in self?.inputLevel = level }
        }) else { throw VoiceAudioError.converter }
        capture.setMuted(muted)
        input.removeTap(onBus: 0)
        let capture = self.capture
        input.installTap(onBus: 0, bufferSize: 2400, format: inputFormat) { buffer, _ in
            capture.process(buffer)
        }
        // Attach once, but rewire on every start: a configuration change can leave the player
        // disconnected, and play()/scheduleBuffer on a disconnected node raises an Objective-C
        // exception. Reconnecting a connected node is a no-op, so this is cheap.
        if !attached {
            engine.attach(player)
            attached = true
        }
        engine.disconnectNodeOutput(player)
        engine.connect(player, to: engine.mainMixerNode, format: output)
        engine.prepare()
        try engine.start()
        player.play()
        isRunning = true
        // A restart mid-sentence left the rest of the answer queued here; keep playing it.
        pump()
    }

    private func pause() {
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        scheduledSeconds = 0
        isRunning = false
    }

    private func restart() {
        guard onFrame != nil else { return }
        pause()
        do {
            try AudioSessionCoordinator.shared.activate(.call, force: true)
            try startEngine()
        } catch {
            print("[voice] audio restart failed: \(error)")
        }
    }

    func stop() {
        pause()
        pending.removeAll()
        onFrame = nil
        capture.reset(inputFormat: nil, onFrame: nil, onLevel: nil)
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
        inputLevel = 0
        // Release the microphone; spoken cues re-activate plain playback when they need it.
        try? AudioSessionCoordinator.shared.activate(.idle)
    }

    func setMuted(_ muted: Bool) {
        self.muted = muted
        capture.setMuted(muted)
    }

    func enqueue(_ pcm: Data) {
        guard isRunning else { return }
        let samples = PCM.floats(pcm)
        guard !samples.isEmpty, let buffer = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            channel[0].update(from: source.baseAddress!, count: samples.count)
        }
        pending.append(buffer)
        var queued = pending.reduce(0.0) { $0 + Double($1.frameLength) } / PCM.sampleRate
        while queued > maxQueuedSeconds, !pending.isEmpty {
            queued -= Double(pending.removeFirst().frameLength) / PCM.sampleRate
        }
        pump()
    }

    func flush() {
        pending.removeAll()
        guard isRunning else { return }
        player.stop()
        scheduledSeconds = 0
        player.play()
    }

    private func pump() {
        while scheduledSeconds < aheadSeconds, !pending.isEmpty {
            let buffer = pending.removeFirst()
            let seconds = Double(buffer.frameLength) / PCM.sampleRate
            scheduledSeconds += seconds
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor in self?.played(seconds) }
            }
        }
    }

    private func played(_ seconds: Double) {
        scheduledSeconds = max(0, scheduledSeconds - seconds)
        pump()
    }
}
