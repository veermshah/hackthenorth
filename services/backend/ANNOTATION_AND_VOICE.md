# Main contract update

Read [WORLDS_MIGRATION.md](WORLDS_MIGRATION.md) first. It supersedes the older
single-graph deployment and unauthenticated examples below. Every request now
requires WANDER_API_KEY; canonical sessions use worldId/deviceId and persistent
world manifests. The voice smoke test now uses canonical world sessions.

---

# Annotation, voice and Modal runbook

## What is implemented

Offline image/video annotation with OpenAI structured output, cached per-image
results, evidence hashes, explicit review, graph export, optional Elastic indexing,
and a Modal batch worker. No SAM installation or automatic map placement yet.
The Live voice bridge delegates to the existing Responses assistant and tools.
The app team still needs microphone capture/playback; see shared/contracts/voice.md.

## Local annotation

Run from the repository root in the activated virtual environment. Configure
OPENAI_API_KEY and ANNOTATION_MODEL=gpt-5-mini in services/backend/.env. Using
ANNOTATION_MODEL=gpt-6-astra is supported as an independent choice from OPENAI_MODEL.
Annotation and indexing invoke paid APIs. Defaults cap extraction at 120 frames;
start with 10-20 frames to evaluate your actual footage.

Install FFmpeg and ensure `ffmpeg -version` works for video extraction. Existing
JPEG/PNG folders do not need FFmpeg. Use perspective imagery; convert 360 footage
to perspective views first. Original capture quality determines sign readability.

```powershell
python -m services.backend.scripts.annotate_scan extract --video walkthrough.mp4 --output artifacts/frames --limit 20
python -m services.backend.scripts.annotate_scan annotate --frames artifacts/frames --output artifacts/candidates.json --site demo_building --revision scan-v1 --floor 0
python -m services.backend.scripts.annotate_scan prepare-review --batch artifacts/candidates.json --graph maps/navigation/demo_building.json --output artifacts/review.json
```

Review candidates.json beside its source images. Edit review.json: fill reviewer
and timestamp fields for each row, approve only confirmed features, and assign
existing approach waypoints. Rejections are the default. Use corrected for an
entire corrected Finding. Mark repeat views duplicate and reference the retained
approved candidate. Do not invent accessibility or a doorway from an exit arrow.

```powershell
python -m services.backend.scripts.annotate_scan publish --batch artifacts/candidates.json --reviews artifacts/review.json --graph maps/navigation/demo_building.json --revision scan-v1 --output maps/navigation/demo_annotated.json --index
```

Set GRAPH_PATH=maps/navigation/demo_annotated.json and restart Uvicorn from the
repository root. The exported graph retains existing destinations/routes and adds
approved annotations. This is an operator-controlled publication, not a live map
edit. Keep the batch/review/media together; artifacts/ is gitignored. The graph
contains evidence filenames/reviewer metadata, so inspect before committing it.

## Run the annotation job on Modal

The CPU worker runs frame extraction and calls OpenAI; there is no benefit from a
GPU until a local perception model is integrated. FFmpeg is installed in its image.

```powershell
python -m modal setup
python -m modal secret create htn-backend --from-dotenv services/backend/.env
python -m modal run -m services.backend.deployment.modal_annotations --video walkthrough.mp4 --site demo_building --revision scan-v1 --floor 0 --limit 20 --output artifacts/candidates.json
```

If htn-backend exists, update it deliberately in the Modal dashboard or use the
secret command with --force after reviewing the local configuration. Do not put
literal API keys on the command line. OpenAI/Elastic credits and Modal usage are
separate. Secret fields are supplied at runtime, not baked into images.

The worker prints a job ID. Original media, frames and cache persist in the
htn-annotations Volume. Download evidence before review:

```powershell
python -m modal volume get htn-annotations /JOB_ID/frames artifacts/frames
```

The local entrypoint waits for the result and saves candidates.json. To make the
worker callable by another backend, deploy its function separately:

```powershell
python -m modal deploy -m services.backend.deployment.modal_annotations
```

That deployment is a Modal Function, not an unauthenticated upload web endpoint.
Future API orchestration can upload media into the Volume and spawn a job. Worker
results do not automatically change the active navigation map.

## Deploy the navigation / voice backend

Ensure your published graph is under maps/navigation before deploying. Configure
the Modal secret GRAPH_PATH with a Linux path, for example
/workspace/maps/navigation/demo_annotated.json (never C:\\...). The deployment
includes maps/navigation and excludes .env files from the image.

```powershell
python -m modal deploy -m services.backend.deployment.modal_app
```

Use the returned HTTPS URL as the client backend base URL, and WSS for sockets.
The existing deployment deliberately uses one container because navigation
sessions are in memory. Restarts/redeploys lose sessions. Annotation artifacts
persist separately in their Volume. Do not scale the live app across containers
until shared session storage and cross-worker broadcasts exist.

This remains a demo backend: existing HTTP/navigation routes do not enforce
per-user authentication. Use controlled access for testing; production deployment
needs authenticated session ownership and protected administrative ingestion.

## Voice setup and paid smoke test

In local .env (or the Modal secret):

```dotenv
OPENAI_MODEL=gpt-6-astra
OPENAI_LIVE_MODEL=gpt-live-1
VOICE_ENABLED=true
VOICE_ACCESS_TOKEN=<your-own-random-demo-token>
```

Start the backend normally. Configure the client with the separate demo token,
never OPENAI_API_KEY. The token is checked before opening the paid upstream socket.
Keep VOICE_ENABLED=false until you want to test the experimental Live path.

The quickest paid check needs no recording: typed text goes through the same delegation
path and the reply comes back as speech.

```powershell
python -m services.backend.scripts.test_voice --say "where am I" --say "guide me to room 101" --log artifacts/voice-events.jsonl
```

For a recorded-audio smoke test, convert a short recording to mono 24 kHz PCM WAV:

```powershell
ffmpeg -i question.m4a -ar 24000 -ac 1 -c:a pcm_s16le artifacts/question.wav
python -m services.backend.scripts.test_voice --input artifacts/question.wav
```

The script creates a new unlocalized session (or attaches to `--session <id>`, e.g. the phone's),
streams silence plus the recording like a microphone, prints every event with timing, and saves
artifacts/voice-reply.wav. Ask a location question first; unknown localization is expected without
poses. Set `VOICE_TRACE=true` on the backend to log each upstream Live event with its timeline fields;
that log answers the Phase 0 question in docs/VOICE_AGENT_PLAN.md (where transcript fragments land
relative to `session.delegation.created`). Use --base-url with the deployed HTTPS URL to test Modal.
Live/model access is account-dependent.

Read shared/contracts/voice.md for message formats and limitations.
