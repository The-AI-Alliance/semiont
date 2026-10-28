"""Folding the chunks a search found to one entry for each resource.

A search of the index answers chunks, and a resource may be answered by
several of its own. Whoever wants resources folds them here. A resource
scores as the one chunk of it that scored best, and is answered with that
chunk's text, which is the passage that matched. The mean of its chunks'
scores would rank a resource of many subjects below one that is near none of
them, and the first chunk seen would make the answer depend on the order the
chunks came in.

The fold cuts to no limit: each caller cuts to its own.
"""

from collections.abc import Sequence

from semiont.identifiers import ResourceId

from semiont_vectors.store import VectorSearchResult

__all__ = ["merge_by_resource"]


def merge_by_resource(hits: Sequence[VectorSearchResult]) -> list[VectorSearchResult]:
    """One result for each resource among `hits`, best first: the one of its results that scored best, as it is.

    Of two results of one resource that score the same, the earlier is kept.
    Two resources whose best results score the same are answered in the
    order they were first seen.
    """
    best: dict[ResourceId, VectorSearchResult] = {}
    for hit in hits:
        held = best.get(hit.resource_id)
        if held is None or hit.score > held.score:
            best[hit.resource_id] = hit
    return sorted(best.values(), key=lambda kept: kept.score, reverse=True)
