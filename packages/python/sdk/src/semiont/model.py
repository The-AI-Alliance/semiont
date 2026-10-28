"""The base of every shape the protocol states, and how one is written to the wire."""

from pydantic import BaseModel, JsonValue

__all__ = ["WireModel", "stated", "written"]


class WireModel(BaseModel, frozen=True, validate_by_name=True, validate_by_alias=True, serialize_by_alias=True):
    """A shape of the protocol: immutable, and named two ways.

    A field has the name Python gives it (`annotation_id`) and the name the wire
    gives it (`annotationId`). A model is built by the first, decoded from
    either, and written out by the second.

    Every subclass says `frozen=True` for itself: a type checker reads it from
    the class's own line, and refuses one that leaves it out. A class's
    configuration is its class keywords, here and in every subclass.
    """


def written(model: WireModel) -> dict[str, JsonValue]:
    """`model` as the wire carries it: by the wire's names, and without what was never said.

    A field of the model itself that may be left out, and holds nothing, is
    left out: an option given as `None` is an option not given. What the
    model holds deeper is written as it was given, so a shape read from the
    knowledge base is sent back as it came.
    """
    wire: dict[str, JsonValue] = model.model_dump(mode="json", exclude_unset=True)
    for name, field in type(model).model_fields.items():
        if not field.is_required() and getattr(model, name) is None:
            wire.pop(field.alias or name, None)
    return wire


def stated[M: WireModel](model: M) -> M:
    """`model`, saying only what it holds: an option given as `None` is an option not given.

    For a shape its caller made that is sent inside another, which `written`
    writes as it was given. What the shape holds is not read again: only what
    it says of itself changes.
    """
    kept = {
        name: held
        for name, field in type(model).model_fields.items()
        if name in model.model_fields_set and ((held := getattr(model, name)) is not None or field.is_required())
    }
    return type(model).model_validate({**kept, **(model.model_extra or {})})
