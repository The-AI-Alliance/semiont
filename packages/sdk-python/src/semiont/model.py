"""The base of every shape the protocol states."""

from pydantic import BaseModel

__all__ = ["WireModel"]


class WireModel(BaseModel, frozen=True, validate_by_name=True, validate_by_alias=True, serialize_by_alias=True):
    """A shape of the protocol: immutable, and named two ways.

    A field has the name Python gives it (`annotation_id`) and the name the wire
    gives it (`annotationId`). A model is built by the first, decoded from
    either, and written out by the second.

    Every subclass says `frozen=True` for itself: a type checker reads it from
    the class's own line, and refuses one that leaves it out. A class's
    configuration is its class keywords, here and in every subclass.
    """
