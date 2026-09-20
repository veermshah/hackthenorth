# iOS app

One SwiftUI app for all four phones. The role picked on first launch decides what
the phone does:

| Role | What runs |
| --- | --- |
| Front | ARKit session with LiDAR depth, obstacle detection, speech, and a loop that snapshots the camera every 200 ms and posts it to Niantic Spatial |
| Left, Right, Back | Haptic buzzer only. No camera. |

## Layout

| Folder | Contents |
| --- | --- |
| `App/` | Entry point, root view, design tokens from `FRONTEND_STYLE.md` |
| `Features/Roles` | `DeviceRole`, persisted `RoleStore`, role picker screen |
| `Features/Settings` | `CameraSettings`, the one ARKit configuration and capture settings shared by every consumer, plus its form |
| `Features/Front` | `FrontPipeline` wiring and the front screen |
| `Features/Connect` | `WorldConnectLink` (`wander://connect` parser) and the QR scanner sheet that configures the phone for a world |
| `Features/Notes` | `WorldNotesStore` + `NoteGeometry` (notes ranked against the pose), the list sheet and the camera overlay |
| `Features/Voice` | `VoiceCallController` (one call: socket, mic stream, playback, captions, actions) and the `VoiceCallCard` on the front screen |
| `Services/Voice` | `VoiceProtocol` (wire messages), `PCM` (frames), `AudioSessionCoordinator`, `VoiceAudioIO` (AVAudioEngine capture/playback), `VoiceWebSocket` |
| `Features/Haptic` | Side and back phone screen |
| `Services/AR` | `ARSessionController`, the single ARKit session |
| `Services/Niantic` | `NianticLocalizer` (NSDK session + VPS2 anchor tracking) and `LocalizationQueryTracker` (pairs the SDK's image queries with the frames it sent) |
| `Services/Backend` | `WanderBackendClient`, `LocalizationReporter` (fixes, poses and image queries to the worlds API) |
| `Services/Localization` | `LocalizationQueryLoop` (200 ms capture), `FrameEncoder`, `NianticRESTTransport` |
| `Services/Obstacles` | `ObstacleDetector` (after Shepherd) and `ObstacleCuePolicy` |
| `Services/Speech`, `Services/Haptics` | Speech coordinator and haptic controller |
| `Tests/Unit`, `Tests/UI` | XCTest and XCUITest targets |

## Build

The Xcode project is generated from `project.yml` with [xcodegen](https://github.com/yonaskolb/XcodeGen):

```sh
brew install xcodegen
cd apps/ios
xcodegen generate
open NavigationAssistant.xcodeproj
```

Deployment target is iOS 26.4. To run on a phone without a paid developer account,
add your Apple ID under Xcode > Settings > Accounts and let Xcode manage signing.

## Tests

```sh
xcodebuild test -project NavigationAssistant.xcodeproj -scheme NavigationAssistant \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

ARKit does not run on the simulator. There the front screen uses a flat placeholder
frame so the query loop, settings, and UI can still be exercised.

## Niantic and backend

Localization uses the Niantic Spatial SDK (Swift package `nsdk-library-xcframework`).
`NianticLocalizer` creates one NSDK session fed by our ARKit session, fetches the
Site's VPS anchor payload through the Sites API, tracks that anchor, and turns each
anchor update into the device pose in the site frame. The SDK submits camera frames
itself at 5 requests a second until the first fix, then once a second.
`LocalizationReporter` posts fixes to the Wander backend's `POST /worlds/{id}/localize`
and in-between ARKit poses to `POST /sessions/{id}/pose`, at most five times a second.

### Image queries

The SDK has no "localize this image" call: `NSDKSession.update()` pulls the newest ARKit
frame from `DefaultSessionDataSource` and the VPS2 session decides which frames to send.
What it does expose is `NSDKVps2Session.localizationRequestRecords`, one
`Vps2LocalizationRequestRecord` per network request with the `frameId` of the submitted
frame, its status (`pending → completed | failed | frameRejected`) and error.

`LocalizationQueryTracker` mirrors that: after every `update()` it remembers the frame the
SDK just took (pose, timing, and — for the newest three frames only, because ARKit's pixel
buffer pool is small — the image). When a `vpsLocalize` record appears it pairs it with the
frame by `frameId` (falling back to the newest frame fed before the request started), and
when the request completes it waits up to 350 ms for the anchor update that carries the
resulting pose. Each finished query becomes a `VPSImageQuery`; `LocalizationReporter`
JPEG-encodes the frame in portrait, and uploads it to `POST /worlds/{id}/localize/query`
together with the SDK record and the device pose at capture time in the site frame
(`anchor⁻¹ · camera`). Failed and rejected queries are uploaded too (toggle in Settings ›
Image queries) so the dashboard can show what the phone saw when it did not localize. The
web viewer polls `GET /worlds/{id}/localizations` and draws the pose as a camera frustum on
the splat with the query image on its far plane.

### Notes pinned in the web viewer

Notes placed on the scan in the web viewer (`worlds/<id>/notes.json`, contract
`shared/contracts/notes.schema.json`) are read back on the phone through
`GET /worlds/{id}/notes`. `WorldNotesStore` fetches them as soon as the world is
known — loading never waits on localization, so the notes can be read before
reaching the building — and re-ranks them against the pose about ten times a
second. `NoteGeometry.bearings` turns each note into a distance, a signed bearing
(negative left, positive right, flattened onto the horizontal plane so tilting the
phone does not change "left") and a height delta; the store speaks the nearest one
when the wearer comes within 5 m and re-arms it only past 8 m, so standing beside a
note does not repeat it.

Two surfaces show them. **Notes › Open notes** on the front screen lists them
nearest-first with distance and direction, and works with no fix at all. The
camera card additionally draws labels over the live feed (`NoteOverlay`),
projecting each note back through the VPS anchor with `ARCamera.projectPoint`.
The overlay appears **only while the anchor is `tracked`**: per the NSDK docs a
`limited` anchor is a coarse GPS estimate, so pinning labels to the world with one
would place them tens of metres from what they describe. The card's pill says
which of the two you are getting — "On camera" or "List only".

### Voice guide (GPT-Live through the backend)

With **Settings › Voice guide** on and the backend's `VOICE_ACCESS_TOKEN` entered (or seeded from
`LocalConfig.plist` as `VoiceAccessToken`), the front screen shows a call card and, by default,
starts the call together with **Start**. The wearer can ask where they are, what is nearby, or say
"guide me to Bed 1"; the backend's grounded agent resolves the place (graph nodes and web-viewer
notes) and starts guidance, and the phone mirrors the resulting `set_destination` /
`stop_navigation` actions into `LocalizationReporter` so the pose loop and the Navigation card agree.

How it works (`shared/contracts/voice.md`): `VoiceCallController` opens
`wss://<backend>/ws/sessions/{id}/voice` (`VoiceWebSocket`), authenticates with the token, and on
`voice_ready` starts `VoiceAudioIO`: an `AVAudioEngine` input tap converted to 24 kHz mono Int16 and
sent as 100 ms base64 frames, in order, through one sender; returned PCM is scheduled on an
`AVAudioPlayerNode` only a quarter second ahead so an interruption leaves little stale speech. The
session is `.playAndRecord` / `.voiceChat` (Apple echo cancellation; Bluetooth HFP allowed), owned by
`AudioSessionCoordinator` so spoken cues and the call never fight over it. **During a call the phone
speaks no cues itself**: the backend forwards every turn cue, arrival and off-route phrase into the
voice, and `SpeechCoordinator` is muted. Obstacle haptics are unaffected.

Poses now stream to `POST /sessions/{id}/pose` whether or not a destination is set, because the
agent's `set_destination` needs a pose under 15 s old and may start guidance at any moment; a
session is created up front (`POST /sessions`) when the voice call starts before the first VPS fix.
The call survives socket drops (three reconnects with backoff, microphone kept running) and Live
renewals; the typed field on the card sends text through the same path for the simulator.

### Connecting to a world by QR code

The web viewer shows a QR code per world (Live tab, or the phone button in the header)
encoding `wander://connect?v=1&world=<id>&site=<siteId>&backend=<url>&name=<name>`
(contract in `shared/contracts/README.md`). Scan it with **Scan world QR** on the front
screen or in Settings (VisionKit `DataScannerViewController`; a paste field covers the
simulator), or point the iOS Camera at it — the app registers the `wander` URL scheme and
applies the link in `onOpenURL`. Scanning fills in the world id, Niantic Site ID and backend
URL only; the developer token and API key still come from `LocalConfig.plist` or Settings.
The scanner needs the camera, so the front screen offers it while the pipeline is stopped.

Secrets never go in git. Copy `Resources/LocalConfig.example.plist` to
`Resources/LocalConfig.plist` and fill in the backend URL and key, the Niantic
developer token, and the Site ID. Those values seed Settings on first launch and can
be edited on the phone. Without a token and Site ID the front phone falls back to the
placeholder REST loop, which captures and logs frames without sending them.

The backend world must carry the same `nianticSiteId` and an `alignment.frame` of
`niantic-vps` before `/localize` accepts fixes.
