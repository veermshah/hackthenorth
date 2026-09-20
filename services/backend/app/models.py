from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class Point(Model):
    x: float
    y: float
    z: float


class Localization(Model):
    provider: str = 'unknown'
    map_id: str | None = None
    coordinate_frame: str = 'site'
    confidence: float | None = Field(default=None, ge=0, le=1)
    tracking_status: str | None = None
    provider_metadata: dict[str, Any] = Field(default_factory=dict)


class Pose(Point):
    heading: float = Field(ge=0, lt=360)
    localized: bool
    timestamp: float = Field(ge=0)
    localization: Localization = Field(default_factory=Localization)
    # Optional orientation beyond heading, supplied by a future 6DoF client.
    pitch: float | None = None
    roll: float | None = None


class Waypoint(Point):
    id: str


class Edge(Model):
    source: str
    target: str
    accessible: bool = True
    bidirectional: bool = True


class AnnotationEvidence(Model):
    map_revision: str
    frame: str
    frame_sha256: str
    verified_by: str
    verified_at: str
    notes: str
    category: str | None = None
    permanence: Literal['fixed', 'movable', 'temporary', 'unknown'] | None = None
    navigation_role: Literal['destination', 'landmark', 'context', 'potential_hazard'] | None = None
    visual_location: str | None = None
    uncertainty: str | None = None


class Destination(Model):
    id: str
    name: str
    entity_type: str
    waypoint_id: str
    description: str = ''
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    floor: int = 0
    annotation: AnnotationEvidence | None = None


class DestinationRequest(Model):
    destination_id: str
    accessible_only: bool = True


class SessionRequest(Model):
    site_id: str = 'demo_building'


class Obstacle(Model):
    direction: Literal['front', 'left', 'right', 'back']
    distance_m: float | None = Field(default=None, ge=0)
    description: str = Field(max_length=1000)
    timestamp: float = Field(ge=0)


class Query(Model):
    session_id: str
    text: str = Field(min_length=1, max_length=8000)
    # What the dashboard UI currently shows (selected note/waypoint, active tab);
    # a hint for pronoun resolution, never live sensor/navigation truth.
    ui_context: str | None = Field(default=None, max_length=2000)


class Document(Model):
    site_id: str
    id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    text: str = Field(min_length=1, max_length=200000)
