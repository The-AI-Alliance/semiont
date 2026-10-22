"""The recorded events the Weaver's fold applies.

The fold applies eight of the events a knowledge base records
(`docs/protocol/WEAVER.md` § The fold). Every other event of a resource's log
is taken as nothing: a Weaver follows the record whole
(`semiont_service.follower`), and an event it has no use for moves its cursor
all the same. Each is a stored event, whose own payload is its channel's to
give (`semiont.channels`), typed as the bus registry names it, and the fold
reads each one there.
"""

from typing import Final

from semiont.channel import RecordedChannel, ScopedChannel
from semiont.channels import (
    MARK_ADDED,
    MARK_ARCHIVED,
    MARK_BODY_UPDATED,
    MARK_ENTITY_TAG_ADDED,
    MARK_ENTITY_TAG_REMOVED,
    MARK_REMOVED,
    MARK_UNARCHIVED,
    YIELD_CREATED,
)
from semiont.model import WireModel
from semiont.types import EnrichedResourceEvent, StoredEventResponse

__all__ = ["ENRICHED", "FOLDED", "PLAIN"]

PLAIN: Final[tuple[RecordedChannel[StoredEventResponse, WireModel] | ScopedChannel[StoredEventResponse, WireModel], ...]] = (
    YIELD_CREATED,
    MARK_ARCHIVED,
    MARK_UNARCHIVED,
    MARK_REMOVED,
    MARK_ENTITY_TAG_ADDED,
    MARK_ENTITY_TAG_REMOVED,
)
"""The events the fold applies whose channel carries a stored event and nothing beside it."""

ENRICHED: Final[tuple[ScopedChannel[EnrichedResourceEvent, WireModel], ...]] = (MARK_ADDED, MARK_BODY_UPDATED)
"""The events the fold applies whose channel carries, beside the stored event, the annotation as a view holds it.

The fold reads the event alone.
"""

FOLDED: Final[tuple[str, ...]] = tuple(channel.name for channel in (*PLAIN, *ENRICHED))
"""The eight events the fold applies, by the name each is recorded and published under."""
