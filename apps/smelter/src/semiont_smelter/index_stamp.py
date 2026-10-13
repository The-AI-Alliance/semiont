"""What made a Smelter's index: the stamp an index is held to when the Smelter starts.

A point's vector is of one embedding model, and a resource's points are its
text as two numbers cut it. An index made by another model, or cut another
way, is searched wrongly and shows nothing of it: its points look the same.
So an index states what made it (`semiont_vectors.store.IndexStamp`), and a
Smelter that starts compares that with what it is configured to make one by.
Where they differ, or the index states nothing, the index is made again,
empty, and the reconcile that follows fills it whole
(`docs/protocol/SMELTER.md` § Boot).

The stamp states the embedding provider's type and its model, and the two
numbers a text is cut by. It does not state where the model is served, which
changes no vector.
"""

from pydantic import JsonValue
from semiont.types import SmelterConfig
from semiont_vectors.store import IndexStamp, VectorStore

from semiont_smelter.log import LOG

__all__ = ["hold_to", "stamp_of"]


def stamp_of(config: SmelterConfig) -> IndexStamp:
    """The stamp of an index made as this document says: which provider's which model embeds, and how a text is cut."""
    embedding: dict[str, JsonValue] = {"type": config.embedding.type, "model": config.embedding.model}
    chunking: dict[str, JsonValue] = {"chunkSize": config.chunking.chunk_size, "overlap": config.chunking.overlap}
    return {"embedding": embedding, "chunking": chunking}


async def hold_to(index: VectorStore, stamp: IndexStamp) -> bool:
    """Hold a connected index to `stamp`: where it states another, or none, make it again, empty. Answers whether it was made again.

    Called before anything is followed: nothing is applied to an index that
    is about to be made again.
    """
    # The stamp speaks for the index as a whole, and says only what made its vectors. The stores a knowledge base is
    # kept in are managed apart from each other: its record, each collection of this index, the anchored-text store.
    # One that is restored from a copy or cleared while the others are not is out of step with them, and no stamp
    # says so. Whether the index holds what the record holds now is the reconcile's to find.
    stated = await index.index_stamp()
    if stated == stamp:
        return False
    if stated is None and await index.count() == 0:
        LOG.info("The vector index is new: it states what makes it", extra={"stamp": stamp})
    else:
        LOG.warning(
            "The vector index was not made as this Smelter makes one: it is made again, and every resource indexed again",
            extra={"stated": stated, "stamp": stamp},
        )
    await index.make_anew(stamp)
    return True
