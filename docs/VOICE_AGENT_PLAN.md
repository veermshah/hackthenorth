# Wander voice agent — research and implementation plan

Goal: a hands-free voice agent on the **front (chest) iPhone** that talks with the wearer,
answers basic questions ("where am I", "what's around me", "how far is the elevator"), and
guides a blind or low-vision user to **pins/notes and mapped destinations** on request
("guide me to Bed 1", "take me to the elevator", "stop guidance"). AI models are OpenAI only.

Decisions already taken (2026-09-19):

| Decision | Choice |
| --- | --- |
| Voice model / transport | OpenAI **GPT-Live-1** with **client delegation**; phone ↔ FastAPI over the existing WebSocket relay; FastAPI ↔ OpenAI over the Live primary WebSocket |
| Who speaks navigation cues during a call | **GPT-Live speaks everything** (cues forwarded as commentary). Apple `AVSpeechSynthesizer` stays as the offline fallback when no call is active |
| Camera scene description ("what's in front of me?") | Yes, **later phase** (Phase 4) |
| WebRTC direct from phone | Not now; documented as an upgrade path |

---

## 1. Research: what OpenAI offers today

Sources: developers.openai.com Live guides (`/api/docs/guides/live`, `live-delegation`,
`live-conversations`, `live-prompting`, `voice-websockets?api=live`, `voice-webrtc?api=live`,
`voice-server-controls?api=live`), the Live API reference (`/api/reference/resources/live/primary-websocket`),
model pages for `gpt-live-1`, `gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.6-luna`, and the `voice-agents` guide.

### 1.1 Three architectures

| Architecture | What it is | Fit for Wander |
| --- | --- | --- |
| **GPT-Live** (`gpt-live-1`, `wss://api.openai.com/v1/live/sessions`) | Full-duplex voice model that listens while speaking and **delegates** reasoning/tools to a backend. Two delegation modes: `responses` (OpenAI runs a Responses model) or `client` (your app runs any agent). | **Best fit.** Our grounded tool-calling agent (`BuildingAgentService`) already exists; client delegation lets it stay the single source of truth for routes and map facts, and the conversation keeps flowing while routing runs. The backend bridge in the repo already targets this API. |
| **Realtime API** (`gpt-realtime-2`, `v1/realtime`) | One speech-to-speech model does audio, reasoning and tool selection in one session. | Would require re-hosting our tool loop inside the realtime session and re-proving the grounding rules. Not chosen. |
| **Chained pipeline** (STT → agent → TTS via `agents.voice.VoicePipeline`) | Discrete stages; inspect text between them. | Highest latency, no barge-in, no full duplex. Only a fallback. |

### 1.2 GPT-Live facts that shape the design

- **Connection (server WebSocket).** Connect with `Authorization: Bearer $OPENAI_API_KEY`, send
  `session.start` `{model, instructions, audio: {format: {type: "audio/pcm", rate: 24000|16000}, output: {voice}}, delegation: {type: "client"}, input: [...]}`,
  wait for `session.started`. Audio is base64 raw mono PCM16LE (no WAV header); byte length must be even.
  Voice, format, model, instructions, delegation mode are **immutable after start** (default voice `marin`).
- **Client events we use.** `session.input_audio.append` (mic), `session.input_audio.mute/unmute`,
  `session.instructions.append` (system-level steer, *can interrupt speech*, e.g. greeting/disclosure/"say exactly"),
  `session.thinking.append` (silent context the model may use later), `session.commentary.append`
  (speakable context the model paraphrases), `session.close`. All three append events take plain-string
  `content` ≤ **500 tokens** and a required `delegation_id` (`null` = session-wide).
- **Server events we use.** `session.output_audio.delta` (play in order; **no timing/done event on WS**),
  `session.input_transcript.delta` / `session.output_transcript.delta` (fragments with `start_ms`/`end_ms`;
  **no turn-done event**), `session.delegation.created` (`{delegation: {id, target: "client"}, offset_ms}`;
  contains **metadata, not the utterance**), `session.*.appended` acks (`client_event_id`),
  `session.usage.updated` (`usage.seconds`, `context_window.usage_ratio`), `error` (rejected commands and
  non-fatal moderation cut-offs also arrive here), `session.closed` (`reason ∈ close_requested|expired|content|remote_hangup|connection_lost`).
- **Client delegation contract.** The app must keep transcripts + task state itself, work out the task from
  transcript fragments around `offset_ms`, run the backend, and reply with `session.commentary.append`
  (result to say) / `session.thinking.append` (progress). Multiple updates per delegation ID are allowed.
- **Steering without a delegation.** Any time, `delegation_id: null` appends can push context: this is how
  navigation cues, arrival, off-route, tracking lost, and "what's around" context reach the voice.
- **Startup history.** `session.input` accepts ≤ 128 text messages / 8,192 tokens (developer/user/assistant) —
  used to seed the destination catalogue and to resume after a session renewal.
- **Context window** 128k with automatic summarisation; keep facts in our backend. Sessions can `expire`;
  plan a renewal with saved text history.
- **Pricing/limits.** $0.05 per minute of session time billed per second (≈ $3/hour), backend tokens separate.
  Rate limit is concurrent sessions (Tier 1: 25). WebRTC creation pre-bills 15 s (credited back).
- **WebRTC** (`POST /v1/live/sessions` with SDP, plus a backend **sideband** `wss://api.openai.com/v1/live/sessions/{id}/attach`)
  is the recommended path for browsers/mobile and the natural upgrade later; it needs a WebRTC stack in the iOS app.
- **SDK.** `openai` Python ≥ 3.x exposes `client.live.connect()` / `openai.types.live.*`. The repo pins
  `openai>=2,<3` and the bridge uses the `websockets` package directly, which works and is what the tests mock.
  Migrating to the SDK is optional.

### 1.3 Backend (delegated) models

| Model | Modalities | Notes |
| --- | --- | --- |
| `gpt-6-astra` | text (image input: verify on the model page) | Most capable, `reasoning.effort` low…max; highest latency/cost. Configurable via `OPENAI_MODEL`. |
| `gpt-5.6-terra` | text, image in → text | "Mini" tier, $2/$12 per 1M tokens, function calling, structured outputs, prompt caching. **Recommended default for the voice path** (fast enough for tool loops). |
| `gpt-5.6-luna` | text, image in → text | "Nano" tier, $0.20/$1.20 per 1M. Good for speculative transcript checks and the vision describe tool if latency matters. |

Recommendation: `OPENAI_MODEL=gpt-5.6-terra`, `reasoning.effort=low` for delegated turns; keep
`gpt-6-astra` for the offline annotation pipeline (`ANNOTATION_MODEL`), where latency does not matter.

---

## 2. What exists in the repo today

### 2.1 Backend (`services/backend`)

| Area | Status | Key files |
| --- | --- | --- |
| Live voice bridge (phone ↔ FastAPI ↔ OpenAI Live) | **Implemented, protocol-correct, never run against a real session** ("mocked protocol tests"). Auth token first message, PCM16/24k relay, transcript window → `agent.query` on `session.delegation.created`, answer chunked into `session.commentary.append`, 15-min cap. | `app/api/voice_ws.py`, `tests/test_voice.py`, `scripts/test_voice.py`, `shared/contracts/voice.md`, `ANNOTATION_AND_VOICE.md` |
| Grounded text agent (Responses API, strict function tools, 8-iteration loop, history) | Implemented and tested | `app/services/building_agent.py`, `app/integrations/openai/agent.py`, `tools.py`, `prompts/building_assistant.txt` |
| Tools bound to the persisted world | `get_current_location` (nearest node + reviewed landmarks with relative bearing), `get_navigation_state`, `search_places`, `set_destination` (canonical sessions); knowledge/events/context/hotspots via Elastic | `app/services/world_agent.py`, `agent_tools.py` |
| Deterministic routing + live guidance | Dijkstra, edge snapping, turn/landmark phrasing, progress + `speak` phrases, off-route reroute, arrival, tracking lost; events broadcast to `store.sockets[session_id]` | `app/services/worlds.py` (`compute_route`, `WorldNavigation.pose/destination`, `WorldStore.emit`) |
| Notes pinned in the web viewer | Stored `worlds/<id>/notes.json`; `GET/PUT /worlds/{id}/notes`. **Not routable** (not graph nodes). | `app/api/worlds.py:236-258`, `shared/contracts/notes.schema.json` |
| Dashboard WS | Read-only session events (`progress`, `rerouted`, `arrived`, `lost`, `localized`, `ended`) | `app/api/worlds.py:~719` |
| Config | `OPENAI_LIVE_MODEL=gpt-live-1`, `VOICE_ENABLED`, `VOICE_ACCESS_TOKEN`, `OPENAI_MODEL` | `app/config.py`, `.env.example` |

### 2.2 iOS (`apps/ios`)

| Area | Status |
| --- | --- |
| Front pipeline: ARKit + LiDAR obstacle zones, Niantic VPS, pose reporting (`/localize`, `/sessions/{id}/pose`), haptics to side phones | Implemented (`Features/Front/FrontPipeline.swift`) |
| Speech output | `SpeechCoordinator` = `AVSpeechSynthesizer`, priority + cooldown, off by default (`voiceCuesEnabled`) |
| Notes | `WorldNotesStore` fetches notes, ranks by distance/bearing, announces within 5 m, overlays on camera |
| Destination selection | Manual `Menu` of graph nodes only (`LocalizationReporter.destinations`) |
| **Voice input / microphone / call UI** | **None.** No `NSMicrophoneUsageDescription`, no audio capture, no WebSocket client, no playback of PCM |
| Audio session | `.playback` + `.spokenAudio` owned by `SpeechCoordinator` |

### 2.3 Web (`apps/web`)

`AssistantCallView.tsx` is a browser-only "call" using Web Speech API + `POST /assistant/query`; unrelated to
the phone and not OpenAI audio. `InspectorPanel` Ask tab streams text answers. Nothing to change for the
phone voice agent; optional later: show voice transcripts in the Live tab.

---

## 3. Gaps — what must be added

1. **iOS voice client**: mic capture → 24 kHz PCM16 mono → WS; PCM playback with a small buffer; audio-session
   ownership (`.playAndRecord`/`.voiceChat` for echo cancellation); call UI accessible to a blind user;
   `NSMicrophoneUsageDescription`.
2. **Pins/notes as destinations**: the routing engine, session schema, `set_destination` tool and the phone's
   destination list only know graph node IDs. "Guide me to Bed 1" (a web-viewer note) is impossible today.
3. **Destination resolution without Elasticsearch**: `search_places` requires Elastic + an embedding endpoint;
   when unconfigured the tool returns "Tool unavailable" and the agent cannot obtain a destination ID.
   Need a local resolver over graph nodes + notes + reviewed landmarks (the LLM disambiguates).
4. **Navigation cues into the voice**: `speak` phrases are only returned to the phone's `POST /sessions/{id}/pose`
   response; the Live bridge never hears them. Need a session-event subscriber → `session.commentary.append`.
5. **Server-set destination ↔ phone**: when the agent calls `set_destination`, the phone does not know; it only
   posts ARKit poses when *it* selected a destination (`LocalizationReporter.report(cameraTransform:)` guard), and
   `POST /sessions/{id}/pose` returns 409 without a destination. Progress would stall at the ≤1 Hz VPS-fix rate.
6. **Stop / change guidance**: no tool or endpoint clears a destination.
7. **Bridge hardening**: greeting + AI-voice disclosure, transcript grace window around `offset_ms`, non-fatal
   `error` handling, single call per session, usage/close reasons, session renewal before expiry, latency logging.
8. **Live prompt** in the recommended template (Backchannel / Interruption / Delegation policy) and a voice-aware
   backend prompt (transcripts contain mistakes; notes are destinations; brevity).
9. **Situational context**: periodic silent context (nearest stop, notes within 10 m, navigation state) so
   "what's around me" is answered instantly and the model never guesses.
10. (Phase 4) **Scene description** from the front camera via a vision-capable Responses model.

---

## 4. Target architecture

```
 chest iPhone (Front role)                     FastAPI (Modal, single container)                    OpenAI
 ┌──────────────────────────┐   WSS /ws/sessions/{id}/voice   ┌────────────────────────────┐   WSS /v1/live/sessions
 │ AVAudioEngine mic tap    │ ── {audio: pcm16 24k b64} ────▶ │ LiveBridge                 │ ── session.input_audio.append ─▶ ┌──────────────┐
 │  → resample 24k Int16    │ ◀─ {audio}, {transcript},       │  • auth, relay audio       │ ◀─ output_audio.delta ────────── │ gpt-live-1   │
 │ AVAudioPlayerNode (≤250ms│    {assistant_response},        │  • TranscriptWindow        │ ◀─ *_transcript.delta ────────── │ full duplex  │
 │  queue)                  │    {navigation}, {usage}, {err} │  • on delegation.created → │ ◀─ delegation.created ────────── └──────────────┘
 │ VoiceCallController      │                                 │      BuildingAgentService  │ ── commentary/thinking.append ─▶
 │ FrontPipeline            │ ── HTTP /localize, /pose ─────▶ │  • SessionEventSubscriber  │
 │  (ARKit, VPS, haptics)   │ ◀─ progressUpdate (speak)       │      store.emit(progress…) │        Responses API (client delegation backend)
 └──────────────────────────┘                                 │      → commentary.append   │ ── responses.create(tools) ───▶ gpt-5.6-terra
                                                              │  • periodic thinking ctx   │ ◀─ function_call / text ───────  (or gpt-6-astra)
                                                              │ WorldNavigation + notes    │
                                                              └────────────────────────────┘
```

Principles kept from the existing design: the deterministic backend alone computes routes; the model never
invents positions; obstacle warnings stay on haptics and are **not** routed through the voice path; the API
key never leaves the server.

---

## 5. Implementation plan

Phases are ordered so that each ends in something demoable. Backend and iOS work in Phases 1–3 can run in parallel
once the wire protocol (§6) is agreed.

**Status (2026-09-19):** Phase 1 is implemented offline-verified — `services/backend/app/services/voice_bridge.py`
(`LiveBridge`, `TranscriptWindow`, session-event forwarding, situational context, renewal, typed input, one call per
session), thin route in `app/api/voice_ws.py`, Live prompt `prompts/live_frontend.txt`, `dialogue` context in
`BuildingAgentService`, `reasoning.effort` in `OpenAIAgentModel`, 13 bridge tests (`tests/test_voice.py`, 156 total
green) plus an ad-hoc end-to-end run against a fake Live WebSocket server. Phase 0 tooling is ready
(`scripts/test_voice.py --say …`, `VOICE_TRACE=true`) but **has not been run against OpenAI**: no API key was
available in this environment. Run it before trusting the grace-window defaults (§5 Phase 0).

**Phase 2 is implemented** (163 tests green): `app/services/destinations.py` (std-lib name resolver with spoken
numbers, digit-decisive scoring, ambiguity returned not guessed), `compute_route` accepts `note:<id>` targets (virtual
destination node on the nearest walkable edge, same-edge shortcut, one-way edges respected), arrival cue adds the
note's relative position, `WorldNavigation.clear_destination` + `DELETE /sessions/{id}/destination`, destination-less
`POST /sessions/{id}/pose`, tools `resolve_destination` / `stop_navigation`, `set_destination` accepts notes,
`search_places` falls back to name matching without Elastic, `AgentContext.destinations` / `nearby_notes`, prompt and
contract updates (`navigation.schema.json` descriptions, `worlds-api.openapi.yaml`, `voice.md`). Deviations from the
plan below: `clear_destination` emits `progress` (with `speak: "Guidance stopped."`) rather than `rerouted`, and the
catalogue reaches the agent through an `AgentContextBuilder(catalogue=…)` hook rather than a new module import.
Remaining backend follow-ups: a note deleted while it is the active destination makes the next pose 404; the iOS
side (Phase 3) must stream poses without a local destination and adopt `set_destination` / `stop_navigation` actions.

**Phase 3 is implemented but unverified on a device/simulator** (this environment has no Xcode): `Services/Voice/`
(`VoiceProtocol`, `PCM`, `AudioSessionCoordinator`, `VoiceAudioIO`, `VoiceWebSocket`), `Features/Voice/`
(`VoiceCallController`, `VoiceCallCard`), `FrontPipeline` integration (auto-start with the camera, speech muted during a
call, actions adopted into `LocalizationReporter`), `LocalizationReporter` streams poses without a local destination and
gains `adopt` / `clearDestination` / `ensureSession`, `WanderBackendClient.createSession` / `clearDestination`, Settings
(`voiceAgentEnabled`, `voiceAccessToken`, `voiceAgentAutoStart`, `VoiceAccessToken` in LocalConfig), microphone usage
string + `audio` background mode, README section, and unit tests (`VoiceProtocolTests`, `VoicePCMTests`,
`VoiceCallControllerTests` with fake transport/audio, `LocalizationReporterTests`). Every file parses under Swift 6; type
checking against the iOS SDK and the audio path on hardware are the first thing to run. Deviations from the plan below:
`AudioSessionCoordinator` is a small class rather than a separate mode enum on `SpeechCoordinator`; the card includes a
typed-request field for the simulator; VoiceOver announces only call boundaries, never the guide's own speech.

### Phase 0 — Prove the bridge against a real Live session (backend)

Purpose: the current bridge has only mocked tests. Before building on it, verify the real event order.

- [ ] Configure `.env`: `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5.6-terra`, `OPENAI_LIVE_MODEL=gpt-live-1`,
      `VOICE_ENABLED=true`, `VOICE_ACCESS_TOKEN=<random>`; run `uvicorn services.backend.app.main:app`.
- [ ] Run `python -m services.backend.scripts.test_voice --input artifacts/question.wav` with a recording of
      "Where am I?" and "Guide me to room 101". Log every upstream event with `offset_ms`/`start_ms`/`end_ms`.
- [ ] Record findings that decide Phase 1 details: does `session.delegation.created.offset_ms` land **before or after**
      the last `input_transcript.delta` of the utterance? How long after? Does commentary get paraphrased? How many
      ms from `commentary.append` to first `output_audio.delta`?
- [ ] Add `--say "<text>"` to the smoke script (Phase 1 typed-input path) so backend logic can be exercised without audio.

### Phase 1 — Backend: voice bridge v2 (`services/backend`)

Refactor `app/api/voice_ws.py` into `app/services/voice_bridge.py` (`LiveBridge` class, testable without FastAPI) and
keep the route thin.

1. **Session start**
   - `instructions` from a new `prompts/live_frontend.txt` (§7.1), `audio.output.voice` from `VOICE_NAME` (default `marin`),
     `delegation: {type: "client"}`, `input`: one developer message with the world name and the **destination catalogue**
     (§5 Phase 2) capped to fit 8k tokens, plus the current navigation state.
   - After `session.started`: `session.instructions.append(delegation_id=null)` with the greeting + AI-voice disclosure
     ("Say exactly: Wander voice guide ready. This voice is AI generated. Ask where you are, what is nearby, or say
     guide me to a place.") — matched by `client_event_id`.
2. **Delegation handling** (fixes the "please repeat" failure mode)
   - `TranscriptWindow.delegate()` collects fragments with `start_ms < offset_ms + grace` and waits up to `grace`
     (default 800 ms, tuned from Phase 0) for late fragments; also passes the **last ~6 user/assistant fragments**
     as `recent_dialogue` so the backend understands "yes", "the first one", "not that one".
   - `BuildingAgentService.query(session_id, text, ui_context=None, dialogue=None)` gains an optional `dialogue`
     developer message ("<voice_context> transcript may contain mistakes …").
   - Immediately on delegation: `session.thinking.append(delegation_id, "Checking the map…")` (silent progress).
   - Result: one `session.commentary.append` with the answer (≤ 500 tokens; split on sentence boundaries only if longer).
     For `set_destination` actions also append `thinking` with the structured route summary (destination, total metres,
     first instruction) so follow-ups ("how far?") do not need another delegation.
3. **Navigation cues into the voice**
   - `SessionEventSubscriber`: an object with `async send_json(event)` registered in `store.sockets[session_id]`
     for the life of the call (same mechanism the dashboard WS uses; removed in `finally`).
   - `progress` events with `progress.speak` → `session.commentary.append(delegation_id=null, content=speak)`.
     `arrived`, `off-route` ("You are off route. Recalculating."), `lost` ("Tracking lost. Navigation paused.") →
     `session.instructions.append(null, "Say exactly, now: …")` because these must not be paraphrased or delayed.
   - Dedupe: never resend the same `(state, atNode, turn)` cue within 3 s (the backend already gates `speak`,
     this is a belt-and-braces guard for reroutes).
   - Mirror every session event to the phone as `{type: "navigation", event}` so the Front screen updates
     without polling.
4. **Silent situational context** — every `VOICE_CONTEXT_INTERVAL_S` (default 5 s) *and* on nearest-node change:
   `session.thinking.append(null, "Position: near Lobby desk (2 m). Facing north-east. Notes within 10 m: Bed 1 (4 m,
   left), Water fountain (7 m, ahead). Guidance: to Room 101, 14 m remaining, next: turn right at Elevator bank.")`.
   Skip when unchanged; ≤ 120 tokens. Sourced from `WorldAgentTools.execute('get_current_location')` +
   `get_navigation_state` (no model call).
5. **Robustness**
   - `error` events: fatal only when no `client_event_id` and `error.type` indicates session failure; rejected appends
     are logged and the call continues. Moderation cut-offs are logged.
   - One active call per session (`app.state.voice_calls: dict[session_id, task]`); a second connection gets 1008.
   - Track `session.usage.updated`; on `session.closed` forward `{type: "closed", reason, seconds}` to the phone.
   - **Renewal**: drop the hard-coded `asyncio.timeout(900)`; read `session.started.session.expires_at` and, one minute
     before it (or on `session.closed` with `expired`/`connection_lost`), start a new upstream session seeded with
     `input` = compact dialogue + current navigation state, keep the phone socket open, and tell the phone
     `{type: "renewed"}`. Never replay delegated actions. `VOICE_MAX_MINUTES` remains as our own cost cap per call.
   - Client `{"type":"text","text":…}` runs the same delegation path (typed fallback / simulator / tests).
   - Client `{"type":"mute"}`/`{"type":"unmute"}` → `session.input_audio.mute/unmute`.
   - Latency log line per delegation: delegation received → agent start → first tool → agent done → commentary ack.
6. **Model settings**: `OpenAIAgentModel` passes `reasoning={'effort': settings.openai_reasoning_effort}` (default `low`)
   and `text={'verbosity': 'low'}`; new settings `openai_reasoning_effort`, `voice_name`, `voice_context_interval_s`,
   `voice_max_minutes`.
7. **Tests** (`tests/test_voice.py`, fake upstream like today):
   greeting/disclosure sent after `session.started`; late transcript fragment inside grace window is included;
   dialogue context passed to `agent.query`; `progress` event → commentary, `arrived` → instructions; unchanged
   context is not re-sent; rejected-append `error` does not end the call; second socket rejected; renewal seeds `input`.

### Phase 2 — Backend: guide to pins/notes and mapped places

1. **`app/services/destinations.py`**
   - `catalog(store, world) -> list[Target]` where `Target = {id, name, kind: 'node'|'note'|'landmark', position, aliases, text}`;
     notes get `id = "note:<noteId>"` and `text = location + description`.
   - `resolve(catalog, query, pose=None, limit=5)`: normalise (lower-case, strip punctuation, number words ↔ digits
     "one"→"1", ordinals, "the"), score exact name > id > token subset > `difflib.SequenceMatcher` ratio ≥ 0.6 on
     name/aliases/text; tie-break by horizontal distance from `pose`. Std-lib only; the LLM does final disambiguation.
2. **Routing to a note** (`worlds.py`)
   - `compute_route(world, request, landmarks, targets)`: `to` may be `note:<id>`. Snap the note position onto the nearest
     walkable edge (reuse `snap`/`projection`) and add a virtual destination node `{id: "note:<id>", name, kind: "destination",
     position: snapped}` wired to that edge (mirror of the existing `start-` virtual node). Arrival text
     "You have arrived at Bed 1." plus a **final approach cue** while within 3 m: "Bed 1 is about 1 metre on your left"
     (`side_of` + `relative(bearing, facing)`), emitted through `live_instruction`/`pose()` like other cues.
   - `WorldNavigation.destination()` / `pose()` / `create()` validate `destination` against the catalogue (nodes ∪ notes).
     Reroutes keep working because `session['destination']` stays the `note:` id.
   - `clear_destination(session_id)` + `DELETE /sessions/{id}/destination` (state → `localizing`, emit `rerouted`).
   - `POST /sessions/{id}/pose` accepts poses **without** a destination (`allow_no_destination=True`, returns
     `{state: "localizing"}`) so the phone can stream ARKit poses before/after the agent picks a destination.
3. **Tools** (`integrations/openai/tools.py`, `services/world_agent.py`)
   - `resolve_destination(query)` → candidates `[{id, name, kind, distance_m, route_distance_m|null, unreachable?, text}]`.
   - `set_destination(destination_id, accessible_only)` accepts `note:` ids.
   - `stop_navigation()` → `clear_destination`, action `{type: "stop_navigation"}`.
   - `search_places`: when Elastic raises `IntegrationUnavailable`, fall back to `resolve()` (evidence class
     `local_catalogue`) instead of "Tool unavailable".
   - `get_current_location`: add `nearby_notes` (title, distance, relative bearing) alongside reviewed landmarks.
4. **Context** (`services/agent_context.py`): `AgentContext.destinations` = catalogue names/ids (nearest first when
   localized, cap 80) and `nearby_notes`. Same list seeds the Live `input` (Phase 1).
5. **Prompt** (`prompts/building_assistant.txt`): add a *Voice conversation context* section (transcripts may be wrong;
   use the latest correction; ask one short question if the target is ambiguous), state that **notes/pins are valid
   destinations**, define the flow *resolve_destination → set_destination → confirm with name + total metres*, add
   `stop_navigation`, and forbid starting guidance for a mere question about a place.
6. **Contracts**: `navigation.schema.json` (`routeRequest.to`, `session.destination` — "node id or `note:<id>`"),
   `shared/contracts/voice.md` v2 (§6), `backend.md` tool list, `notes.schema.json` description ("notes are routable").
7. **Tests**: `tests/test_destinations.py` ("bed one" → Bed 1; "elevator" → Elevator bank; ambiguous "room" returns
   several; distance tie-break); `tests/test_navigation.py` (route to `note:`, arrival, approach cue, clear destination,
   pose without destination); `tests/test_agent.py` (ScriptedModel: `resolve_destination` → `set_destination` produces one
   action; Elastic-less `search_places` fallback); `tests/test_worlds.py` schema round-trip with `note:` destination.

### Phase 3 — iOS: voice call on the front phone (`apps/ios`)

New folder `Services/Voice/` and `Features/Voice/`; all Swift 6 strict concurrency (audio callbacks are `nonisolated`,
buffers guarded by `OSAllocatedUnfairLock`).

1. **`AudioSessionCoordinator`** — single owner of `AVAudioSession`. Modes: `.speech` (today's `.playback/.spokenAudio`)
   and `.call` (`.playAndRecord`, mode `.voiceChat` for Apple AEC/AGC, options `[.defaultToSpeaker, .allowBluetoothHFP,
   .duckOthers]`, preferred sample rate 24 kHz, IO buffer 20 ms). Handles interruption and route-change notifications
   (headset unplug → keep call, switch route). `SpeechCoordinator` requests `.speech` only when no call is active.
2. **`VoiceAudioIO`** — `AVAudioEngine`: input tap (hardware format) → `AVAudioConverter` → Int16 mono 24 kHz →
   100 ms frames (4,800 bytes) → `onFrame(Data)`; playback via `AVAudioPlayerNode.scheduleBuffer` from incoming
   PCM16 with a **queue watermark of ~250 ms** (drop-oldest beyond 1 s) so barge-in leaves little stale speech;
   `flush()`; simple input-level meter for the UI.
3. **`VoiceCallClient`** — `URLSessionWebSocketTask` to `wss://<backend>/ws/sessions/{id}/voice` with `X-API-Key`;
   sends `auth`, `audio`, `text`, `mute`, `close`; decodes `voice_ready`, `audio`, `transcript`, `assistant_response`,
   `navigation`, `usage`, `renewed`, `closed`, `error`; reconnect with backoff, never replaying actions.
4. **`VoiceCallController`** (`@MainActor ObservableObject`) — states `idle → connecting → ready → inCall → ending`;
   waits for `reporter.sessionId` (created by the first `/localize`; if VPS has no fix yet, create one via
   `POST /sessions {worldId, deviceId}` so the user can talk before localizing); exposes captions for both speakers,
   `lastAssistantText`, `usageSeconds`; callbacks `onAction` (destination set/stopped) and `onNavigation`.
5. **`FrontPipeline` integration**
   - While a call is active: `speech.isEnabled = false` and `reporter.onSpeak`/note announcements are **not** spoken
     locally (the backend speaks through Live). When the call ends, local speech resumes per Settings.
   - `LocalizationReporter`: add `adopt(destinationId:)` (mark applied) driven by `assistant_response.actions`
     (`set_destination`/`stop_navigation`) and by `navigation` events; post ARKit poses whenever a session exists
     and the fix is fresh (drop the `destination != nil` guard once the backend accepts destination-less poses);
     include notes (`note:` ids) in `destinations` for the manual menu.
   - `WanderBackendClient`: `createSession`, `clearDestination`, `notes` already exists.
   - Auto-start the call with **Start** when `voiceAgentAutoStart` is on.
6. **UI** (`Features/Voice/VoiceCallCard.swift`, follows `FRONTEND_STYLE.md` / `AppTheme`)
   - A card on the Front screen: 64-pt round button (Wander Blue = start, Wander Pink = end), state pill
     (Connecting / Listening / Speaking / Reconnecting), scrolling captions with user/assistant bubbles,
     "AI-generated voice" line, mute toggle. `accessibilityLabel`s, `accessibilityIdentifier`s (`front.voice.*`),
     Dynamic Type, reduced-motion aware pulse, VoiceOver announcements for state changes.
   - Settings (`CameraSettings`/`CameraSettingsView`): `voiceAgentEnabled`, `voiceAccessToken`, `voiceAgentAutoStart`;
     `LocalConfig.example.plist` gains `VoiceAccessToken`.
   - `project.yml`/`Info.plist`: `NSMicrophoneUsageDescription`; optional `UIBackgroundModes: [audio]` (ARKit still
     needs the app in the foreground; the chest phone already disables the idle timer).
7. **Tests** (`Tests/Unit`): `VoiceProtocolTests` (encode/decode every message), `PCMConversionTests`
   (48 kHz Float32 → 24 kHz Int16 frame sizes, even byte counts), `VoiceCallControllerTests` (state machine with a fake
   client; actions adopt destination; local speech disabled during call), `LocalizationReporterTests` (poses sent without
   local destination; `adopt`). UI test: `front.voice.start` exists and is enabled after Start.

### Phase 4 — Camera scene description (later)

- Tool `describe_view(question)` on the backend: bridge sends `{type: "capture_request", id}` to the phone; the phone
  JPEG-encodes the latest `ARFrame` with the existing `FrameEncoder` (≤ 640 px) and replies `{type: "frame", id, jpegBase64,
  width, height}`. Fallback within 2 s: the newest uploaded localization query JPEG for the session if < 3 s old.
- Backend calls Responses (`VISION_MODEL`, default `gpt-5.6-terra`; `gpt-5.6-luna` if latency dominates) with the image,
  the question, pose/heading and nearby notes; prompt: describe for a blind pedestrian — layout, openings, obstacles,
  people, readable signage — two sentences, never say "clear" or "safe". Result → `session.commentary.append(delegation_id)`.
- Live prompt gains a capability line ("Describe what the camera sees when asked"). Tests with a fixture JPEG and a
  scripted vision model.

### Phase 5 — Optional polish

- Web Live tab: show voice transcripts (`store.emit` a `voice_transcript` event) next to the phone frustum.
- WebRTC upgrade path: phone WebRTC → `POST /v1/live/sessions` via FastAPI, backend sideband for delegation/cues.
- Per-user auth for the voice socket instead of the shared `VOICE_ACCESS_TOKEN`.
- Wake word / hardware trigger (Action button shortcut → `wander://voice`).

---

## 6. Wire protocol v2 — phone ↔ FastAPI `/ws/sessions/{id}/voice`

Upgrade with `X-API-Key`. First message within 10 s: `{"type":"auth","token":"<VOICE_ACCESS_TOKEN>"}`.

| Direction | Message | Notes |
| --- | --- | --- |
| → | `{"type":"audio","audio":"<b64 pcm16le mono 24k>"}` | ~100 ms chunks, ≤ 64 KiB encoded, even byte count |
| → | `{"type":"text","text":"…"}` | typed fallback; same delegation path |
| → | `{"type":"mute"}` / `{"type":"unmute"}` | maps to Live input mute |
| → | `{"type":"frame","id":"…","jpegBase64":"…","width":…,"height":…}` | Phase 4 reply to `capture_request` |
| → | `{"type":"close"}` | graceful end |
| ← | `{"type":"voice_ready","format":"pcm16le","rate":24000,"channels":1,"ai_generated_voice":true,"voice":"marin","liveSessionId":"…"}` | |
| ← | `{"type":"audio","audio":"…"}` | play in order |
| ← | `{"type":"transcript","speaker":"user\|assistant","delta":"…","start_ms":…,"end_ms":…}` | fragments, not turns |
| ← | `{"type":"assistant_response","text":…,"sources":[…],"actions":[…],"tool_calls":[…]}` | phone adopts `set_destination` / `stop_navigation` actions |
| ← | `{"type":"navigation","event":{…SessionEvent…}}` | mirrors dashboard WS events |
| ← | `{"type":"capture_request","id":"…"}` | Phase 4 |
| ← | `{"type":"usage","seconds":…}` / `{"type":"renewed"}` / `{"type":"closed","reason":"…","seconds":…}` | |
| ← | `{"type":"error","message":"…"}` | sanitised |

---

## 7. Prompts

### 7.1 Live front-end (`prompts/live_frontend.txt`, ≤ 16k tokens, template from the prompting guide)

```
You are Wander, a calm, clear voice guide for a blind or low-vision person walking through a mapped building.
Speak briefly at an unhurried pace: one or two short sentences, plain words, no lists. Give distances in metres
and directions as left, right, ahead or behind relative to the user. Never describe formatting.

Backchannel policy: Use minimal backchannels. Never talk over a navigation cue.
Interruption policy: Stop speaking when the user interrupts and listen.

Delegation policy:
Backend tools:
- Location: where the user is, the nearest mapped stop, and which notes or landmarks are nearby.
- Guidance: start, change or stop guidance to a mapped destination, pin or note, for example "Bed 1", "the elevator", "Room 101".
- Navigation status: remaining distance and the next turn.
- Building information: reviewed notes and building documents.
Delegate to the backend when:
- The user asks where they are, what is around them, how far something is, or asks a building fact.
- The user asks to be guided somewhere, or changes or cancels the destination.
Do not delegate to the backend when:
- The user greets you or asks you to repeat what you just said.
- You need one brief clarification, for example which of two similarly named places.
Delegate before giving any answer that depends on the map or the user's position. Do not guess positions,
distances or routes while waiting. Navigation cues arrive as context: say them promptly and keep their wording.
Never say a path is clear or safe; the phone's vibration handles obstacles. This voice is AI generated.
```

### 7.2 Backend agent (`prompts/building_assistant.txt` additions)

- "You are answering inside a live voice conversation. Transcripts can contain mistakes, unfinished phrases and later
  corrections; prefer the latest wording and verified map data. Return the facts, the current status and the next step
  in one to two spoken sentences."
- "Notes pinned in the map (kind `note`) are valid destinations. For any guidance request call `resolve_destination`;
  if exactly one candidate matches well, call `set_destination` with its id and confirm with its name and the total
  distance; if several match, ask which one, naming at most three. For 'stop', 'cancel' or 'I'm done' call
  `stop_navigation`."

---

## 8. Configuration

```dotenv
OPENAI_API_KEY=…
OPENAI_MODEL=gpt-5.6-terra          # delegated agent (gpt-6-astra also works, slower)
OPENAI_REASONING_EFFORT=low
OPENAI_LIVE_MODEL=gpt-live-1
VOICE_ENABLED=true
VOICE_ACCESS_TOKEN=<random demo token; also in the phone's LocalConfig.plist>
VOICE_NAME=marin
VOICE_CONTEXT_INTERVAL_S=5
VOICE_MAX_MINUTES=60                # our own per-call cost cap; Live expiry is read from session.started.expires_at
VISION_MODEL=gpt-5.6-terra          # Phase 4
```

Modal: update the `htn-backend` secret and redeploy (`python -m services.backend.scripts.deploy`). WebSocket routes run in
the single existing container; long-lived sockets are fine within the function timeout. Phone `LocalConfig.plist`:
`VoiceAccessToken` next to the existing backend URL/key.

---

## 9. Verification

| Layer | Command / check |
| --- | --- |
| Backend unit | `python -m pytest -q services/backend` (no paid calls; fake Live upstream) |
| Backend offline voice sim | `python -m services.backend.scripts.simulate_voice_nav` (new): fake upstream + scripted poses → asserts greeting, delegation → commentary, progress → commentary, arrival → instructions |
| Backend paid smoke | `python -m services.backend.scripts.test_voice --input artifacts/guide-to-bed-1.wav` and `--say "guide me to bed 1"`; expect `assistant_response.actions[0].type == set_destination` and `navigation` events |
| iOS unit/UI | `cd apps/ios && xcodegen generate && xcodebuild test -project NavigationAssistant.xcodeproj -scheme NavigationAssistant -destination 'platform=iOS Simulator,name=iPhone 17 Pro'` (simulator: typed `text` path + placeholder frames) |
| Device end-to-end | Chest phone localized in the demo world with notes "Bed 1", "Elevator": say "where am I", "what's around me", "guide me to bed one", walk, hear turn cues, arrival + approach cue; "stop guidance"; barge-in mid-sentence; headset unplug; 20-minute call (renewal) |
| Latency budget | Log per delegation: target < 1.5 s delegation → commentary for location questions, < 2.5 s for guidance (one resolve + one set) |

---

## 10. Risks and known limitations

- **Transcript/delegation timing** on client delegation is only partially specified (no turn-done event). Phase 0 measures
  it; the grace window + recent-dialogue context mitigate; a wrong guess must produce a clarification, never an action.
- **Paraphrasing**: `commentary.append` is paraphrased; time-critical cues (arrived / off-route / lost) use
  `instructions.append` with "say exactly", which can also interrupt current speech.
- **No output-audio-done/interruption event on WS**: the phone keeps ≤ 250 ms queued so barge-in leaves little stale audio.
- **Echo**: chest-mounted speaker + mic relies on Apple's `.voiceChat` AEC; recommend a bone-conduction or Bluetooth headset
  for the demo. Bluetooth HFP narrows the mic band; still adequate for speech.
- **Safety boundary**: voice is not the hazard channel; haptics remain independent; the prompt forbids "path is clear".
- **Session/cost**: $0.05/min voice + backend tokens; Live sessions expire — renewal is planned in Phase 1.
- **Auth**: shared `VOICE_ACCESS_TOKEN` is demo-only (documented in `voice.md`); per-user auth is Phase 5.
- **Modal**: single container, in-memory agent history; a redeploy drops active calls (phone reconnects, backend re-seeds).
- **Elastic-free operation**: building-document questions still need Elastic; location/guidance work without it after Phase 2.

---

## 11. File-level change list (summary)

Backend: `app/services/voice_bridge.py` (new), `app/api/voice_ws.py` (thin route), `app/services/destinations.py` (new),
`app/services/worlds.py`, `app/services/world_agent.py`, `app/services/agent_context.py`, `app/services/building_agent.py`,
`app/integrations/openai/{tools.py,agent.py,prompts/building_assistant.txt,prompts/live_frontend.txt}`, `app/api/worlds.py`
(`DELETE /sessions/{id}/destination`, destination-less pose), `app/config.py`, `.env.example`,
`scripts/{test_voice.py,simulate_voice_nav.py}`, `tests/{test_voice.py,test_destinations.py,test_navigation.py,test_agent.py}`.

Contracts: `shared/contracts/{voice.md,navigation.schema.json,backend.md,notes.schema.json}`.

iOS: `Services/Voice/{AudioSessionCoordinator,VoiceAudioIO,VoiceCallClient}.swift`,
`Features/Voice/{VoiceCallController,VoiceCallCard}.swift`, `Features/Front/{FrontPipeline,FrontRoleView}.swift`,
`Services/Backend/{LocalizationReporter,WanderBackendClient}.swift`, `Services/Speech/SpeechCoordinator.swift`,
`Features/Settings/{CameraSettings,CameraSettingsView}.swift`, `project.yml`, `App/Info.plist`,
`Resources/LocalConfig.example.plist`, `Tests/Unit/*Voice*`, `README.md`.
