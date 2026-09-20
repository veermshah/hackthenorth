# Current API contract

The primary API now follows `shared/contracts/worlds-api.openapi.yaml` from main.
Read [WORLDS_MIGRATION.md](WORLDS_MIGRATION.md) first: WANDER_API_KEY is required,
worlds/sessions persist on a Modal Volume, and old demo session routes moved under
/legacy. Earlier examples below describe that legacy backend.

---

# Indoor navigation backend

The original backend, navigation-data and shared-contract directories contained only `.gitkeep` placeholders. This implementation adds FastAPI, deterministic routing, in-memory sessions, Elastic retrieval and a Responses API agent. Frontend/iOS files and the shared frontend style guide are untouched.

## Windows setup

Run from `C:\cs\hackthenorth` with Python 3.12+ installed and available as `python`:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r services/backend/requirements.txt
Copy-Item services/backend/.env.example services/backend/.env
# Edit services/backend/.env; never commit it.
python -m uvicorn services.backend.app.main:app --reload
```

If PowerShell activation is disabled, invoke `.venv\Scripts\python.exe` directly. Do not assume `py` is installed. This development environment had no `python` on PATH; the agent used the bundled Python executable to create `.venv`. The commands above are the normal teammate setup.

If `.venv` already exists, first run `.venv\Scripts\python.exe --version` and reuse it. Do not rerun `python -m venv .venv` using a different Python version: that can switch the interpreter while leaving incompatible compiled packages installed. For example, Python 3.11 cannot import a `_pydantic_core.cp312-win_amd64.pyd` built for Python 3.12, even if pip says the package is already satisfied. Stop Uvicorn before repairing an environment because Windows locks its running launcher. Use a fresh environment when changing Python versions. Copy `.env.example` only when `.env` does not already exist, to preserve configured credentials.

Open `http://127.0.0.1:8000/docs` for HTTP API schemas. Navigation and sessions work without external credentials. Use one Uvicorn worker: state is process-local. Reload/restart loses sessions.

## Architecture and file map

| Area | Files / responsibility |
| --- | --- |
| App/API | `app/main.py`, `app/api/{http,navigation_ws,assistant_ws}.py`: factory, lifecycle, validation and transports |
| Contracts | `app/models.py`, `shared/contracts/backend.md`, `shared/contracts/backend.schema.json` |
| Navigation | `app/routing/{graph,astar,navigation}.py`: validated graph, Euclidean A*, accessible-edge filtering, progression and heading instructions; no model imports |
| Sessions | `app/services/sessions.py`: replaceable SessionStore protocol, in-memory implementation, session-specific agent locks, WebSocket subscriptions |
| Agent | `app/services/{agent_context,agent_tools,building_agent}.py`: fresh context, registered execution, bounded tool loop, compact history and provenance |
| OpenAI | `app/integrations/openai/{agent,tools}.py`, `prompts/building_assistant.txt`: official async SDK behind AgentModel, centralized request construction, strict schemas |
| Elastic | `app/integrations/elastic/{client,mappings,ingestion,search,events}.py`: three indices, inference, retrieval and event history |
| Deployment | `deployment/modal_app.py`: image, secrets, ASGI wrapper only |
| Demo/test | `demo_data/`, `scripts/`, `tests/`, `maps/navigation/demo_building.json` |

Pose → nearest waypoint → accessible graph → A* → route progression → instruction. Model actions use the same navigation service as HTTP and WebSockets. Model reasoning cannot supply route geometry. The demo path is `entrance → hall_corner → east_elevator`, 12 metres. Only the ground floor is mapped; the documents describe upper-floor elevator access but the graph does not route upstairs.

## OpenAI and dynamic context

Set `OPENAI_API_KEY` and `OPENAI_MODEL` to an accessible Responses/function-calling model. No model is hardcoded. Calls use the official `AsyncOpenAI.responses.create`, strict registered function schemas and `function_call_output` items. The loop carries every response output item, including reasoning, into subsequent calls. `store=False` and encrypted reasoning support backend-managed state.

The stable behavioral prompt is `app/integrations/openai/prompts/building_assistant.txt`. `AgentContextBuilder.build` injects a separate `<application_context>` developer message on every model iteration, including after tool actions. It includes session, freshness-aware localization, pose, navigation, immediate obstacles and optional operator-supplied localization descriptions. Provider-specific data remains nested under `provider_metadata`. Niantic can plug into this contract later without a SDK import or permanent prompt changes.

Tools: `search_building_knowledge`, `search_places`, `resolve_destination`, `get_current_location`, `get_navigation_state`, `set_destination`, `stop_navigation`, `get_recent_events`, `search_context`, `get_obstacle_hotspots`. Tool arguments are validated locally, unknown names rejected, destinations resolved only against the world's graph nodes and pinned notes (`app/services/destinations.py` matches spoken names such as "room one oh one" without a search service; `note:<id>` destinations route to the point on the nearest walkable edge beside the note, see `compute_route`). For canonical world sessions the application context also carries `destinations` (names + ids, nearest first) and `nearby_notes`. At most eight model iterations and one successful destination change per query. Actions are sequential. The last six compact turns retain actual tool evidence for references such as “there”; live state is rebuilt and takes precedence over history. Sources come from tool evidence, never model-generated citation IDs. Responses include debug traces and all available provenance, not exact per-sentence attribution.

Provider failure yields an explicit unavailable answer; failures after a successful destination change preserve and report the action. Search failure is sent back to the model as an error; an unconfigured Elasticsearch makes `search_places` fall back to the same by-name matching. There is no hidden mock/fallback assistant in the server. Prompt-based grounding and action intent still depend on model behavior; offline scripted tests cannot validate its semantic judgment. Voice wraps the same `query` method through the GPT-Live bridge (`app/services/voice_bridge.py`, `shared/contracts/voice.md`).

## Elasticsearch setup and Jina

Target Elasticsearch 9.x with inference, RRF and text similarity reranking support and an appropriate license/service entitlement. Install/provision the cluster separately. Configure:

```dotenv
ELASTICSEARCH_URL=https://your-cluster
ELASTICSEARCH_API_KEY=your-api-key
ELASTIC_EMBEDDING_ENDPOINT=your-jina-text-embedding-endpoint-id
ELASTIC_RERANK_ENDPOINT=your-jina-rerank-endpoint-id
ELASTIC_EMBEDDING_DIMS=1024
```

The endpoint IDs refer to inference endpoints already provisioned in Elasticsearch, not model names or URLs. Configure Jina through Elastic Inference Service where available, or Elastic's Jina service with its provider credential stored in Elasticsearch. Availability, billing and endpoint models depend on the deployment. For example, current Elastic documentation shows `PUT /_inference/text_embedding/<chosen-id>` using `service: elastic` and `service_settings.model_id` for a supported Jina text model. The backend deliberately does not provision or hardcode a billable model. Set `ELASTIC_EMBEDDING_DIMS` to the exact model output dimensions before seeding; changing dimensions requires a new/recreated index, never an automatic destructive migration.

`building_knowledge`: UTF-8 text, Markdown or extracted PDF text, chunked to 1600 characters with 200-character overlap. Content-addressed IDs preserve provenance; successful reuploads remove obsolete chunks scoped to site/document. Concurrent uploads of the same document are not supported. PDFs need a text layer; no OCR.

`map_entities`: semantic text plus graph-derived IDs, coordinates, aliases, types, tags, floors and waypoint IDs. The graph remains authoritative when retrieved entity IDs are stale. `live_events`: timestamped session/site events and structured payloads.

Queries embed through the configured inference endpoint (`input_type=search`, `ingest` for document indexing). Elasticsearch combines BM25 `multi_match` and filtered dense kNN through native RRF, then optionally wraps it in `text_similarity_reranker` using the configured Jina endpoint. Site filters apply to both branches. Reranking is optional only to accommodate unsupported deployments; configure it for the full sponsor demo. Missing embeddings fail explicitly, never silently downgrade to lexical/vector-only retrieval.

ES|QL history uses parameterized site/session/type/time filters, a bounded 50-event result and structured columns/values parsing. Event indexing is asynchronous so obstacle delivery never waits for Elastic; queue is capped at 256 writes, failures are logged/counted, and events may be lost without retry. Historical search is eventually consistent. No success claim for live Elastic is implied by mocked tests.

## Exact demos and tests

### OpenAI embeddings with Elastic retrieval

`ELASTIC_EMBEDDING_ENDPOINT` and `ELASTIC_RERANK_ENDPOINT` are Elasticsearch inference IDs, not URLs or API keys. In Kibana Dev Tools Console, run `GET /_inference` to inspect existing endpoints and their task types. Otherwise create endpoints there. To use OpenAI embeddings, create:

```json
PUT /_inference/text_embedding/htn-openai-embeddings
{
  "service": "openai",
  "service_settings": {
    "api_key": "YOUR_OPENAI_API_KEY",
    "model_id": "text-embedding-3-small",
    "dimensions": 1024
  }
}
```

For a Jina reranker using a Jina API key, create:

```json
PUT /_inference/rerank/htn-jina-rerank
{
  "service": "jinaai",
  "service_settings": {
    "api_key": "YOUR_JINA_API_KEY",
    "model_id": "jina-reranker-v2-base-multilingual"
  }
}
```

Enter the actual keys only in your private cluster configuration, not committed files or chat. Endpoint creation requires cluster inference privileges and provider access. If your cluster already has a supported Elastic-hosted Jina rerank endpoint, use its existing ID instead of creating one with a separate Jina key.

Then set these in `services/backend/.env`:

```dotenv
ELASTIC_EMBEDDING_ENDPOINT=htn-openai-embeddings
ELASTIC_EMBEDDING_PROVIDER=openai
ELASTIC_EMBEDDING_DIMS=1024
ELASTIC_RERANK_ENDPOINT=htn-jina-rerank
```

The OpenAI provider setting omits Jina's `input_type` argument. BM25, dense search, RRF, reranking and metadata filtering remain in Elasticsearch. The default `jinaai` provider still supports the original Jina embedding setup. When changing embedding models, existing vectors must be regenerated even if dimensions match; use fresh indices or deliberately reindex the entire corpus. No provider/index configuration is changed automatically.

Official setup: [Elastic OpenAI inference](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-inference-put-openai) and [Elastic Jina inference](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-inference-put-jinaai).

### Diagnosing OpenAI failures

The adapter logs HTTP status, provider error code/type and request ID without dumping keys, headers or raw response bodies. A `RateLimitError` by itself is insufficient to distinguish request/token throttling from billing/quota exhaustion; use the printed code and your OpenAI project's billing/limits settings. The application lifespan now closes clients even if the smoke test exits with an error. The location smoke test does not need embedding or reranking endpoints; missing Elastic affects historical event indexing separately.

### Commands

With the virtual environment activated, from the repository root:

```powershell
python -m pytest services/backend/tests -q
python -m services.backend.scripts.simulate_navigation --offline
python -m services.backend.scripts.simulate_assistant --offline
```

The offline navigation demo exercises real FastAPI WebSockets and A*. The offline assistant demo explicitly scripts model responses and retrieval fixtures, then exercises real tool execution, conversation transport and A*. It is an integration fixture, not evidence of live model reasoning.

Against the running local server:

```powershell
python -m services.backend.scripts.simulate_navigation
```

After configuring OpenAI and Elastic inference endpoints:

```powershell
python -m services.backend.scripts.seed_demo_data
python -m services.backend.scripts.test_openai
python -m services.backend.scripts.simulate_assistant
python -m services.backend.scripts.simulate_assistant --interactive
```

The OpenAI smoke test makes a paid request only when explicitly executed, uses the real prompt, requires a location tool call and prints answer/tool traces/source IDs. Default pytest does not invoke it or any paid provider. `--base-url https://...` selects another server for either simulator. The live assistant simulator keeps simulated localization fresh while waiting for the model; it does not simulate walking.

## Modal

```powershell
python -m modal setup
python -m modal secret create htn-backend --from-dotenv services/backend/.env
python -m modal serve services/backend/deployment/modal_app.py
python -m modal deploy services/backend/deployment/modal_app.py
```

`WANDER_WEB_ORIGINS` has to be in that secret (e.g. `https://<app>.vercel.app,http://localhost:3000`).
The web app cannot proxy a splat — its Vercel functions reject request bodies over 4.5 MB — so the
browser uploads straight here with a ticket the web server minted, and that needs this service to
allow its origin. Without it, production uploads fall back to proxying and fail with a 413.

Equivalent activated-venv commands are `modal serve services/backend/deployment/modal_app.py` and `modal deploy services/backend/deployment/modal_app.py`. No deployment was performed by implementation. Deployment wraps the exact same FastAPI app with `@modal.asgi_app`; image includes only backend services and navigation data, excludes `.env`, and obtains credentials from the `htn-backend` secret. One warm container, maximum one container, async concurrency 100. This limits process-local state splitting but does not provide durability or continuity during replacement/redeploy. WebSockets and HTTP share that process. Replace SessionStore and add distributed pub/sub before scaling.

## Boundaries and remaining work

No authentication, production authorization, TTL eviction, production rate limiting, durable storage, provider retries for historical events, multi-floor geometry, off-route replanning, obstacle avoidance or live voice are provided. Use a controlled hackathon environment. A graph route is not a safety guarantee, and null sensor data does not mean clear. Clients must expire instructions on connectivity/localization loss. Nearest-place distances cover retrieved candidates, not a guarantee of globally nearest facilities.

Teammates should implement the localization/heading/timestamp contract, navigation WS messages, destination selection, immediate obstacle observations and assistant text transport described in `shared/contracts/backend.md`. Graph coordinates must be aligned by the localization owner. Do not derive navigation coordinates from the LLM.

## Official references checked for implementation

- [OpenAI Responses function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Elastic reciprocal rank fusion](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)
- [Elastic Jina models and inference](https://www.elastic.co/docs/explore-analyze/machine-learning/nlp/ml-nlp-jina)
- [Elastic inference API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-inference-inference)
- [ES|QL REST parameters](https://www.elastic.co/docs/reference/query-languages/esql/esql-rest)
- [Modal ASGI and WebSockets](https://modal.com/docs/guide/webhooks)
# New annotation and Live voice workflows

See [ANNOTATION_AND_VOICE.md](ANNOTATION_AND_VOICE.md) for the semantic annotation
CLI, review/publication workflow, Modal batch and backend deployment commands,
and experimental Live audio bridge. Client contracts are in
`shared/contracts/semantic-annotations.md` and `shared/contracts/voice.md`.
