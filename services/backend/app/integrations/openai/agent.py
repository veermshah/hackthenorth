from abc import ABC, abstractmethod
from pathlib import Path
import logging
from openai import AsyncOpenAI, APIStatusError
from .tools import TOOLS
from ..elastic.client import IntegrationUnavailable

SYSTEM_PROMPT = (Path(__file__).parent / 'prompts/building_assistant.txt').read_text(encoding='utf-8')
logger = logging.getLogger(__name__)


class AgentModel(ABC):
    @abstractmethod
    async def respond(self, inputs: list): ...

    async def stream(self, inputs: list):
        """Default: no incremental deltas, just the final response as one event.
        Subclasses that can stream tokens (OpenAIAgentModel) override this; callers
        (BuildingAgentService.query_stream) work the same either way."""
        yield {'type': 'response', 'response': await self.respond(inputs)}

    async def close(self):
        pass


class OpenAIAgentModel(AgentModel):
    def __init__(self, settings, client=None):
        self.model = settings.openai_model
        self.client = client or (AsyncOpenAI(api_key=settings.openai_api_key, timeout=30, max_retries=1)
                                 if settings.openai_api_key else None)
        # Spoken turns wait on this call; low effort keeps the voice path responsive.
        effort = getattr(settings, 'openai_reasoning_effort', '')
        self.options = {'reasoning': {'effort': effort}} if effort else {}

    async def respond(self, inputs):
        if not self.client or not self.model:
            raise IntegrationUnavailable('OPENAI_API_KEY and OPENAI_MODEL must be configured')
        try:
            return await self.client.responses.create(model=self.model, instructions=SYSTEM_PROMPT,
                input=inputs, tools=TOOLS, parallel_tool_calls=False, store=False,
                include=['reasoning.encrypted_content'], **self.options)
        except APIStatusError as error:
            # Log diagnostic identifiers, never the API key, headers or raw error body.
            logger.error('OpenAI request failed: status=%s code=%s type=%s request_id=%s',
                         error.status_code, error.code, error.type, error.request_id)
            raise

    async def stream(self, inputs):
        if not self.client or not self.model:
            raise IntegrationUnavailable('OPENAI_API_KEY and OPENAI_MODEL must be configured')
        try:
            async with self.client.responses.stream(model=self.model, instructions=SYSTEM_PROMPT,
                    input=inputs, tools=TOOLS, parallel_tool_calls=False, store=False,
                    include=['reasoning.encrypted_content'], **self.options) as stream:
                async for event in stream:
                    if event.type == 'response.output_text.delta':
                        yield {'type': 'delta', 'text': event.delta}
                response = await stream.get_final_response()
        except APIStatusError as error:
            logger.error('OpenAI request failed: status=%s code=%s type=%s request_id=%s',
                         error.status_code, error.code, error.type, error.request_id)
            raise
        yield {'type': 'response', 'response': response}

    async def close(self):
        if self.client:
            await self.client.close()
