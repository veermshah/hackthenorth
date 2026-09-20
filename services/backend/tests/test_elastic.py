from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from ..app.models import Document
from ..app.integrations.elastic.client import ElasticClient
from ..app.integrations.elastic.mappings import mappings
from ..app.integrations.elastic.search import ElasticSearch
from ..app.integrations.elastic.ingestion import Ingestion, extract_text
from ..app.integrations.elastic.events import EventService, parse_rows


@pytest.fixture
def elastic(settings):
    client = SimpleNamespace(
        inference=SimpleNamespace(inference=AsyncMock(return_value={'text_embedding': [{'embedding': [1, 0, 0]}]})),
        index=AsyncMock(), delete_by_query=AsyncMock(), search=AsyncMock(return_value={'hits': {'hits': [{'_source': {'id': 'real'}, '_score': .9}]}}),
        esql=SimpleNamespace(query=AsyncMock(return_value={'columns': [{'name': 'id'}], 'values': [['event-1']]})),
        indices=SimpleNamespace(exists=AsyncMock(return_value=False), create=AsyncMock()))
    return ElasticClient(settings, client)


@pytest.mark.asyncio
async def test_mappings_and_setup(elastic):
    await elastic.setup()
    assert elastic.client.indices.create.await_count == 3
    assert mappings(3)['building_knowledge']['properties']['embedding']['dims'] == 3
    assert mappings(3)['live_events']['properties']['timestamp']['type'] == 'date'


@pytest.mark.asyncio
async def test_setup_extends_mapping_of_an_existing_index(elastic):
    elastic.client.indices.exists = AsyncMock(return_value=True)
    elastic.client.indices.put_mapping = AsyncMock()
    await elastic.setup()
    assert elastic.client.indices.create.await_count == 0
    assert elastic.client.indices.put_mapping.await_count == 3
    properties = elastic.client.indices.put_mapping.call_args_list[0].kwargs['properties']
    assert 'embedding' in properties or 'category' in properties or 'timestamp' in properties


@pytest.mark.asyncio
async def test_setup_skips_an_index_whose_mapping_cannot_be_extended(elastic):
    from elasticsearch import ApiError
    elastic.client.indices.exists = AsyncMock(return_value=True)
    # One index (e.g. live_events, if event_type was ever created as text) rejects an
    # incompatible field-type change; the others must still get their mapping applied.
    elastic.client.indices.put_mapping = AsyncMock(side_effect=[
        ApiError('cannot change field type', SimpleNamespace(status=400), None), None, None])
    await elastic.setup()
    assert elastic.client.indices.put_mapping.await_count == 3


@pytest.mark.asyncio
async def test_hybrid_filters_rrf_rerank(elastic):
    elastic.settings.elastic_rerank_endpoint = 'jina-rerank'
    result = await ElasticSearch(elastic).search('map_entities', 'site-a', 'bathroom')
    request = elastic.client.search.call_args.kwargs
    rerank = request['retriever']['text_similarity_reranker']
    assert rerank['inference_id'] == 'jina-rerank'
    retrievers = rerank['retriever']['rrf']['retrievers']
    assert retrievers[0]['standard']['query']['bool']['filter'] == [{'term': {'site_id': 'site-a'}}]
    assert retrievers[1]['knn']['filter'] == [{'term': {'site_id': 'site-a'}}]
    assert result == [{'id': 'real', 'score': .9}]
    assert elastic.client.inference.inference.call_args.kwargs['input_type'] == 'search'
    assert 'rescore' not in request


@pytest.mark.asyncio
async def test_proximity_rescore_added_only_when_near_given(elastic):
    await ElasticSearch(elastic).search('map_entities', 'site-a', 'bathroom', near={'x': 1, 'y': 2, 'z': 3})
    rescore = elastic.client.search.call_args.kwargs['rescore']
    params = rescore['query']['rescore_query']['script_score']['script']['params']
    assert params == {'x': 1, 'y': 2, 'z': 3}


@pytest.mark.asyncio
async def test_context_search_filters_and_aggregates(elastic):
    elastic.client.search = AsyncMock(return_value={'hits': {'hits': []}, 'aggregations': {
        'by_category': {'buckets': [{'key': 'obstacle', 'doc_count': 2}]},
        'by_role': {'buckets': [{'key': 'potential_hazard', 'doc_count': 2}]}}})
    result = await ElasticSearch(elastic).context('site-a', 'wet floor', floor=2)
    request = elastic.client.search.call_args.kwargs
    assert request['aggs']['by_category']['terms']['field'] == 'category'
    filters = request['retriever']['rrf']['retrievers'][0]['standard']['query']['bool']['filter']
    assert {'term': {'is_destination': False}} in filters
    assert {'term': {'floor': 2}} in filters
    assert result['counts_by_category'] == {'obstacle': 2}
    assert result['counts_by_role'] == {'potential_hazard': 2}


@pytest.mark.asyncio
async def test_ingestion_and_dimension_validation(elastic):
    doc = Document(site_id='demo_building', id='guide', title='Guide', text='Use East Elevator.')
    ids = await Ingestion(elastic).document(doc)
    assert len(ids) == 1
    source = elastic.client.index.call_args.kwargs['document']
    assert source['text'] == doc.text and source['embedding'] == [1, 0, 0]
    assert elastic.client.inference.inference.call_args.kwargs['input_type'] == 'ingest'
    elastic.settings.elastic_embedding_dims = 4
    with pytest.raises(RuntimeError, match='dimensions'):
        await elastic.embed(['test'], 'search')


@pytest.mark.asyncio
async def test_events_parameterized_and_parsed(elastic):
    events = EventService(elastic)
    rows = await events.recent('site', 'quoted"session', 'obstacle', 5)
    kwargs = elastic.client.esql.query.call_args.kwargs
    assert 'quoted"session' not in kwargs['query']
    assert {'session': 'quoted"session'} in kwargs['params']
    assert {'kind': 'obstacle'} in kwargs['params']
    assert rows == [{'id': 'event-1'}]
    assert parse_rows({'columns': [{'name': 'a'}, {'name': 'b'}], 'values': [[1, 2]]}) == [{'a': 1, 'b': 2}]


@pytest.mark.asyncio
async def test_hazard_density_uses_stats_aggregation(elastic):
    await EventService(elastic).hazard_density('site', hours=48)
    kwargs = elastic.client.esql.query.call_args.kwargs
    assert 'STATS' in kwargs['query']
    assert 'BY nearest_waypoint_id, floor' in kwargs['query']
    assert {'site': 'site'} in kwargs['params']


@pytest.mark.asyncio
async def test_record_merges_location_into_indexed_event():
    written = {}
    elastic = SimpleNamespace(require=lambda: SimpleNamespace(
        index=AsyncMock(side_effect=lambda **kwargs: written.update(kwargs['document']))))
    events = EventService(elastic)
    session = SimpleNamespace(session_id='s1', site_id='site')
    events.record(session, 'obstacle', {'direction': 'front'}, location={'nearest_waypoint_id': 'w1', 'floor': 2})
    await events.close()
    assert written['nearest_waypoint_id'] == 'w1'
    assert written['floor'] == 2


@pytest.mark.asyncio
async def test_context_notes_indexed_as_non_destination(elastic):
    notes = [{'id': 'note-1', 'name': 'Loose cable', 'description': 'Cable across corridor',
              'category': 'obstacle', 'permanence': 'temporary', 'navigation_role': 'potential_hazard',
              'visual_location': 'foreground', 'uncertainty': 'May have been cleared',
              'waypoint_id': 'lobby', 'floor': 2, 'x': 1.0, 'y': 0.0, 'z': 2.0}]
    await Ingestion(elastic).context_notes('site-a', notes)
    document = elastic.client.index.call_args.kwargs['document']
    assert document['is_destination'] is False
    assert document['entity_type'] == 'context_note'
    assert document['category'] == 'obstacle'
    assert document['navigation_role'] == 'potential_hazard'
    assert document['floor'] == 2


def test_text_extraction():
    assert extract_text('guide.md', b'# Elevator') == '# Elevator'
    with pytest.raises(ValueError):
        extract_text('binary.exe', b'bad')


@pytest.mark.asyncio
async def test_openai_embeddings_omit_jina_input_type(elastic):
    elastic.settings.elastic_embedding_provider = 'openai'
    assert await elastic.embed(['text'], 'search') == [[1, 0, 0]]
    assert 'input_type' not in elastic.client.inference.inference.call_args.kwargs
