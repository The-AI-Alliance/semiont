"""A resource read by its id from the graph, and from its view where the graph has none: one read that does not wait.

A resource is in its view before the Weaver has put it in the graph. Where a
read only needs a resource's description, the view has it whole, so nothing
waits and nothing is read twice (`docs/protocol/LIBRARIAN.md` § Reference
search, § Text search, § What refers to a resource). A graph read that fails
is taken as a graph that has no such resource.

A view that cannot be read is another matter from a view that is not there:
its file is there, and is no view. Where a view only adds to an answer (one
candidate of many, a name, one related resource) the answer is made without
it, and a warning says which resource's view it was. `view_if_readable` is
that read, and the one place that decides it. A view an answer cannot be made
without is read by `Views.get`, whose failure is the request's.

This is not how the knowledge graph is built: a build needs the resource in
the graph, since a description from a view has no edges
(`semiont_librarian.knowledge_graph`).
"""

from dataclasses import dataclass
from typing import final

from semiont.identifiers import ResourceId
from semiont.types import ResourceDescriptor, ResourceView

from semiont_librarian.log import LOG
from semiont_librarian.reads import GraphReads, Views

__all__ = ["Graced", "resource_with_view_grace", "view_if_readable"]


@final
@dataclass(frozen=True, slots=True)
class Graced:
    """A resource as it was read, and whether the graph was behind its view."""

    resource: ResourceDescriptor | None
    """The resource's description, or `None` where neither the graph nor the views hold it."""
    lagged_behind_view: bool
    """Whether the description is the view's, the graph having none or its read having failed. A caller logs it."""


async def view_if_readable(views: Views, resource_id: ResourceId) -> ResourceView | None:
    """A resource's view, where it only adds to an answer: `None` where there is none, and where it cannot be read.

    A view that cannot be read is logged as a warning, which names the
    resource and says what failed.
    """
    try:
        return await views.get(resource_id)
    except Exception as unread:
        LOG.warning(
            "A resource's view could not be read: the answer is made without it",
            extra={"resourceId": resource_id, "error": str(unread)},
        )
        return None


async def resource_with_view_grace(graph: GraphReads, views: Views, resource_id: ResourceId) -> Graced:
    """A resource's description from the graph, or from its view where the graph has none or its read fails.

    The view is not read where the graph answers. A view that cannot be read
    is one the resource is not read from (`view_if_readable`).
    """
    try:
        from_graph = await graph.get_resource(resource_id)
    except Exception:
        from_graph = None
    if from_graph is not None:
        return Graced(resource=from_graph, lagged_behind_view=False)

    view = await view_if_readable(views, resource_id)
    if view is not None:
        return Graced(resource=view.resource, lagged_behind_view=True)
    return Graced(resource=None, lagged_behind_view=False)
