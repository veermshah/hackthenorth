import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from ..app.services.agent_tools import AgentTools
from ..app.services.building_agent import BuildingAgentService
from ..app.services.agent_context import AgentContextBuilder
from ..app.integrations.openai.agent import AgentModel, OpenAIAgentModel, SYSTEM_PROMPT
from ..app.integrations.openai.tools import TOOLS
from ..scripts.fixtures import Output, ScriptedModel, FixtureSearch, FixtureEvents


def agent_for(navigation, steps):
    model = ScriptedModel(steps)
    tools = AgentTools(navigation, FixtureSearch(), FixtureEvents())
    return BuildingAgentService(navigation.store, model, tools), model


class DeltaModel(AgentModel):
    """Test double for a model that streams real token deltas, unlike ScriptedModel
    (which only exercises AgentModel.stream()'s no-delta default)."""
    def __init__(self, chunks):
        self.chunks = chunks

    async def respond(self, inputs):
        return SimpleNamespace(output=[], output_text=''.join(self.chunks))

    async def stream(self, inputs):
        for chunk in self.chunks:
            yield {'type': 'delta', 'text': chunk}
        yield {'type': 'response', 'response': await self.respond(inputs)}


class ToolThenTextModel(AgentModel):
    """Regression test double: a real streamed function_call item carries a client-side
    `parsed_arguments` field (see OpenAIAgentModel.stream()'s docstring-adjacent comment in
    query_stream) that the API rejects if resubmitted as input on the follow-up turn."""
    def __init__(self):
        self.requests = []

    async def respond(self, inputs):
        raise NotImplementedError

    async def stream(self, inputs):
        self.requests.append(inputs)
        if len(self.requests) == 1:
            call = Output(type='function_call', name='get_current_location', call_id='call-1',
                         arguments='{}', parsed_arguments={})
            yield {'type': 'response', 'response': SimpleNamespace(output=[call], output_text='')}
        else:
            yield {'type': 'delta', 'text': 'Done.'}
            yield {'type': 'response', 'response': SimpleNamespace(output=[], output_text='Done.')}


@pytest.mark.asyncio
async def test_location_not_rag(navigation, pose):
    session = navigation.create('demo_building')
    navigation.update_pose(session, pose)
    agent, model = agent_for(navigation, [('get_current_location', {}), 'You are near the Entrance.'])
    result = await agent.query(session.session_id, 'Where am I?')
    assert [call['name'] for call in result['tool_calls']] == ['get_current_location']
    assert result['tool_calls'][0]['result']['data']['nearest_waypoint'] == 'entrance'
    assert 'application_context' in model.requests[0][0]['content']
    assert 'pose' in model.requests[1][0]['content']


@pytest.mark.asyncio
async def test_ui_context_included_only_when_given(navigation):
    session = navigation.create('demo_building')
    agent, model = agent_for(navigation, ['Sure.'])
    await agent.query(session.session_id, 'What is this?', ui_context='Selected note: "Broken handrail" (Stairwell B).')
    inputs = model.requests[0]
    assert any('ui_context' in item.get('content', '') and 'Broken handrail' in item.get('content', '')
               for item in inputs if isinstance(item, dict))

    agent2, model2 = agent_for(navigation, ['Sure.'])
    await agent2.query(session.session_id, 'What is this?')
    assert not any('ui_context' in item.get('content', '') for item in model2.requests[0] if isinstance(item, dict))


@pytest.mark.asyncio
async def test_query_stream_forwards_deltas_and_ends_with_a_final_event_matching_query(navigation):
    session = navigation.create('demo_building')
    tools = AgentTools(navigation, FixtureSearch(), FixtureEvents())
    agent = BuildingAgentService(navigation.store, DeltaModel(['Hello', ' there', '.']), tools)
    events = [event async for event in agent.query_stream(session.session_id, 'Hi')]
    assert [e for e in events if e['type'] == 'delta'] == [
        {'type': 'delta', 'text': 'Hello'}, {'type': 'delta', 'text': ' there'}, {'type': 'delta', 'text': '.'}]
    assert events[-1] == {'type': 'final', 'payload': {'text': 'Hello there.', 'sources': [], 'actions': [], 'tool_calls': []}}
    # Same session-history side effect as the non-streaming query().
    assert session.history[-2] == {'role': 'assistant', 'content': 'Hello there.'}


@pytest.mark.asyncio
async def test_query_stream_strips_parsed_arguments_before_the_next_turn(navigation, pose):
    session = navigation.create('demo_building')
    navigation.update_pose(session, pose)
    tools = AgentTools(navigation, FixtureSearch(), FixtureEvents())
    model = ToolThenTextModel()
    agent = BuildingAgentService(navigation.store, model, tools)
    result = [event async for event in agent.query_stream(session.session_id, 'Where am I?')][-1]['payload']
    assert result['text'] == 'Done.'
    assert len(model.requests) == 2
    second_call_items = [item for item in model.requests[1] if isinstance(item, dict) and item.get('type') == 'function_call']
    assert second_call_items and 'parsed_arguments' not in second_call_items[0]


@pytest.mark.asyncio
async def test_building_sources_and_conversation_action(navigation, pose):
    session = navigation.create('demo_building')
    navigation.update_pose(session, pose)
    agent, model = agent_for(navigation, [
        ('search_building_knowledge', {'query': 'upstairs without stairs'}),
        ('search_places', {'query': 'elevator'}), 'Use the East Elevator.',
        ('set_destination', {'destination_id': 'east_elevator', 'accessible_only': True}),
        'Navigating to the East Elevator.'])
    first = await agent.query(session.session_id, 'How can I go upstairs without stairs?')
    assert {'type': 'building_knowledge', 'id': 'accessibility-guide:fixture'} in first['sources']
    second = await agent.query(session.session_id, 'Take me there.')
    assert session.route == ['entrance', 'hall_corner', 'east_elevator']
    assert second['actions'][0]['destination_id'] == 'east_elevator'
    assert 'East Elevator' in json.dumps(model.requests[3])


@pytest.mark.asyncio
async def test_nearest_place_uses_live_pose(navigation, pose):
    session = navigation.create('demo_building')
    navigation.update_pose(session, pose)
    agent, _ = agent_for(navigation, [('get_current_location', {}),
        ('search_places', {'query': 'bathroom'}), 'Here is the mapped candidate.'])
    agent.tools.search.search = AsyncMock(return_value=[{'id': 'restroom'}, {'id': 'invented'}])
    result = await agent.query(session.session_id, 'Nearest bathroom?')
    places = result['tool_calls'][1]['result']['data']
    assert len(places) == 1 and places[0]['id'] == 'restroom'
    assert places[0]['route_distance_m'] == 12


@pytest.mark.asyncio
async def test_invalid_tool_destination_and_arguments(navigation, pose):
    session = navigation.create('demo_building')
    navigation.update_pose(session, pose)
    agent, _ = agent_for(navigation, [
        ('set_destination', {'destination_id': 'imaginary', 'accessible_only': True}),
        ('execute_code', {'code': 'bad'}),
        ('get_current_location', {'session_id': 'other'}), 'I could not do that.'])
    result = await agent.query(session.session_id, 'Go somewhere')
    assert all('error' in call['result'] for call in result['tool_calls'])
    assert not result['actions'] and not result['sources'] and not session.route


@pytest.mark.asyncio
async def test_unknown_localization_and_live_context_override(navigation, pose):
    session = navigation.create('demo_building')
    session.history = [{'role': 'assistant', 'content': 'Previously at the elevator.'}]
    agent, model = agent_for(navigation, [('get_current_location', {}), 'I do not have your current location.'])
    result = await agent.query(session.session_id, 'Where am I now?')
    data = result['tool_calls'][0]['result']['data']
    assert data['nearest_waypoint'] is None and not data['localization']['localized']
    context = json.loads(model.requests[0][1]['content'].split('\n')[1])
    assert context['pose'] is None
    assert 'Prefer current live state' in SYSTEM_PROMPT


@pytest.mark.asyncio
async def test_future_provider_context(navigation, pose):
    session = navigation.create('demo_building')
    pose.localization.provider = 'future_provider'
    pose.localization.provider_metadata = {'anchor': 'A'}
    navigation.update_pose(session, pose)
    context = await AgentContextBuilder(navigation.store, {'alignment': 'operator-supplied description'}).build(session.session_id)
    assert context.localization['provider_metadata'] == {'anchor': 'A'}
    assert context.localization_context['alignment'] == 'operator-supplied description'


@pytest.mark.asyncio
async def test_openai_request_uses_real_sdk_shape(settings):
    client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock(return_value='response')))
    settings.openai_model = 'configured-model'
    model = OpenAIAgentModel(settings, client=client)
    assert await model.respond([{'role': 'user', 'content': 'hello'}]) == 'response'
    kwargs = client.responses.create.call_args.kwargs
    assert kwargs['model'] == 'configured-model' and kwargs['instructions'] == SYSTEM_PROMPT
    assert kwargs['store'] is False and kwargs['parallel_tool_calls'] is False
    for tool in TOOLS:
        assert tool['strict'] and tool['parameters']['additionalProperties'] is False


@pytest.mark.asyncio
async def test_tool_limit_and_provider_failure_preserve_action(navigation, pose):
    session = navigation.create('demo_building')
    navigation.update_pose(session, pose)
    agent, _ = agent_for(navigation, [('set_destination', {'destination_id': 'east_elevator', 'accessible_only': True})])
    result = await agent.query(session.session_id, 'Take me to the elevator')
    assert result['actions'] and 'already set' in result['text']
    assert session.destination_id == 'east_elevator'


@pytest.mark.asyncio
async def test_unknown_or_missing_retrieval_is_not_fabricated(navigation):
    session = navigation.create('demo_building')
    agent, _ = agent_for(navigation, [('search_building_knowledge', {'query': 'history'}),
                                     'I do not have enough information.'])
    agent.tools.search.search = AsyncMock(side_effect=RuntimeError('provider secret must not leak'))
    result = await agent.query(session.session_id, 'What is this building used for?')
    assert result['sources'] == []
    assert result['tool_calls'][0]['result'] == {'error': 'Tool unavailable; do not invent a result.'}


@pytest.mark.asyncio
async def test_tool_loop_is_bounded(navigation):
    session = navigation.create('demo_building')
    agent, model = agent_for(navigation, [('get_current_location', {})] * 12)
    result = await agent.query(session.session_id, 'Where am I?')
    assert len(model.requests) == 8
    assert 'tool limit' in result['text']


@pytest.mark.asyncio
async def test_source_history_survives_followup_without_tool(navigation):
    session = navigation.create('demo_building')
    agent, _ = agent_for(navigation, [('search_building_knowledge', {'query': 'elevator'}),
        'Use the East Elevator.', 'Yes, the East Elevator.'])
    first = await agent.query(session.session_id, 'How do I go upstairs?')
    second = await agent.query(session.session_id, 'The east one?')
    assert first['sources'] == second['sources'] and second['sources']


@pytest.mark.asyncio
async def test_real_sdk_serialization_and_reasoning_tool_roundtrip(navigation, settings):
    import httpx
    from openai import AsyncOpenAI
    requests = []

    def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            output = [{'type': 'reasoning', 'id': 'rs_1', 'summary': [], 'encrypted_content': 'fixture'},
                      {'type': 'function_call', 'id': 'fc_1', 'call_id': 'call_1',
                       'name': 'get_current_location', 'arguments': '{}', 'status': 'completed'}]
        else:
            output = [{'type': 'message', 'id': 'msg_1', 'role': 'assistant', 'status': 'completed',
                       'content': [{'type': 'output_text', 'text': 'Your location is unavailable.', 'annotations': []}]}]
        return httpx.Response(200, json={'id': 'resp_fixture', 'object': 'response', 'created_at': 1,
            'status': 'completed', 'model': 'fixture-model', 'output': output})

    client = AsyncOpenAI(api_key='test-only', http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    settings.openai_model = 'fixture-model'
    model = OpenAIAgentModel(settings, client)
    agent = BuildingAgentService(navigation.store, model, AgentTools(navigation, FixtureSearch(), FixtureEvents()))
    session = navigation.create('demo_building')
    try:
        result = await agent.query(session.session_id, 'Where am I?')
        assert result['text'] == 'Your location is unavailable.'
        followup = requests[1]['input']
        assert any(item.get('encrypted_content') == 'fixture' for item in followup)
        tool_output = next(item for item in followup if item.get('type') == 'function_call_output')
        assert tool_output['call_id'] == 'call_1'
        assert json.loads(tool_output['output'])['data']['nearest_waypoint'] is None
    finally:
        await model.close()


@pytest.mark.asyncio
async def test_openai_error_logs_code_without_raw_body(settings, caplog):
    import httpx
    from openai import RateLimitError
    response = httpx.Response(429, request=httpx.Request('POST', 'https://api.openai.com/v1/responses'),
                             headers={'x-request-id': 'req_fixture'})
    error = RateLimitError('private raw message', response=response,
                           body={'code': 'insufficient_quota', 'type': 'insufficient_quota'})
    client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock(side_effect=error)))
    settings.openai_model = 'test-model'
    with pytest.raises(RateLimitError):
        await OpenAIAgentModel(settings, client).respond([])
    assert 'insufficient_quota' in caplog.text and 'req_fixture' in caplog.text
    assert 'private raw message' not in caplog.text
