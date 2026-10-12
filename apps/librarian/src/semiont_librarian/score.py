"""The score of one candidate of a reference search: its terms, its reason, and the one way a score is rounded.

A reference search answers what a reference could refer to
(`docs/protocol/LIBRARIAN.md` § The score, § The model's score). Each
candidate has a score, which is a sum of terms, and a reason, which says in
words what the sum was made of. Both are worked out here, from the candidate,
what the search was made with, and a moment it is handed: nothing here reads
a store, a model or a clock. `specs/src/librarian/score-cases.json` states
each term by a search that shows it.

The terms are added in the order the page states them, one at a time: a sum
of fractions added in another order can end one unit apart, and a score is
compared with the table's to the last digit.
"""

import math
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, Literal, final

from semiont.resources import resource_entity_types
from semiont.types import ResourceDescriptor

from semiont_librarian.views import GraphViews

__all__ = ["Score", "Source", "rounded", "score_of", "with_model_score"]

type Source = Literal["name", "entityType", "neighborhood", "semantic"]
"""What found a candidate: the graph's listing by name or by entity type, the gathered graph's connections, or the vector index."""

_EPOCH: Final = datetime(1970, 1, 1, tzinfo=UTC)
_MILLISECOND: Final = timedelta(milliseconds=1)
_MILLISECONDS_IN_A_DAY: Final = 86_400_000


@final
@dataclass(frozen=True, slots=True)
class Score:
    """A candidate's score, and the reason given for it."""

    points: float
    """The sum of the terms, rounded to two decimals."""
    reason: str
    """What the sum was made of, in the page's order, joined by `; `. `candidate` where it was made of nothing that is said."""


def rounded(score: float) -> float:
    """`score` to two decimals, a half going up.

    Python's own `round` sends a half to the even digit beside it, and the
    table's scores are those of a Librarian that sends a half up: 0.125 is
    0.13 there, and 0.12 by `round`. So a score is rounded here, by the
    floor of a hundred times it and a half more, and nowhere else.

    A score that is no finite number is answered as it is.
    """
    if not math.isfinite(score):
        return score
    return math.floor(score * 100 + 0.5) / 100


def _rarity(frequency: int) -> float:
    """One over the base-2 logarithm of one more than a type's frequency: the less often a type is seen, the more it weighs.

    A frequency of 0 has the logarithm 0, and weighs without bound.
    """
    seen = frequency + 1
    if seen > 1:
        return 1 / math.log2(seen)
    if seen == 1:
        return math.inf
    return -0.0 if seen == 0 else math.nan


def _milliseconds(moment: datetime) -> int:
    """A moment as whole milliseconds since 1970."""
    return (moment - _EPOCH) // _MILLISECOND


def _recency(date_created: str, moment: datetime) -> float:
    """5 for a resource made at `moment`, less by a thirtieth of that for each day of its age, and nothing from thirty days on.

    A date that states no offset is read as UTC. One that cannot be read as
    a date gives no number.
    """
    try:
        made = datetime.fromisoformat(date_created)
    except ValueError:
        return math.nan
    if made.tzinfo is None:
        made = made.replace(tzinfo=UTC)
    age_in_days = (_milliseconds(moment) - _milliseconds(made)) / _MILLISECONDS_IN_A_DAY
    gained = 5 * (1 - age_in_days / 30)
    return gained if gained > 0 else 0.0


def score_of(
    candidate: ResourceDescriptor,
    *,
    term: str,
    entity_types: Sequence[str],
    entity_type_frequencies: Mapping[str, int],
    views: GraphViews,
    sources: Collection[Source],
    vector_score: float | None,
    moment: datetime,
) -> Score:
    """The score of `candidate`, and its reason, before any model is asked.

    `term` is the search term. `entity_types` are the context's, and
    `entity_type_frequencies` how often each is seen in the knowledge base:
    a type it does not state counts as seen once. `views` are the lists read
    off the context's graph for the request's resource. `sources` are what
    found the candidate, and `vector_score` the score of its hit in the
    vector index, where it has one. `moment` is when the search is made,
    with its offset: recency is counted from it.
    """
    reasons: list[str] = []
    points = 0.0

    candidate_types = resource_entity_types(candidate)
    if entity_types and candidate_types:
        shared = [stated for stated in entity_types if stated in candidate_types]
        overlap = len(shared) / len({*entity_types, *candidate_types})
        rarity = 0.0
        for stated in shared:
            rarity += _rarity(entity_type_frequencies.get(stated, 1))
        points += overlap * 30 + rarity * 5
        if shared:
            reasons.append(f"entity types: {', '.join(shared)}")

    if any(connection.bidirectional and connection.resource_id == candidate.id for connection in views.connections):
        points += 20
        reasons.append("bidirectional connection")
    elif any(connection.resource_id == candidate.id for connection in views.connections):
        points += 10
        reasons.append("connected")

    # How many resources cite the request's resource: the same for every neighbour.
    cited_by = len(views.cited_by)
    if "neighborhood" in sources and cited_by > 0:
        points += min(cited_by * 2, 15)

    name, sought = candidate.name.lower(), term.lower()
    if name == sought:
        points += 25
        reasons.append("exact name match")
    elif name.startswith(sought):
        points += 15
        reasons.append("prefix name match")
    elif sought in name:
        points += 10
        reasons.append("contains name match")

    if candidate.date_created:
        points += _recency(candidate.date_created, moment)

    if vector_score is not None:
        points += vector_score * 25
        reasons.append("semantic similarity")

    if len(sources) > 1:
        points += len(sources) * 3
        reasons.append(f"{len(sources)} retrieval sources")

    return Score(points=rounded(points), reason="; ".join(reasons) or "candidate")


def with_model_score(score: Score, model_score: float) -> Score:
    """`score` with what a model gave its candidate, from 0 to 1: 25 times that more, rounded again.

    A model's score above 0.5 adds `semantic match` to the reason.
    """
    reason = f"{score.reason}; semantic match" if model_score > 0.5 else score.reason
    return Score(points=rounded(score.points + model_score * 25), reason=reason)
