"""The fold of chunks to resources, by itself.

A resource is as near as its best passage, and not as its average one or the
first one seen: both of those are folds that look right and are not.
"""

from semiont.identifiers import ResourceId

from semiont_vectors.merge import merge_by_resource
from semiont_vectors.store import VectorSearchResult


def hit(resource: str, score: float, text: str) -> VectorSearchResult:
    """A chunk a search found, before the fold."""
    return VectorSearchResult(score=score, resource_id=ResourceId(resource), text=text)


def test_many_chunks_fold_to_one_result_for_each_resource() -> None:
    hits = [
        hit("res-a", 0.9, "a chunk 0"),
        hit("res-b", 0.7, "b chunk 0"),
        hit("res-a", 0.5, "a chunk 1"),
        hit("res-b", 0.6, "b chunk 1"),
        hit("res-a", 0.4, "a chunk 2"),
    ]
    assert merge_by_resource(hits) == [hit("res-a", 0.9, "a chunk 0"), hit("res-b", 0.7, "b chunk 0")]


def test_a_resource_scores_as_its_best_chunk_and_not_as_the_first_or_the_mean() -> None:
    # The first seen scores 0.2 and the mean is 0.4: only the best is 0.8.
    merged = merge_by_resource([hit("res-a", 0.2, "weak"), hit("res-a", 0.8, "strong"), hit("res-a", 0.2, "weak again")])
    assert [found.score for found in merged] == [0.8]


def test_the_result_carries_the_text_of_the_chunk_that_scored_best() -> None:
    hits = [
        hit("res-a", 0.3, "a passage off the subject"),
        hit("res-a", 0.95, "the passage that matched"),
        hit("res-a", 0.5, "a passage beside the subject"),
    ]
    assert [found.text for found in merge_by_resource(hits)] == ["the passage that matched"]


def test_the_results_are_best_first() -> None:
    merged = merge_by_resource([hit("res-low", 0.1, "low"), hit("res-high", 0.99, "high"), hit("res-mid", 0.5, "mid")])
    assert [str(found.resource_id) for found in merged] == ["res-high", "res-mid", "res-low"]


def test_the_result_is_the_best_chunks_whole_and_no_blend_of_the_chunks() -> None:
    weak = VectorSearchResult(score=0.2, resource_id=ResourceId("res-a"), text="weak", entity_types=("Draft",))
    strong = VectorSearchResult(
        score=0.8,
        resource_id=ResourceId("res-a"),
        text="strong",
        entity_types=("Article",),
        machine_read=True,
    )
    assert merge_by_resource([weak, strong]) == [strong]


def test_of_chunks_that_score_the_same_the_earlier_is_kept_and_their_resources_stay_in_the_order_first_seen() -> None:
    hits = [
        hit("res-b", 0.5, "b first"),
        hit("res-a", 0.5, "a first"),
        hit("res-b", 0.5, "b second"),
        hit("res-a", 0.5, "a second"),
    ]
    assert merge_by_resource(hits) == [hit("res-b", 0.5, "b first"), hit("res-a", 0.5, "a first")]


def test_no_chunks_fold_to_no_results() -> None:
    assert merge_by_resource([]) == []


def test_the_fold_cuts_to_no_limit() -> None:
    # Each caller cuts to its own.
    assert len(merge_by_resource([hit("res-a", 0.9, "a"), hit("res-b", 0.8, "b"), hit("res-c", 0.7, "c")])) == 3
