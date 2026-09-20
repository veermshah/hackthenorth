# Live voice bridge (protocol v2)

Endpoint: `/ws/sessions/{session_id}/voice`. Create the canonical session first
(`POST /sessions {worldId, deviceId}` or the session `/localize` hands back) and keep sending
poses to `POST /sessions/{id}/pose`; the voice call attaches to that session's navigation state.
Upgrade with `X-API-Key` like every other request, then authenticate with the first message.

The backend holds the primary OpenAI GPT-Live WebSocket (`gpt-live-1`, client delegation);
the API key never reaches the phone. Delegated requests run through the existing grounded
Responses agent (`OPENAI_MODEL`, e.g. `gpt-5.6-terra`). Navigation cues computed by
`WorldNavigation` are forwarded to the voice as they are emitted, so during a call the phone
should not speak them itself. Implementation: `services/backend/app/services/voice_bridge.py`;
design and phases: `docs/VOICE_AGENT_PLAN.md`.

Enable with `VOICE_ENABLED=true`, `VOICE_ACCESS_TOKEN` (shared demo token, not per-user
authorization; never embed it in a public build) and `OPENAI_API_KEY`. One active call per
session; a second connection is closed with 1008.

## Client → backend

| Message | Notes |
| --- | --- |
| `{"type":"auth","token":"…"}` | First message, within 10 s. |
| `{"type":"audio","audio":"<base64>"}` | Raw PCM16LE mono 24 kHz, no WAV header, even byte count, ≤ 64 KiB encoded; ~100 ms chunks. Keep sending silence while listening. |
| `{"type":"text","text":"…"}` | Typed request (≤ 2000 chars) through the same delegation path; the answer is spoken. |
| `{"type":"mute"}` / `{"type":"unmute"}` | Live input mute; output and backend work continue. |
| `{"type":"close"}` | Graceful end; wait for `closed`. |

## Backend → client

| Message | Notes |
| --- | --- |
| `{"type":"voice_ready","format":"pcm16le","rate":24000,"channels":1,"ai_generated_voice":true,"voice":"marin","liveSessionId":"…"}` | Start capture/playback after this. The UI must show an AI-generated-voice disclosure. |
| `{"type":"audio","audio":"…"}` | Play in order at 24 kHz. Keep ≤ ~250 ms queued: Live is full duplex and there is no audio-done or interruption event on this transport. |
| `{"type":"transcript","speaker":"user\|assistant","delta":"…","start_ms":…,"end_ms":…}` | Fragments on the Live timeline, not complete turns. |
| `{"type":"assistant_response","text":…,"sources":[…],"actions":[…],"tool_calls":[…]}` | Backend result for a delegated request. Apply `actions` to local navigation state: `{"type":"set_destination","destination_id":"room-101" \| "note:<id>","destination_name":"…","accessible_only":bool}` and `{"type":"stop_navigation","destination_id":…}`. |
| `{"type":"navigation","event":{…}}` | Mirror of the session events on `/ws/sessions/{id}` (`progress` without `route`, `rerouted`, `arrived`, `lost`, `localized`, `ended`), throttled to 2 Hz for plain progress. |
| `{"type":"usage","seconds":…}` | Cumulative Live voice seconds (snapshot, not additive). |
| `{"type":"warning","code":"…"}` | A rejected command or moderation cut-off; the call continues. |
| `{"type":"renewed","liveSessionId":"…"}` | The Live session expired and was replaced with the transcript re-seeded; keep streaming. |
| `{"type":"closed","reason":"…","seconds":…,"renewing":bool}` | Live session finished. `renewing: true` means a replacement follows; otherwise the socket closes. Reasons: `close_requested`, `expired`, `content`, `remote_hangup`, `connection_lost`, `max_duration`. |
| `{"type":"error","message":"…"}` | Sanitised; the socket closes. Reconnect explicitly; never replay action requests. |

## How the bridge steers the voice

- Session start: Live prompt `prompts/live_frontend.txt`, voice `VOICE_NAME`, `input` seeded with the
  world's place names and note titles (so the model recognises "Bed 1" as a destination). After
  `session.started` a greeting + AI disclosure is requested with `session.instructions.append`.
- Delegation: `session.delegation.created` carries no task text. The bridge waits
  `VOICE_TRANSCRIPT_GRACE_S` for late fragments, takes the user's speech after the last substantial
  assistant turn (backchannels do not split it), passes the recent dialogue as context, appends
  `thinking` progress, then the agent's answer as `commentary` and, after `set_destination`, a silent
  route summary. No transcript → the model is told to ask the user to repeat.
- Navigation: `progress.speak` phrases become `commentary`; `arrived`, `off-route` and `lost` cues are
  requested verbatim with `instructions.append` (which may interrupt speech). Duplicates within 3 s collapse.
- Situation: every `VOICE_CONTEXT_INTERVAL_S` (when changed) a one-paragraph `thinking` update with the
  nearest stop, notes within 10 m with side, and guidance state.
- Lifecycle: proactive renewal 60 s before Live `expires_at` and after `expired`/`connection_lost`,
  with buffered microphone audio flushed into the new session; `VOICE_MAX_MINUTES` caps a call.

## Limitations

Obstacle warnings stay on haptics; this path is not the hazard channel. Cue wording sent as commentary
may be paraphrased. Delegation/transcript timing on real sessions is being verified in Phase 0
(`python -m services.backend.scripts.test_voice --say "where am I"`, `VOICE_TRACE=true` on the backend).

Guidance targets are graph nodes and notes pinned in the web viewer (`note:<id>`): the route ends on the
walkable edge beside the note and the arrival cue adds where the note is ("Bed 1 is 2 metres on your
right"). `DELETE /sessions/{id}/destination` stops guidance; `POST /sessions/{id}/pose` accepts poses
with no destination, so the phone should stream poses whenever it has a fresh fix and adopt destinations
from `assistant_response.actions`. Protocol reference:
https://developers.openai.com/api/reference/resources/live/primary-websocket
