"""The recorded events a Weaver follows, as it reads them off the bus.

A Weaver follows eight of the events a knowledge base records
(`docs/protocol/WEAVER.md` § What it follows). Each reaches it as a stored
event, on the channel named for the event's type. The event's own payload is
that channel's to give (`semiont.channels`), typed as the bus registry names
it, and the fold reads each one there.

The Archivist publishes every recorded event twice: on its resource's scope,
for whoever holds that scope, and on no scope, for whoever follows the record
whole. A Weaver follows the record whole: its stream names each channel with
no scope held.

**It reads them as one stream, in the order they were delivered.** A
resource's events are applied in the order of their sequence numbers, and an
event at or below what was applied is passed by as one delivered again. Read
a channel at a time, an annotation's removal could be handed on before its
making: the making would then be passed by, and the graph would hold what the
record does not.
"""

from typing import Final

from semiont.bus import decoded
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
from semiont.transport import Frame
from semiont.types import EnrichedResourceEvent, StoredEventResponse

__all__ = ["ENRICHED", "FOLLOWED", "PLAIN", "stored_event"]

PLAIN: Final[tuple[RecordedChannel[StoredEventResponse, WireModel] | ScopedChannel[StoredEventResponse, WireModel], ...]] = (
    YIELD_CREATED,
    MARK_ARCHIVED,
    MARK_UNARCHIVED,
    MARK_REMOVED,
    MARK_ENTITY_TAG_ADDED,
    MARK_ENTITY_TAG_REMOVED,
)
"""The followed channels that carry a stored event and nothing beside it."""

ENRICHED: Final[tuple[ScopedChannel[EnrichedResourceEvent, WireModel], ...]] = (MARK_ADDED, MARK_BODY_UPDATED)
"""The followed channels whose stored event carries, beside it, the annotation as a view holds it. A Weaver reads the event alone."""

FOLLOWED: Final[tuple[str, ...]] = tuple(channel.name for channel in (*PLAIN, *ENRICHED))
"""The eight events a Weaver follows, by the name each is recorded and published under."""

_PLAIN: Final = {channel.name: channel for channel in PLAIN}
_ENRICHED: Final = {channel.name: channel for channel in ENRICHED}


def stored_event(frame: Frame) -> StoredEventResponse | None:
    """The recorded event a frame carries, where the frame is on a channel a Weaver follows. Nothing for any other frame.

    Raises pydantic's `ValidationError` for a frame on a followed channel
    that carries no stored event.
    """
    plain = _PLAIN.get(frame.channel)
    if plain is not None:
        return decoded(plain, frame.payload)
    enriched = _ENRICHED.get(frame.channel)
    if enriched is not None:
        return decoded(enriched, frame.payload)
    return None
