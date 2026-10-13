"""What a Smelter reports of what it keeps, beside what every service reports of itself: how many points its index holds.

Every service's own readings, and where telemetry goes, are
`semiont_service.observability`'s. This is the one number that is the
Smelter's alone (`semiont.vector.index.size` in
`specs/src/service-telemetry/telemetry.json`).
"""

from semiont_vectors.store import VectorStore

from semiont_smelter.log import LOG, words_of

__all__ = ["points_held"]


async def points_held(index: VectorStore) -> int | None:
    """How many points the index holds, for the gauge that reports it. A count that fails is logged, and no number is answered."""
    try:
        return await index.count()
    except Exception as failure:
        LOG.warning("Could not count the points of the vector index", extra={"error": words_of(failure)})
        return None
