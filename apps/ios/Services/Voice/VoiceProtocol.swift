import Foundation

/// Messages on `/ws/sessions/{id}/voice` (shared/contracts/voice.md, protocol v2).
/// The phone streams PCM16LE mono 24 kHz up and plays the same format down; everything
/// else is small JSON. Encoding and decoding live here so they can be unit tested.
enum VoiceClientMessage: Equatable, Sendable {
    case auth(token: String)
    case audio(pcm: Data)
    case text(String)
    case mute
    case unmute
    case close

    private struct Payload: Encodable {
        let type: String
        var token: String?
        var audio: String?
        var text: String?
    }

    var json: Data {
        let payload: Payload
        switch self {
        case .auth(let token): payload = Payload(type: "auth", token: token)
        case .audio(let pcm): payload = Payload(type: "audio", audio: pcm.base64EncodedString())
        case .text(let text): payload = Payload(type: "text", text: text)
        case .mute: payload = Payload(type: "mute")
        case .unmute: payload = Payload(type: "unmute")
        case .close: payload = Payload(type: "close")
        }
        // Synthesised Encodable omits nil optionals, which is exactly the wire shape.
        return (try? JSONEncoder().encode(payload)) ?? Data()
    }
}

struct VoiceReady: Decodable, Equatable, Sendable {
    let format: String
    let rate: Int
    let channels: Int
    let aiGeneratedVoice: Bool
    let voice: String?
    let liveSessionId: String?

    enum CodingKeys: String, CodingKey {
        case format, rate, channels, voice, liveSessionId
        case aiGeneratedVoice = "ai_generated_voice"
    }
}

/// A transcript fragment on the Live timeline; fragments are not complete turns.
struct VoiceTranscript: Decodable, Equatable, Sendable {
    let speaker: String
    let delta: String
    let startMs: Double?
    let endMs: Double?

    enum CodingKeys: String, CodingKey {
        case speaker, delta
        case startMs = "start_ms"
        case endMs = "end_ms"
    }
}

/// A navigation side effect the backend agent performed; the phone mirrors it locally.
struct AssistantAction: Decodable, Equatable, Sendable {
    let type: String
    let destinationId: String?
    let destinationName: String?
    let accessibleOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case type
        case destinationId = "destination_id"
        case destinationName = "destination_name"
        case accessibleOnly = "accessible_only"
    }
}

struct AssistantResponse: Decodable, Equatable, Sendable {
    let text: String
    let actions: [AssistantAction]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        actions = try c.decodeIfPresent([AssistantAction].self, forKey: .actions) ?? []
    }

    private enum CodingKeys: String, CodingKey { case text, actions }
}

/// Mirror of the dashboard session events (`sessionEvent` in navigation.schema.json).
struct NavigationEvent: Decodable, Equatable, Sendable {
    struct Route: Decodable, Equatable, Sendable {
        let nodes: [GraphNode]
        let totalMetres: Double
    }
    let type: String
    let progress: ProgressUpdate?
    let route: Route?

    /// Name of the route's final node, e.g. the note a `note:` destination resolves to.
    var destinationLabel: String? { route?.nodes.last?.label }
}

enum VoiceServerMessage: Equatable, Sendable {
    case ready(VoiceReady)
    case audio(Data)
    case transcript(VoiceTranscript)
    case assistantResponse(AssistantResponse)
    case navigation(NavigationEvent)
    case usage(seconds: Double)
    case warning(code: String)
    case renewed(liveSessionId: String?)
    case closed(reason: String, seconds: Double, renewing: Bool)
    case error(message: String)
    case unknown(type: String)

    struct DecodingError: Error, Equatable { let reason: String }

    private struct Envelope: Decodable {
        let type: String
        let audio: String?
        let seconds: Double?
        let code: String?
        let liveSessionId: String?
        let reason: String?
        let renewing: Bool?
        let message: String?
        let event: NavigationEvent?
    }

    init(json data: Data) throws {
        let decoder = JSONDecoder()
        let envelope: Envelope
        do {
            envelope = try decoder.decode(Envelope.self, from: data)
        } catch {
            throw DecodingError(reason: "Not a voice message")
        }
        switch envelope.type {
        case "voice_ready":
            self = .ready(try decoder.decode(VoiceReady.self, from: data))
        case "audio":
            guard let text = envelope.audio, let pcm = Data(base64Encoded: text), !pcm.isEmpty, pcm.count % 2 == 0 else {
                throw DecodingError(reason: "Bad audio payload")
            }
            self = .audio(pcm)
        case "transcript":
            self = .transcript(try decoder.decode(VoiceTranscript.self, from: data))
        case "assistant_response":
            self = .assistantResponse(try decoder.decode(AssistantResponse.self, from: data))
        case "navigation":
            guard let event = envelope.event else { throw DecodingError(reason: "Navigation without event") }
            self = .navigation(event)
        case "usage":
            self = .usage(seconds: envelope.seconds ?? 0)
        case "warning":
            self = .warning(code: envelope.code ?? "live_error")
        case "renewed":
            self = .renewed(liveSessionId: envelope.liveSessionId)
        case "closed":
            self = .closed(reason: envelope.reason ?? "unknown", seconds: envelope.seconds ?? 0, renewing: envelope.renewing ?? false)
        case "error":
            self = .error(message: envelope.message ?? "Voice unavailable")
        default:
            self = .unknown(type: envelope.type)
        }
    }
}

extension URL {
    /// `https://host/base` -> `wss://host/base/ws/sessions/{id}/voice`; plain http stays plain ws for LAN dev backends.
    func voiceSocketURL(sessionId: String) -> URL? {
        guard var components = URLComponents(url: self, resolvingAgainstBaseURL: false), let scheme = components.scheme else { return nil }
        components.scheme = scheme.lowercased() == "http" ? "ws" : "wss"
        var path = components.path
        if path.hasSuffix("/") { path.removeLast() }
        components.path = path + "/ws/sessions/\(sessionId)/voice"
        components.query = nil
        return components.url
    }
}
