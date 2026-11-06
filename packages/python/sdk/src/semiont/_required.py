"""The first fault of a value as one of the protocol's shapes, said in none of its own words.

Every SDK holds what it reads to the table of what each component schema
requires (`semiont._required_table`, written by the rules of
packages/codegen/schemas/required-shapes.mjs) before it decodes it, and
names the first fault it finds the same way: a member the value lacks, or
one that is not what its schema allows, by the names the schema gives the
way to it. What a
decoder refuses that the table does not state is a fault of the value
itself. Whatever decodes a value shows, in its account of a failure, what it
was given (the token an answer grants, what a person wrote), and a failure
is printed and logged: so nothing said of a fault is the value's own.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Literal, TypeAliasType, final, override

from pydantic import BaseModel, Field, JsonValue, TypeAdapter, ValidationError

from semiont._required_table import SCHEMAS
from semiont.channel import Empty, Response
from semiont.model import WireModel

type _Kind = Literal["object", "array", "string", "integer", "number", "boolean", "null"]


class _Discriminator(BaseModel, frozen=True, extra="forbid"):
    """The member whose value names the variant a union is."""

    property: str
    mapping: dict[str, int]


class _Step(BaseModel, frozen=True, extra="forbid"):
    """One step of a pattern: at least `least` of a text's next code points, and at most `most` (None: any number).

    Each is in one of the ranges `of`, from and to, both included.
    """

    of: tuple[tuple[int, int], ...]
    least: int = Field(alias="min")
    most: int | None = Field(default=None, alias="max")


class _Shape(BaseModel, frozen=True, extra="forbid"):
    """What a value must be: packages/codegen/schemas/required-shapes.mjs states what each part means."""

    ref: str | None = None
    kinds: tuple[_Kind, ...] | None = None
    enum: tuple[JsonValue, ...] | None = None
    pattern: tuple[_Step, ...] | None = None
    min_length: int | None = Field(default=None, alias="minLength")
    max_length: int | None = Field(default=None, alias="maxLength")
    minimum: float | None = None
    maximum: float | None = None
    min_items: int | None = Field(default=None, alias="minItems")
    max_items: int | None = Field(default=None, alias="maxItems")
    required: tuple[str, ...] | None = None
    members: dict[str, "_Shape"] | None = None
    closed: tuple[str, ...] | None = None
    """The only members an object may carry; None, where it may carry any."""
    items: "_Shape | None" = None
    values: "_Shape | None" = None
    one_of: tuple["_Shape", ...] | None = Field(default=None, alias="oneOf")
    discriminator: _Discriminator | None = None
    all_of: tuple["_Shape", ...] | None = Field(default=None, alias="allOf")


_SCHEMAS: Final = TypeAdapter(dict[str, _Shape]).validate_json(SCHEMAS)
_JSON: Final = TypeAdapter[JsonValue](JsonValue)


@final
@dataclass(frozen=True, slots=True)
class Fault:
    """The first thing wrong with a value: the way to the member it is at, and why.

    The way is the names of the members it is within, and its own, joined by
    dots; the empty way is the value itself. `lacks`: the value does not carry
    the member, or the member holds null where it may not. `malformed`: the
    member is not what its schema allows (of another kind, another value, form
    or size), or is one a closed object does not name.
    """

    member: str
    reason: Literal["lacks", "malformed"]

    @override
    def __str__(self) -> str:
        """What every SDK says of the fault."""
        if self.reason == "lacks":
            return f"it has no `{self.member}`"
        return "it is malformed" if self.member == "" else f"its `{self.member}` is malformed"


UNDECODED: Final = Fault(member="", reason="malformed")
"""The fault of a value its decoder refuses that has no fault the table states: the value itself is malformed."""


def _shape_of(declared: object) -> _Shape:
    """What a value of `declared` must be: a shape of the protocol, a union of them, `Response` of one, or `Empty`."""
    if declared is Empty:
        return _Shape(kinds=("object",))
    if isinstance(declared, type) and issubclass(declared, Response):
        (answered,) = declared.__pydantic_generic_metadata__["args"]
        return _Shape(kinds=("object",), required=("response",), members={"response": _shape_of(answered)})
    if not ((isinstance(declared, type) and issubclass(declared, WireModel)) or isinstance(declared, TypeAliasType)):
        raise TypeError(f"{declared!r} is no shape of the protocol")
    if declared.__name__ not in _SCHEMAS:
        raise TypeError(f"{declared.__name__} is no component schema of the spec")
    return _Shape(ref=declared.__name__)


def _resolved(shape: _Shape) -> _Shape:
    """`shape`, or the component it refers to."""
    while shape.ref is not None:
        shape = _SCHEMAS[shape.ref]
    return shape


def _allows(kinds: tuple[_Kind, ...] | None, value: JsonValue) -> bool:
    """Whether `kinds` allow `value`: none allow any, and an integer is a number with no fractional part."""
    if kinds is None:
        return True
    if value is None:
        return "null" in kinds
    if isinstance(value, bool):
        return "boolean" in kinds
    if isinstance(value, int):
        return "integer" in kinds or "number" in kinds
    if isinstance(value, float):
        return "number" in kinds or ("integer" in kinds and value.is_integer())
    if isinstance(value, str):
        return "string" in kinds
    if isinstance(value, dict):
        return "object" in kinds
    return "array" in kinds


def _within(way: str, name: str) -> str:
    return name if way == "" else f"{way}.{name}"


def _counted(least: float | None, count: float, most: float | None) -> bool:
    """Whether `count` is at least `least` and at most `most`, where each is stated."""
    return (least is None or count >= least) and (most is None or count <= most)


def _matches(steps: tuple[_Step, ...], text: str, at: int) -> bool:
    """Whether the code points of `text` from `at` are of `steps`.

    The first step takes as many of them as it may, and gives them back one by
    one until the steps after it take the rest.
    """
    if not steps:
        return at == len(text)
    first, rest = steps[0], steps[1:]
    taken = 0
    while (
        at + taken < len(text)
        and (first.most is None or taken < first.most)
        and any(low <= ord(text[at + taken]) <= high for low, high in first.of)
    ):
        taken += 1
    return any(_matches(rest, text, at + count) for count in range(taken, first.least - 1, -1))


def _is_as_stated(shape: _Shape, value: JsonValue) -> bool:
    """Whether `value` is one of `shape`'s values, and is of its form, its sizes and its bounds.

    A number is one of the values where it is equal to one in value; a
    boolean is never a number.
    """
    if shape.enum is not None and not any(one == value and isinstance(one, bool) == isinstance(value, bool) for one in shape.enum):
        return False
    if isinstance(value, str):
        return _counted(shape.min_length, len(value), shape.max_length) and (shape.pattern is None or _matches(shape.pattern, value, 0))
    if isinstance(value, int | float) and not isinstance(value, bool):
        return _counted(shape.minimum, value, shape.maximum)
    if isinstance(value, list):
        return _counted(shape.min_items, len(value), shape.max_items)
    return True


def _fault_at(shape: _Shape, value: JsonValue, way: str) -> Fault | None:
    """The first fault `value` has as a value of `shape`, from `way`."""
    own = _resolved(shape)
    if not _allows(own.kinds, value) or not _is_as_stated(own, value):
        return Fault(member=way, reason="malformed")
    if isinstance(value, dict):
        fault = _fault_of_members(own, value, way)
        if fault is not None:
            return fault
    if isinstance(value, list) and own.items is not None:
        for item in value:
            fault = _fault_at(own.items, item, way)
            if fault is not None:
                return fault
    if own.one_of is not None:
        fault = _fault_of_one_of(own, value, way)
        if fault is not None:
            return fault
    for part in own.all_of or ():
        fault = _fault_at(part, value, way)
        if fault is not None:
            return fault
    return None


def _fault_of_members(shape: _Shape, value: dict[str, JsonValue], way: str) -> Fault | None:
    """The first fault of an object: in the members `shape` requires, what they are, the members it may not carry, and its values."""
    members = shape.members or {}
    for name in shape.required or ():
        if name not in value or (value[name] is None and name in members and not _allows(_resolved(members[name]).kinds, None)):
            return Fault(member=_within(way, name), reason="lacks")
    for name, member in members.items():
        held = value.get(name)
        if held is None:
            continue
        fault = _fault_at(member, held, _within(way, name))
        if fault is not None:
            return fault
    if shape.closed is not None:
        unnamed = min((name for name in value if name not in shape.closed), default=None)
        if unnamed is not None:
            return Fault(member=_within(way, unnamed), reason="malformed")
    if shape.values is not None:
        for key in sorted(value):
            fault = _fault_at(shape.values, value[key], way)
            if fault is not None:
                return fault
    return None


def _fault_of_one_of(shape: _Shape, value: JsonValue, way: str) -> Fault | None:
    """The fault `value` has as one of the variants of `shape`.

    The variant its discriminator names, or else each variant whose kinds
    allow it: none when one of them has none, the first one's when each has
    one, and a value no variant allows is malformed.
    """
    variants = shape.one_of or ()
    candidates = [variant for variant in variants if _allows(_resolved(variant).kinds, value)]
    if isinstance(value, dict) and shape.discriminator is not None:
        named = value.get(shape.discriminator.property)
        if isinstance(named, str) and named in shape.discriminator.mapping:
            candidates = [variants[shape.discriminator.mapping[named]]]
    if not candidates:
        return Fault(member=way, reason="malformed")
    first: Fault | None = None
    for candidate in candidates:
        fault = _fault_at(candidate, value, way)
        if fault is None:
            return None
        if first is None:
            first = fault
    return first


def fault_of(declared: object, value: JsonValue) -> Fault | None:
    """The first fault `value` has as a `declared`, by the rules every SDK reads the table by; None when it has none.

    `declared` is a shape of the protocol or a union of them, by the name
    `semiont.types` gives it, `Response` of one, or `Empty`.
    """
    return _fault_at(_shape_of(declared), value, "")


def read_as[T](declared: object, text: str | bytes, decode: Callable[[str | bytes], T]) -> T | Fault:
    """The JSON `text` read by `decode` as a `declared`, or the first fault that keeps it from being one.

    A text that is no JSON, and one `decode` refuses with no fault the table
    states, is malformed.
    """
    try:
        value = _JSON.validate_json(text)
    except ValidationError:
        return UNDECODED
    fault = fault_of(declared, value)
    if fault is not None:
        return fault
    try:
        return decode(text)
    except ValidationError:
        return UNDECODED
