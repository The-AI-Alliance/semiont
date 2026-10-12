"""The recorded events a Smelter follows, as it reads them off the bus.

A Smelter follows nine of the events a knowledge base records
(`docs/protocol/SMELTER.md` § What it follows). Each reaches it as a stored
event, on the channel named for the event's type. The event's own payload is
that channel's to give (`semiont.channels`), typed as the bus registry names
it.

The Archivist publishes every recorded event twice: on its resource's scope,
for whoever holds that scope, and on no scope, for whoever follows the record
whole. A Smelter follows the record whole: its stream names each channel with
no scope held.

**It reads them as one stream, in the order they were delivered.** A
resource's events are applied in the order they arrive. Read a channel at a
time, an annotation's removal could be handed on before its making, and the
index would be left holding a point for an annotation that is gone.
"""

from typing import Final

from semiont.bus import decoded
from semiont.channel import RecordedChannel, ScopedChannel
from semiont.channels import (
    MARK_ADDED,
    MARK_ARCHIVED,
    MARK_ENTITY_TAG_ADDED,
    MARK_ENTITY_TAG_REMOVED,
    MARK_REMOVED,
    MARK_UNARCHIVED,
    YIELD_CREATED,
    YIELD_REPRESENTATION_ADDED,
    YIELD_UPDATED,
)
from semiont.model import WireModel
from semiont.transport import Frame
from semiont.types import EnrichedResourceEvent, StoredEventResponse

__all__ = ["ENRICHED", "FOLLOWED", "PLAIN", "stored_event"]

PLAIN: Final[tuple[RecordedChannel[StoredEventResponse, WireModel] | ScopedChannel[StoredEventResponse, WireModel], ...]] = (
    YIELD_CREATED,
    YIELD_UPDATED,
    YIELD_REPRESENTATION_ADDED,
    MARK_ARCHIVED,
    MARK_UNARCHIVED,
    MARK_REMOVED,
    MARK_ENTITY_TAG_ADDED,
    MARK_ENTITY_TAG_REMOVED,
)
"""The followed channels that carry a stored event and nothing beside it."""

ENRICHED: Final[tuple[ScopedChannel[EnrichedResourceEvent, WireModel], ...]] = (MARK_ADDED,)
"""The followed channel whose stored event carries, beside it, the annotation as a view holds it.

A Smelter reads the event alone: the annotation it indexes is the one the
event's own payload records.
"""

FOLLOWED: Final[tuple[str, ...]] = tuple(channel.name for channel in (*PLAIN, *ENRICHED))
"""The nine events a Smelter follows, by the name each is recorded and published under."""

_PLAIN: Final = {channel.name: channel for channel in PLAIN}
_ENRICHED: Final = {channel.name: channel for channel in ENRICHED}


def stored_event(frame: Frame) -> StoredEventResponse | None:
    """The recorded event a frame carries, where the frame is on a channel a Smelter follows. Nothing for any other frame.

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
