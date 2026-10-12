"""What a Librarian is handed to read by: each a protocol, and the ways a read fails that the Librarian tells apart.

A Librarian owns no store (`docs/protocol/LIBRARIAN.md`). It reads the views
and the people projection the Archivist writes (§ Names), the graph the
Weaver writes and the index the Smelter writes, and it waits, within a bound,
for the two that are written after the record (§ The two waits). What reads
each is behind a protocol here. A Librarian is handed these, and knows no
address, no directory and no database.

Four more are handed to it from their own packages, each a protocol too: what
reads a resource's bytes (`semiont_service.content.ContentReads`), the vector
index (`semiont_vectors.store.VectorReader`), the embedding provider
(`semiont_vectors.embedding.EmbeddingProvider`) and a model
(`semiont_inference.interface.InferenceClient`).

A bound on a wait is in seconds. The page states milliseconds, and they are
divided once, where a setting is read.
"""

from collections.abc import Mapping
from typing import Literal, Protocol, final

from semiont.identifiers import ResourceId
from semiont.types import (
    AnchoredTextAnswer,
    Annotation,
    Motivation,
    PeopleProjectionPeopleValue,
    ResourceDescriptor,
    ResourceView,
    SmeltSettledOutcome,
)
from semiont_graph.interface import EntityTypeCount, GraphConnection, ResourceListing, ResourceQuery

__all__ = [
    "AnchoredText",
    "Degraded",
    "GraphReads",
    "People",
    "PeopleUnread",
    "Projection",
    "Settled",
    "SmeltWaitTimedOut",
    "SmeltWaits",
    "Views",
    "WeaveWaitTimedOut",
    "WeaveWaits",
]

type Settled = SmeltSettledOutcome | Literal["inert"]
"""What a wait for the index ends with: the Smelter's decision, or `inert` where what was waited on has stopped.

`inert` is no decision. It ends a wait that a stopping Librarian would
otherwise leave open, and is read as `skipped` is: the index is not asked
again, and nothing is counted.
"""

type Projection = Literal["graph", "vectors", "suggestions"]
"""What a gather went without: the graph or the index, whose wait ran out, or the suggestions a model failed to give."""


@final
class PeopleUnread(Exception):
    """The people projection could not be read: it is there, and is not what its schema states, or the file could not be opened.

    A knowledge base with no projection is not this: it names no one.
    """


@final
class WeaveWaitTimedOut(Exception):
    """The graph was not signalled to have reached a resource's sequence number within the bound."""


@final
class SmeltWaitTimedOut(Exception):
    """The index was not signalled to have settled a resource's bytes within the bound."""


class Views(Protocol):
    """The views the Archivist keeps of each resource (`ResourceView`). Every reader of them has this member and no other."""

    async def get(self, resource_id: ResourceId) -> ResourceView | None:
        """A resource's view: its description, its annotations and the sequence number of the last event applied.

        `None` where there is no view of it.
        """
        ...


class People(Protocol):
    """What the people of a knowledge base are called (`PeopleProjection`). Every reader of it has this member and no other."""

    async def read(self) -> Mapping[str, PeopleProjectionPeopleValue]:
        """Each person's profile, by their DID. Nobody, where the knowledge base has no projection.

        Raises `PeopleUnread` where the projection cannot be read.
        """
        ...


class GraphReads(Protocol):
    """The graph, as a Librarian asks it: the six reads of `semiont_graph.interface.GraphDatabase`, each as that states it.

    Every store of the graph package has these members, and a Librarian is
    handed nothing that writes.
    """

    async def get_resource(self, resource_id: ResourceId) -> ResourceDescriptor | None: ...

    async def list_resources(self, query: ResourceQuery) -> ResourceListing: ...

    async def get_resource_annotations(self, resource_id: ResourceId) -> list[Annotation]:
        """The annotations on a resource, newest first."""
        ...

    async def get_resource_referenced_by(self, resource_id: ResourceId, motivation: Motivation | None) -> list[Annotation]:
        """The annotations, on any resource, that link to this one, newest first: all of them, or those of one `motivation`."""
        ...

    async def get_resource_connections(self, resource_id: ResourceId) -> list[GraphConnection]:
        """The resources this one links to, one connection for each, with the annotations that link to it."""
        ...

    async def get_entity_type_stats(self) -> list[EntityTypeCount]:
        """How many resources have each entity type: the most first, and by name where two have as many."""
        ...


class AnchoredText(Protocol):
    """A resource's anchored text, asked of the gateway: the SDK content transport's `get_anchored_text`."""

    async def ask(self, resource_id: ResourceId) -> AnchoredTextAnswer:
        """The text of a resource's content with where each run is on a page, a stored decline, or why there is none."""
        ...


class WeaveWaits(Protocol):
    """The wait for the graph: what `weave:applied` has signalled of each resource, as something to wait on."""

    async def when_applied(self, resource_id: ResourceId, sequence: int, within: float) -> None:
        """Wait, for `within` seconds at most, until the graph is signalled to have applied a resource's events up to `sequence`.

        Answers at once where it already has. Raises `WeaveWaitTimedOut`
        where the bound runs out first.
        """
        ...


class SmeltWaits(Protocol):
    """The wait for the index: the last decision `smelt:settled` has signalled of each resource, as something to wait on."""

    async def when_settled(self, resource_id: ResourceId, checksum: str, within: float) -> Settled:
        """Wait, for `within` seconds at most, for the Smelter's decision of exactly the bytes `checksum` is of, and answer it.

        Answers at once where that decision is already kept. Raises
        `SmeltWaitTimedOut` where the bound runs out first.
        """
        ...


class Degraded(Protocol):
    """What counts a gather that went without something: the counter `semiont.gather.degraded`."""

    def note(self, projection: Projection) -> None:
        """Count one gather that went without `projection`."""
        ...
