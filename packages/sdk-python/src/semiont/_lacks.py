"""What a value lacks to be the shape it was read as, said in none of its own words.

Whatever decodes a value shows, in its account of a failure, what it was
given: the token an answer grants, the token a resource is cloned by, what a
person wrote. A failure is printed and logged, so what one says of a value
that was refused is said here instead: where the value is wrong, by the names
its shape declares on the way there.

A name on that way that is the value's own is never said: a mapping's, or
that of a member the shape has not. The way is named as far as the shape
declares it, and no further.
"""

from types import NoneType, UnionType
from typing import Annotated, TypeAliasType, Union, get_args, get_origin

from pydantic import ValidationError

from semiont.model import WireModel


def _shapes(named: object) -> tuple[type[WireModel], ...]:
    """The shapes a member's type names, whether or not the member may be absent. None, when it names anything else."""
    if isinstance(named, type):
        return (named,) if issubclass(named, WireModel) else ()
    if isinstance(named, TypeAliasType):
        return _shapes(named.__value__)
    if get_origin(named) is Annotated:
        return _shapes(get_args(named)[0])
    if get_origin(named) in (Union, UnionType):
        parts = [_shapes(part) for part in get_args(named) if part is not NoneType]
        return tuple(shape for part in parts for shape in part) if all(parts) else ()
    return ()


def _place(shapes: tuple[type[WireModel], ...], way: tuple[int | str, ...]) -> tuple[str, tuple[int | str, ...]]:
    """Where in a value a failure is, by the names `shapes` declare on the way to it, and what of the way they do not name."""
    # One of several shapes is named first, by what tells it from the others.
    left = way[1:] if len(shapes) > 1 else way
    names: list[str] = []
    while left and shapes:
        step = left[0]
        member = next(
            ((field.alias or name, field) for shape in shapes for name, field in shape.model_fields.items() if step in (name, field.alias)),
            None,
        )
        if member is None:
            break
        names.append(member[0])
        left = left[1:]
        # A member that is one of several shapes is as far as the way is named: the decoder accounts for each of them.
        within = _shapes(member[1].annotation)
        shapes = within if len(within) == 1 else ()
    return ".".join(names), left


def lacks(shapes: tuple[type[WireModel], ...], error: ValidationError, what: str) -> str:
    """What a value lacks to be one of `shapes`, which a reader knows as `what`.

    Each member is said by the name the wire gives it, under the names of the
    members it is within. None of it is the value's own text, and none is the
    decoder's account of the failure.
    """
    lacking: dict[str, None] = {}
    for detail in error.errors(include_url=False, include_context=False, include_input=False):
        place, left = _place(shapes, detail["loc"])
        if place:
            lacking[f"it has no `{place}`" if not left and detail["type"] == "missing" else f"its `{place}` is malformed"] = None
        elif len(left) == 1 and detail["type"] == "extra_forbidden":
            lacking[f"it has a member {what} has not"] = None
        else:
            lacking[f"it is not the JSON object {what} is"] = None
    return "; ".join(lacking)
