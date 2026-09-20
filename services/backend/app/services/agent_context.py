from typing import Any
from pydantic import BaseModel


class AgentContext(BaseModel):
    session: dict[str, str]
    localization: dict[str, Any]
    pose: dict | None
    navigation: dict
    obstacle_state: dict
    localization_context: dict
    # Names the traveller may say, nearest first when localized: graph nodes and pinned notes
    # (kind "note", ids "note:<id>"). Only these ids are valid for set_destination.
    destinations: list[dict[str, Any]] | None = None
    # Pinned notes within a few metres of the live pose, with relative bearings.
    nearby_notes: list[dict[str, Any]] | None = None


class AgentContextBuilder:
    def __init__(self, store, localization_context=None, catalogue=None):
        self.store = store
        # Operator-supplied descriptions of map alignment, anchors, provider semantics.
        # Provider metadata received from clients stays nested in localization.
        self.localization_context = localization_context or {}
        # Optional session_id -> {destinations, nearby_notes} from the persisted world (None for legacy sessions).
        self.catalogue = catalogue

    async def build(self, session_id: str) -> AgentContext:
        state = self.store.get(session_id).snapshot()
        extra = (self.catalogue(session_id) if self.catalogue else None) or {}
        return AgentContext(session={'session_id': state['session_id'], 'site_id': state['site_id']},
            localization=state['localization'], pose=state['pose'], navigation=state['navigation'],
            obstacle_state=state['obstacle_state'], localization_context=self.localization_context,
            destinations=extra.get('destinations'), nearby_notes=extra.get('nearby_notes'))
