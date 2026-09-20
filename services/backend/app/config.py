from pathlib import Path
from typing import Literal
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / 'services/backend/.env', extra='ignore')
    openai_api_key: str = ''
    openai_model: str = ''
    # Reasoning effort for the delegated agent; blank to omit the parameter for models without reasoning.
    openai_reasoning_effort: str = 'low'
    annotation_model: str = 'gpt-5-mini'
    openai_live_model: str = 'gpt-live-1'
    voice_access_token: str = ''
    voice_enabled: bool = False
    voice_name: str = 'marin'
    # Seconds between silent situational-context updates to the Live model (also sent on change).
    voice_context_interval_s: float = 5
    # Wall-clock seconds to wait for late transcript fragments after a delegation before querying the agent.
    voice_transcript_grace_s: float = 0.7
    # Our own per-call cost cap; the Live session's own expiry is read from session.started.
    voice_max_minutes: int = 60
    # Log every Live server event with its timeline fields (transcript text included) for protocol checks.
    voice_trace: bool = False
    wander_api_key: str = ''
    wander_backend_url: str = ''
    wander_data_root: Path = ROOT / 'maps/assets'
    asset_max_bytes: int = 2 * 1024 * 1024 * 1024
    # Web origins allowed to upload assets directly with a ticket, comma separated
    # (e.g. https://wander.vercel.app,http://localhost:3000). Empty disables direct upload.
    wander_web_origins: str = ''
    elasticsearch_url: str = ''
    elasticsearch_api_key: str = ''
    elastic_embedding_endpoint: str = ''
    elastic_rerank_endpoint: str = ''
    elastic_embedding_dims: int = 1024
    elastic_embedding_provider: Literal['jinaai', 'openai'] = 'jinaai'
    graph_path: Path = ROOT / 'maps/navigation/demo_building.json'
