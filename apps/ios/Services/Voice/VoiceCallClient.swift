import Foundation

/// A connection to the backend's voice socket. A protocol so `VoiceCallController` can be
/// driven by a fake in tests; the real one is a `URLSessionWebSocketTask`.
protocol VoiceTransport: AnyObject, Sendable {
    /// Open the socket. The returned stream carries decoded server messages and finishes when
    /// the socket closes for any reason; the controller treats an unexpected finish as a drop.
    func connect(url: URL, apiKey: String) async throws -> AsyncStream<VoiceServerMessage>
    func send(_ message: VoiceClientMessage) async throws
    func close()
}

final class VoiceWebSocket: VoiceTransport, @unchecked Sendable {
    private let session: URLSession
    private let lock = NSLock()
    private var task: URLSessionWebSocketTask?

    init(session: URLSession = .shared) {
        self.session = session
    }

    func connect(url: URL, apiKey: String) async throws -> AsyncStream<VoiceServerMessage> {
        var request = URLRequest(url: url)
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        request.timeoutInterval = 15
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 1 << 20
        lock.withLock { self.task = task }
        task.resume()
        return AsyncStream { continuation in
            let receiver = Task {
                while !Task.isCancelled {
                    let message: URLSessionWebSocketTask.Message
                    do {
                        message = try await task.receive()
                    } catch {
                        break
                    }
                    let data: Data
                    switch message {
                    case .string(let text): data = Data(text.utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: continue
                    }
                    if let decoded = try? VoiceServerMessage(json: data) {
                        continuation.yield(decoded)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in receiver.cancel() }
        }
    }

    func send(_ message: VoiceClientMessage) async throws {
        guard let task = lock.withLock({ self.task }) else { throw URLError(.cancelled) }
        try await task.send(.string(String(decoding: message.json, as: UTF8.self)))
    }

    func close() {
        let task = lock.withLock { () -> URLSessionWebSocketTask? in
            defer { self.task = nil }
            return self.task
        }
        task?.cancel(with: .normalClosure, reason: nil)
    }
}
