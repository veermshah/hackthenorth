import XCTest
@testable import NavigationAssistant

final class VoiceProtocolTests: XCTestCase {
    private func json(_ message: VoiceClientMessage) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: message.json) as? [String: Any])
    }

    func testClientMessagesMatchTheContract() throws {
        XCTAssertEqual(try json(.auth(token: "demo")) as NSDictionary, ["type": "auth", "token": "demo"])
        let pcm = Data([0, 0, 0x80, 0xFF])
        XCTAssertEqual(try json(.audio(pcm: pcm)) as NSDictionary, ["type": "audio", "audio": pcm.base64EncodedString()])
        XCTAssertEqual(try json(.text("guide me to bed one")) as NSDictionary, ["type": "text", "text": "guide me to bed one"])
        XCTAssertEqual(try json(.mute) as NSDictionary, ["type": "mute"])
        XCTAssertEqual(try json(.unmute) as NSDictionary, ["type": "unmute"])
        XCTAssertEqual(try json(.close) as NSDictionary, ["type": "close"])
    }

    func testServerMessagesDecode() throws {
        func decode(_ text: String) throws -> VoiceServerMessage { try VoiceServerMessage(json: Data(text.utf8)) }

        let ready = try decode("""
        {"type":"voice_ready","format":"pcm16le","rate":24000,"channels":1,"ai_generated_voice":true,"voice":"marin","liveSessionId":"live_1"}
        """)
        guard case .ready(let info) = ready else { return XCTFail("\(ready)") }
        XCTAssertEqual(info.rate, 24000)
        XCTAssertTrue(info.aiGeneratedVoice)
        XCTAssertEqual(info.liveSessionId, "live_1")

        XCTAssertEqual(try decode("{\"type\":\"audio\",\"audio\":\"AAAAAA==\"}"), .audio(Data([0, 0, 0, 0])))
        XCTAssertThrowsError(try decode("{\"type\":\"audio\",\"audio\":\"AAAA\"}"))   // three bytes are not whole samples
        XCTAssertThrowsError(try decode("{\"type\":\"audio\",\"audio\":\"!\"}"))

        XCTAssertEqual(try decode("{\"type\":\"transcript\",\"speaker\":\"user\",\"delta\":\"Guide me\",\"start_ms\":100,\"end_ms\":900}"),
                       .transcript(VoiceTranscript(speaker: "user", delta: "Guide me", startMs: 100, endMs: 900)))

        let response = try decode("""
        {"type":"assistant_response","text":"Starting guidance to Bed 1.","sources":[{"type":"map_entity","id":"note:n1"}],
         "actions":[{"type":"set_destination","destination_id":"note:n1","destination_name":"Bed 1","accessible_only":false}],"tool_calls":[]}
        """)
        guard case .assistantResponse(let answer) = response else { return XCTFail("\(response)") }
        XCTAssertEqual(answer.text, "Starting guidance to Bed 1.")
        XCTAssertEqual(answer.actions, [AssistantAction(type: "set_destination", destinationId: "note:n1", destinationName: "Bed 1", accessibleOnly: false)])

        let navigation = try decode("""
        {"type":"navigation","event":{"type":"progress","sessionId":"s","timestamp":"2026-09-19T12:00:00Z",
         "progress":{"state":"navigating","remainingMetres":5.5,"speak":"Continue straight for 5 metres."},
         "route":{"nodes":[{"id":"a","position":[0,0,0]},{"id":"note:n1","name":"Bed 1","kind":"destination","position":[0,0,-5]}],"totalMetres":5,"legs":[],"instructions":[]}}}
        """)
        guard case .navigation(let event) = navigation else { return XCTFail("\(navigation)") }
        XCTAssertEqual(event.type, "progress")
        XCTAssertEqual(event.progress?.speak, "Continue straight for 5 metres.")
        XCTAssertEqual(event.destinationLabel, "Bed 1")

        XCTAssertEqual(try decode("{\"type\":\"usage\",\"seconds\":12.5}"), .usage(seconds: 12.5))
        XCTAssertEqual(try decode("{\"type\":\"warning\",\"code\":\"unknown_parameter\"}"), .warning(code: "unknown_parameter"))
        XCTAssertEqual(try decode("{\"type\":\"renewed\",\"liveSessionId\":\"live_2\"}"), .renewed(liveSessionId: "live_2"))
        XCTAssertEqual(try decode("{\"type\":\"closed\",\"reason\":\"expired\",\"seconds\":30,\"renewing\":true}"),
                       .closed(reason: "expired", seconds: 30, renewing: true))
        XCTAssertEqual(try decode("{\"type\":\"error\",\"message\":\"Voice unavailable\"}"), .error(message: "Voice unavailable"))
        XCTAssertEqual(try decode("{\"type\":\"capture_request\",\"id\":\"c1\"}"), .unknown(type: "capture_request"))
        XCTAssertThrowsError(try decode("not json"))
    }

    func testVoiceSocketURLFollowsTheBackendScheme() {
        XCTAssertEqual(URL(string: "https://x.modal.run")!.voiceSocketURL(sessionId: "abc")?.absoluteString,
                       "wss://x.modal.run/ws/sessions/abc/voice")
        XCTAssertEqual(URL(string: "http://192.168.1.5:8000/")!.voiceSocketURL(sessionId: "abc")?.absoluteString,
                       "ws://192.168.1.5:8000/ws/sessions/abc/voice")
        XCTAssertEqual(URL(string: "https://host/api?key=1")!.voiceSocketURL(sessionId: "s")?.absoluteString,
                       "wss://host/api/ws/sessions/s/voice")
    }

    func testVoiceSettingsGateAndSeed() {
        var settings = CameraSettings.default
        XCTAssertFalse(settings.canStartVoiceCall)
        settings.voiceAgentEnabled = true
        settings.backendURL = "https://x.modal.run"
        settings.backendAPIKey = "k"
        XCTAssertFalse(settings.canStartVoiceCall)   // token still missing
        settings.seed(from: ["VoiceAccessToken": "demo"])
        XCTAssertTrue(settings.canStartVoiceCall)
        let config = VoiceCallController.Config(settings: settings)
        XCTAssertEqual(config?.token, "demo")
        XCTAssertEqual(config?.apiKey, "k")
        // Older persisted settings without the new keys decode to the defaults.
        let legacy = Data("{\"captureIntervalMs\":300}".utf8)
        let decoded = try? JSONDecoder().decode(CameraSettings.self, from: legacy)
        XCTAssertEqual(decoded?.voiceAgentEnabled, false)
        XCTAssertEqual(decoded?.voiceAgentAutoStart, true)
    }
}
