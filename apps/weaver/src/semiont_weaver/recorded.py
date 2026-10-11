"""The recorded events a Weaver follows, and the payload each carries.

A Weaver follows nine of the events a knowledge base records
(`docs/protocol/WEAVER.md` § What it follows). Each reaches it as a stored
event, on the channel named for the event's type, and its payload is the one
the bus registry names for that type.

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

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

from semiont.bus import decoded
from semiont.channel import Channel, ScopedChannel
from semiont.channels import (
    FRAME_ENTITY_TYPE_ADDED,
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
from semiont.types import (
    AnnotationAddedPayload,
    AnnotationBodyUpdatedPayload,
    AnnotationRemovedPayload,
    EnrichedResourceEvent,
    EntityTagChangedPayload,
    EntityTypeAddedPayload,
    ResourceArchivedPayload,
    ResourceCreatedPayload,
    ResourceUnarchivedPayload,
    StoredEventResponse,
)

PLAIN: Final[tuple[Channel[StoredEventResponse] | ScopedChannel[StoredEventResponse], ...]] = (
    YIELD_CREATED,
    MARK_ARCHIVED,
    MARK_UNARCHIVED,
    MARK_REMOVED,
    MARK_ENTITY_TAG_ADDED,
    MARK_ENTITY_TAG_REMOVED,
    FRAME_ENTITY_TYPE_ADDED,
)
"""The followed channels that carry a stored event and nothing beside it."""

ENRICHED: Final[tuple[ScopedChannel[EnrichedResourceEvent], ...]] = (MARK_ADDED, MARK_BODY_UPDATED)
"""The followed channels whose stored event carries, beside it, the annotation as a view holds it. A Weaver reads the event alone."""

FOLLOWED: Final[tuple[str, ...]] = tuple(channel.name for channel in (*PLAIN, *ENRICHED))
"""The nine events a Weaver follows, by the name each is recorded and published under."""

_PLAIN: Final = {channel.name: channel for channel in PLAIN}
_ENRICHED: Final = {channel.name: channel for channel in ENRICHED}

PAYLOADS: Final[Mapping[str, type[WireModel]]] = MappingProxyType(
    {
        "yield:created": ResourceCreatedPayload,
        "mark:archived": ResourceArchivedPayload,
        "mark:unarchived": ResourceUnarchivedPayload,
        "mark:added": AnnotationAddedPayload,
        "mark:removed": AnnotationRemovedPayload,
        "mark:body-updated": AnnotationBodyUpdatedPayload,
        "mark:entity-tag-added": EntityTagChangedPayload,
        "mark:entity-tag-removed": EntityTagChangedPayload,
        "frame:entity-type-added": EntityTypeAddedPayload,
    }
)
"""The payload of each followed event, as `specs/src/bus/registry.json` names it.

The registry is where this is stated. The SDK does not yet type a recorded
event's payload by its channel, so this is a copy, and `tests/test_census.py`
holds it to the registry: an event whose payload the registry renames fails
there.
"""


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


def payload_of[P: WireModel](event: StoredEventResponse, shape: type[P]) -> P:
    """A followed event's own payload, as the type the registry names for it.

    `shape` is the type its caller reads the payload as. It is the one this
    module states for the event's type, or the caller is wrong about what it
    was handed. Raises pydantic's `ValidationError` for a payload that is not
    that event's.
    """
    if PAYLOADS.get(event.type) is not shape:
        raise TypeError(f"{event.type} does not carry a {shape.__name__}")
    return shape.model_validate(event.payload)
