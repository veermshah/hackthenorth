"""Resolve what a traveller said ("bed one", "the elevator") to routable targets by name.

Standard-library matching over the world's graph nodes and web-viewer notes; no search service is
needed for guidance. The result is a short candidate list with distances: the language model picks
or asks, it never invents an ID.
"""
import re
from difflib import SequenceMatcher

from ..routing.heading import horizontal

NUMBER_WORDS = {'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5', 'six': '6',
                'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10', 'eleven': '11', 'twelve': '12',
                'first': '1', 'second': '2', 'third': '3', 'fourth': '4', 'fifth': '5'}
STOP_WORDS = {'the', 'a', 'an', 'to', 'me', 'guide', 'take', 'go', 'navigate', 'bring', 'lead', 'find', 'where', 'is',
              'please', 'nearest', 'closest', 'my', 'us', 'towards', 'toward'}
NAME_STOP_WORDS = {'the', 'a', 'an'}


def normalise(text):
    """Lower-case words with spoken numbers made literal: "room one oh one" -> ["room", "101"]."""
    words = [NUMBER_WORDS.get(w, w) for w in re.sub(r'[^a-z0-9]+', ' ', (text or '').lower()).split()]
    merged = []
    for word in words:
        spoken_zero = word in ('oh', 'o') and merged and merged[-1].isdigit()
        if merged and merged[-1].isdigit() and (spoken_zero or (word.isdigit() and len(word) == 1)):
            merged[-1] += '0' if spoken_zero else word
        else:
            merged.append(word)
    return merged


def tokens(text, stop=STOP_WORDS):
    return [word for word in normalise(text) if word not in stop]


def score(query_tokens, candidate):
    """0..1 similarity of the spoken words to a target's name, aliases and description."""
    if not query_tokens:
        return 0
    best = 0
    names = [candidate.get('name') or '', candidate.get('id') or ''] + list(candidate.get('aliases') or [])
    for name in names:
        name_tokens = tokens(name, NAME_STOP_WORDS)
        if not name_tokens:
            continue
        if name_tokens == query_tokens:
            return 1
        overlap = len(set(query_tokens) & set(name_tokens))
        subset = overlap / max(len(query_tokens), len(name_tokens))
        # Letter similarity only counts when it is strong, so "entrance" never drifts to "elevator".
        fuzzy = SequenceMatcher(None, ' '.join(query_tokens), ' '.join(name_tokens)).ratio()
        fuzzy = fuzzy if fuzzy >= 0.75 else 0
        # Digits are decisive: "bed 1" must not resolve to "Bed 2" on letters alone.
        digits_q = {w for w in query_tokens if w.isdigit()}
        digits_n = {w for w in name_tokens if w.isdigit()}
        penalty = 0.5 if digits_q and digits_n and digits_q != digits_n else 0
        best = max(best, max(subset, fuzzy) - penalty)
    text_tokens = set(tokens(candidate.get('text') or '', NAME_STOP_WORDS))
    if text_tokens:
        best = max(best, 0.6 * len(set(query_tokens) & text_tokens) / len(query_tokens))
    return round(max(0, best), 3)


def resolve(targets, query, position=None, limit=5, threshold=0.5):
    """Ranked candidates for a spoken destination: [{id, name, kind, position, score, distance_m}]."""
    query_tokens = tokens(query)
    ranked = []
    for target in targets:
        value = score(query_tokens, target)
        if value < threshold:
            continue
        metres = round(horizontal(position, target['position']), 1) if position is not None else None
        ranked.append({'id': target['id'], 'name': target.get('name') or target['id'], 'kind': target.get('source', 'node'),
                       'position': target['position'], 'score': value, 'distance_m': metres})
    ranked.sort(key=lambda row: (-row['score'], row['distance_m'] if row['distance_m'] is not None else 0))
    return ranked[:limit]
