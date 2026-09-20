import Foundation

/// The Live wire format: raw little-endian signed 16-bit mono at 24 kHz, no header.
enum PCM {
    static let sampleRate: Double = 24_000
    static let bytesPerSample = 2
    /// 100 ms frames keep each WebSocket message small and the latency low.
    static let frameSeconds: Double = 0.1
    static var frameBytes: Int { Int(sampleRate * frameSeconds) * bytesPerSample }

    /// Clamp and quantise float samples in -1...1 to Int16 little-endian bytes.
    static func int16Data(_ samples: UnsafeBufferPointer<Float>) -> Data {
        var data = Data(count: samples.count * bytesPerSample)
        data.withUnsafeMutableBytes { raw in
            let out = raw.bindMemory(to: Int16.self)
            for (index, sample) in samples.enumerated() {
                let clamped = max(-1, min(1, sample))
                out[index] = Int16(clamped * Float(Int16.max)).littleEndian
            }
        }
        return data
    }

    static func int16Data(_ samples: [Float]) -> Data {
        samples.withUnsafeBufferPointer { int16Data($0) }
    }

    /// Int16 little-endian bytes back to floats; a trailing odd byte is ignored.
    static func floats(_ data: Data) -> [Float] {
        let count = data.count / bytesPerSample
        var result = [Float](repeating: 0, count: count)
        data.withUnsafeBytes { raw in
            for index in 0..<count {
                let low = UInt16(raw[index * 2]), high = UInt16(raw[index * 2 + 1])
                result[index] = Float(Int16(bitPattern: high << 8 | low)) / Float(Int16.max)
            }
        }
        return result
    }

    /// Root-mean-square level of Int16 bytes in 0...1, for a simple microphone meter.
    static func level(_ data: Data) -> Float {
        let samples = floats(data)
        guard !samples.isEmpty else { return 0 }
        return (samples.reduce(0) { $0 + $1 * $1 } / Float(samples.count)).squareRoot()
    }

    static func seconds(bytes: Int) -> Double {
        Double(bytes / bytesPerSample) / sampleRate
    }
}

/// Accumulates converted microphone bytes into fixed-size frames, carrying any remainder
/// (including a stray odd byte) into the next call so samples never split across messages.
struct PCMChunker: Sendable {
    let frameBytes: Int
    private var pending = Data()

    init(frameBytes: Int = PCM.frameBytes) {
        self.frameBytes = frameBytes
    }

    var pendingBytes: Int { pending.count }

    mutating func append(_ bytes: Data) -> [Data] {
        pending.append(bytes)
        var frames: [Data] = []
        while pending.count >= frameBytes {
            frames.append(Data(pending.prefix(frameBytes)))
            pending.removeFirst(frameBytes)
        }
        return frames
    }

    /// Whatever is left as one even-length frame, e.g. when muting or stopping.
    mutating func drain() -> Data? {
        let even = pending.count - pending.count % PCM.bytesPerSample
        defer { pending.removeAll() }
        return even > 0 ? Data(pending.prefix(even)) : nil
    }
}
