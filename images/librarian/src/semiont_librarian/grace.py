"""A resource read by its id from the graph, and from the record where the graph has none: one read that does not wait.

A resource is in the record before the Weaver has put it in the graph. Where
a read only needs a resource's description, the record has it whole, so
nothing waits and nothing is read twice (`docs/protocol/LIBRARIAN.md` §
Reference search, § Text search, § What refers to a resource). A graph read
that fails is taken as a graph that has no such resource.

A read of the record that fails is another matter from a resource the record
does not hold. Where the record only adds to an answer (one candidate of
many, a name, one related resource) the answer is made without it, and a
warning says which resource it was read for. `described_if_readable` is that
read, and the one place that decides it. A read an answer cannot be made
without is `Record.described`, whose failure is the request's.

This is not how the knowledge graph is built: a build needs the resource in
the graph, since a description from the record has no edges
(`semiont_librarian.knowledge_graph`).
"""

from dataclasses import dataclass
from typing import final

from semiont.identifiers import ResourceId
from semiont.types import ResourceDescriptor

from semiont_librarian.log import LOG
from semiont_librarian.reads import Described, GraphReads, Record

__all__ = ["Graced", "described_if_readable", "resource_with_view_grace"]


@final
@dataclass(frozen=True, slots=True)
class Graced:
    """A resource as it was read, and whether the graph was behind the record."""

    resource: ResourceDescriptor | None
    """The resource's description, or `None` where neither the graph nor the record holds it."""
    lagged_behind_view: bool
    """Whether the description is the record's, the graph having none or its read having failed. A caller logs it."""


async def described_if_readable(record: Record, resource_id: ResourceId) -> Described | None:
    """A resource as the record describes it, where that only adds to an answer: `None` where it holds none, and where the read fails.

    A read that fails is logged as a warning, which names the resource and
    says what failed.
    """
    try:
        return await record.described(resource_id)
    except Exception as unread:
        LOG.warning(
            "A resource's view could not be read: the answer is made without it",
            extra={"resourceId": resource_id, "error": str(unread)},
        )
        return None


async def resource_with_view_grace(graph: GraphReads, record: Record, resource_id: ResourceId) -> Graced:
    """A resource's description from the graph, or from the record where the graph has none or its read fails.

    The record is not read where the graph answers. A read of the record that
    fails is one the resource is not read from (`described_if_readable`).
    """
    try:
        from_graph = await graph.get_resource(resource_id)
    except Exception:
        from_graph = None
    if from_graph is not None:
        return Graced(resource=from_graph, lagged_behind_view=False)

    from_record = await described_if_readable(record, resource_id)
    if from_record is not None:
        return Graced(resource=from_record.resource, lagged_behind_view=True)
    return Graced(resource=None, lagged_behind_view=False)
