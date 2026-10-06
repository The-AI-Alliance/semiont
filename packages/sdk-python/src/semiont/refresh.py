# Generated from specs/src/client/refresh.json; do not edit.
# Regenerate: node scripts/spec/generate-cache-refresh-python.mjs

"""What a Semiont client asks again for, and when.

A client's live queries answer from a cache. This table says what each event
on the bus, and the reopening of a dropped stream, does to it: which queries
are asked for again, which are written with what the event carries, and which
are gone.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final, Literal, final

__all__ = [
    "CACHE_QUERIES",
    "CACHE_REFRESH",
    "CacheQuery",
    "CacheRefresh",
    "CacheRefreshReach",
    "CacheRefreshTrigger",
    "CacheRefreshWhen",
]

# The live queries a client's cache answers.
type CacheQuery = Literal[
    # A resource's description.
    "resource",
    # The annotations of a resource.
    "annotations",
    # One annotation.
    "annotation",
    # The recorded history of a resource.
    "events",
    # The annotations elsewhere that refer to a resource.
    "referencedBy",
    # A list of resources, one per set of filters asked for. It is a query's answer, kept fresh
    # by what every client hears and by the events of the resources whose scope the client
    # holds, and by nothing else: a resource archived, unarchived or retagged elsewhere, by
    # someone else, does not refresh it.
    "resources",
    # The resources a text search found, one per search and set of filters asked for. A query's
    # answer like `resources`, and kept fresh by the same events and no others.
    "matchedResources",
    # The knowledge base's entity types.
    "entityTypes",
    # The knowledge base's tag schemas.
    "tagSchemas",
    # The collaborator directory, joined with the limits each inference key holder reports:
    # asking again asks every `<flow>:limits-requested` operation of the registry again too.
    "agents",
]

CACHE_QUERIES: Final[tuple[CacheQuery, ...]] = (
    "resource",
    "annotations",
    "annotation",
    "events",
    "referencedBy",
    "resources",
    "matchedResources",
    "entityTypes",
    "tagSchemas",
    "agents",
)

# Which of a split channel's two kinds of event a row is for.
type CacheRefreshWhen = Literal["enriched", "unenriched"]

# `subject`: the keys the event names. `held`: every key the client holds.
type CacheRefreshReach = Literal["subject", "held"]

# What each trigger is: a channel whose events are it, or `reopened`, the
# stream open again after a drop.
type CacheRefreshTrigger = Literal[
    "reopened",
    "bus:resume-gap",
    "mark:added",
    "mark:removed",
    "mark:delete-ok",
    "mark:body-updated",
    "mark:entity-tag-added",
    "mark:entity-tag-removed",
    "mark:archived",
    "mark:unarchived",
    "yield:created",
    "yield:updated",
    "yield:cloned",
    "yield:moved",
    "frame:entity-type-added",
    "frame:tag-schema-added",
]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class CacheRefresh:
    """What one trigger does to the cache."""

    reach: CacheRefreshReach
    refetches: tuple[CacheQuery, ...] = ()
    """Asked for again, the value shown meanwhile."""
    writes: tuple[CacheQuery, ...] = ()
    """Written with the value the event carries."""
    removes: tuple[CacheQuery, ...] = ()
    """Gone: the key fails as `bus.not-found`."""
    when: CacheRefreshWhen | None = None


CACHE_REFRESH: Final[Mapping[CacheRefreshTrigger, tuple[CacheRefresh, ...]]] = MappingProxyType(
    {
        # The stream is open again after a drop. Events every client hears carry no position, so
        # the ones published meanwhile are lost and nothing replays them: the client asks again
        # for everything they feed. What a resource's own scope feeds needs nothing here: its
        # events are replayed from where the client left off, or `bus:resume-gap` says they
        # could not be.
        "reopened": (
            CacheRefresh(reach="held", refetches=("resources", "matchedResources", "resource", "entityTypes", "tagSchemas", "agents")),
        ),
        # The gateway could not replay what a scope missed: everything held of that resource,
        # and of its annotations, is asked for again.
        "bus:resume-gap": (
            CacheRefresh(reach="subject", refetches=("annotations", "annotation", "resource", "events", "referencedBy")),
        ),
        # An annotation was added to the resource.
        "mark:added": (
            CacheRefresh(reach="subject", refetches=("annotations", "events")),
        ),
        # An annotation was removed from the resource.
        "mark:removed": (
            CacheRefresh(reach="subject", refetches=("annotations", "events"), removes=("annotation",)),
        ),
        # The reply to this client's own deletion: the annotation is gone whether or not the
        # client holds the scope that would tell it so.
        "mark:delete-ok": (
            CacheRefresh(reach="subject", removes=("annotation",)),
        ),
        # enriched: An annotation's body changed, and the event carries the annotation as it now
        # is. unenriched: An annotation's body changed, and the event could not say what it now
        # is.
        "mark:body-updated": (
            CacheRefresh(reach="subject", refetches=("events",), writes=("annotations", "annotation"), when="enriched"),
            CacheRefresh(reach="subject", refetches=("annotations", "annotation", "events"), when="unenriched"),
        ),
        # An entity tag was added to the resource.
        "mark:entity-tag-added": (
            CacheRefresh(reach="subject", refetches=("annotations", "resource", "events")),
        ),
        # An entity tag was removed from the resource.
        "mark:entity-tag-removed": (
            CacheRefresh(reach="subject", refetches=("annotations", "resource", "events")),
        ),
        # The resource was archived, which its description states and lists filter on.
        "mark:archived": (
            CacheRefresh(reach="subject", refetches=("resource", "resources", "matchedResources")),
        ),
        # The resource was unarchived.
        "mark:unarchived": (
            CacheRefresh(reach="subject", refetches=("resource", "resources", "matchedResources")),
        ),
        # A resource was created.
        "yield:created": (
            CacheRefresh(reach="subject", refetches=("resource", "resources", "matchedResources")),
        ),
        # A resource was updated.
        "yield:updated": (
            CacheRefresh(reach="subject", refetches=("resource", "resources", "matchedResources")),
        ),
        # A resource was created as a clone.
        "yield:cloned": (
            CacheRefresh(reach="subject", refetches=("resource", "resources", "matchedResources")),
        ),
        # A resource was renamed or moved.
        "yield:moved": (
            CacheRefresh(reach="subject", refetches=("resource", "resources", "matchedResources")),
        ),
        # An entity type was added to the knowledge base.
        "frame:entity-type-added": (
            CacheRefresh(reach="subject", refetches=("entityTypes",)),
        ),
        # A tag schema was added to the knowledge base.
        "frame:tag-schema-added": (
            CacheRefresh(reach="subject", refetches=("tagSchemas",)),
        ),
    }
)
