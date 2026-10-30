"""What a Librarian is handed to read by: each a protocol, and the ways a read fails that the Librarian tells apart.

A Librarian owns no store (`docs/protocol/LIBRARIAN.md`), and mounts no state
volume. It asks the Archivist, on the bus, for what it needs of the record and
for the profiles of the knowledge base's principals (§ Names), each read
bounded by its question. It reads the graph the Weaver writes and the index the Smelter
writes, and it waits, within a bound, for the two that are written after the
record (§ The two waits). What reads each is behind a protocol here. A
Librarian is handed these, and knows no address, no directory and no database.

Four more are handed to it from their own packages, each a protocol too: what
reads a resource's bytes (`semiont_service.content.ContentReads`), the vector
index (`semiont_vectors.store.VectorReader`), the embedding provider
(`semiont_vectors.embedding.EmbeddingProvider`) and a model
(`semiont_inference.interface.InferenceClient`).

A bound on a wait is in seconds. The page states milliseconds, and they are
divided once, where a setting is read.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol, final

from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import (
    AnchoredTextAnswer,
    Annotation,
    Motivation,
    Profile,
    ResourceDescriptor,
    SmeltSettledOutcome,
)
from semiont_graph.interface import EntityTypeCount, GraphConnection, ResourceListing, ResourceQuery

__all__ = [
    "AnchoredText",
    "Degraded",
    "Described",
    "GraphReads",
    "Profiles",
    "ProfilesUnread",
    "Projection",
    "Record",
    "Settled",
    "SmeltWaitTimedOut",
    "SmeltWaits",
    "WeaveWaitTimedOut",
    "WeaveWaits",
]

type Settled = SmeltSettledOutcome | Literal["inert"]
"""What a wait for the index ends with: the Smelter's decision, or `inert` where what was waited on has stopped.

`inert` is no decision. It ends a wait that a stopping Librarian would
otherwise leave open, and is read as `skipped` is: the index is not asked
again, and nothing is counted.
"""

type Projection = Literal["graph", "vectors", "suggestions", "summary", "relationship"]
"""What a gather went without.

`graph`: the graph did not come to hold the resource. `vectors`: the index
failed, or did not settle in time. The other three are what a model failed to
give: `suggestions`, the summary and the suggestions of a gather around a
resource; `summary`, the summary of the resource an annotation links to; and
`relationship`, the relationship sentence.
"""


@final
class ProfilesUnread(Exception):
    """The profiles of some principals could not be read: the Archivist refused the read, or did not answer it.

    A principal with no profile is not this: it is named by no one.
    """


@final
class WeaveWaitTimedOut(Exception):
    """The graph was not signalled to have reached a resource's sequence number within the bound."""


@final
class SmeltWaitTimedOut(Exception):
    """The index was not signalled to have settled a resource's bytes within the bound."""


@final
@dataclass(frozen=True, slots=True)
class Described:
    """A resource as the record describes it: its descriptor, and the sequence number of its last event."""

    resource: ResourceDescriptor
    last_sequence: int


class Record(Protocol):
    """The record the Archivist keeps, read a resource or an annotation at a time. Every reader of it has these members and no other."""

    async def described(self, resource_id: ResourceId) -> Described | None:
        """A resource as the record describes it. `None` where the record holds no such resource."""
        ...

    async def annotation(self, resource_id: ResourceId, annotation_id: AnnotationId) -> Annotation | None:
        """An annotation on a resource. `None` where the resource holds no such annotation.

        Asked only of a resource the record holds.
        """
        ...


class Profiles(Protocol):
    """What the principals of a knowledge base last said they are called (`Profile`). Every reader of it has this member and no other."""

    async def of(self, dids: Sequence[str]) -> Mapping[str, Profile]:
        """The profile of each of `dids` that has one, by their DID.

        Raises `ProfilesUnread` where they cannot be read.
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
