"""Annotated obstacles and potential hazards with map positions.

Published annotations live in Elasticsearch (`map_entities`, keyed by world id)
and, as a fallback, in the world's context-notes and annotations files on the
volume. The phone's map sensor treats each as a static obstacle at (x, y, z).
"""
HAZARD_CATEGORIES = {'obstacle', 'surface_change'}
FIELDS = ('id', 'name', 'category', 'navigation_role', 'permanence', 'description', 'x', 'y', 'z')


def is_hazard(record: dict) -> bool:
    if not all(isinstance(record.get(axis), (int, float)) for axis in 'xyz'):
        return False
    return record.get('navigation_role') == 'potential_hazard' or record.get('category') in HAZARD_CATEGORIES


def trim(record: dict) -> dict:
    return {key: record.get(key) for key in FIELDS}


def hazards_from_files(store, world_id: str) -> list:
    rows = []
    for filename in ('context-notes.json', 'annotations.json'):
        path = store.path('worlds', world_id, filename)
        if not path.exists():
            continue
        for record in store.read('worlds', world_id, filename):
            if is_hazard(record):
                rows.append(trim(record))
    return rows


async def hazards_from_elastic(elastic, world_id: str) -> list:
    query = {'bool': {'filter': [
        {'term': {'site_id': world_id}},
        {'bool': {'should': [{'term': {'navigation_role': 'potential_hazard'}},
                             {'terms': {'category': sorted(HAZARD_CATEGORIES)}}],
                  'minimum_should_match': 1}}]}}
    result = await elastic.require().search(index='map_entities', size=200, query=query,
                                            source_includes=list(FIELDS))
    return [trim(hit['_source']) for hit in result['hits']['hits'] if is_hazard(hit['_source'])]
