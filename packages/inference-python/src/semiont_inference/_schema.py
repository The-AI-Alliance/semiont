"""An element schema, rewritten into what a provider is sent for an array of such elements, and its answer read back.

A caller asks for a JSON array whose elements satisfy one schema, which it
writes once. Providers do not all take that as it is written. Some take an
array at the root and a property left out of `required`. Another (OpenAI, in
its strict mode) takes only an object at the root, with every property of
every object required and every object closed: there the array is the one
property of a wrapping object, an optional property is written as one that
takes null, and a null in the answer stands for the property left out.

`array_schema` makes, in one dialect, what the provider is sent, together
with the reading back of what it answers: the array taken out of its
wrapper, and each null that stands for a property left out taken out of its
element, so that an element reads the same whichever provider wrote it.

Which schemas are taken does not depend on the dialect, but for one case the
table of `tests/schema-cases.json` states. A keyword this module does not
know how to rewrite is refused by name, and is never passed through: what a
provider does with a keyword it was not expected to see is not known here.
"""

import copy
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Literal, NoReturn, final

from pydantic import JsonValue

from semiont_inference._structured import kind, read_array, read_json
from semiont_inference.interface import ElementSchema, StructuredReadError

type Dialect = Literal["as-written", "object-root-all-required"]
"""How a provider takes a schema.

`as-written`: an array at the root, and the element schema as the caller
wrote it. `object-root-all-required`: an object at the root that holds the
array, every property of every object in `required`, one that was optional
taking null as well, and `additionalProperties: false` on every object.
"""

WRAPPER: Final = "elements"
"""The one property of the object that wraps the array, where a provider takes only an object at the root."""

# The keywords that are known how to rewrite. `description` says nothing a reply is held to, and goes with what it describes.
_KEYWORDS: Final = frozenset({"type", "description", "enum", "const", "properties", "required", "additionalProperties", "items"})
_TYPES: Final = ("array", "boolean", "integer", "null", "number", "object", "string")
_OF_AN_OBJECT: Final = ("properties", "required", "additionalProperties")


@final
@dataclass(frozen=True, slots=True)
class _Rules:
    """What a dialect asks of a schema. A dialect is one row of these, stated in `_rules`."""

    object_at_the_root: bool
    """The array is the one required property of an object."""
    every_property_required: bool
    """Every property is in `required`, and one that was optional takes null as well."""
    every_object_closed: bool
    """Every object states `additionalProperties: false`."""


def _rules(dialect: Dialect) -> _Rules:
    match dialect:
        case "as-written":
            return _Rules(object_at_the_root=False, every_property_required=False, every_object_closed=False)
        case "object-root-all-required":
            return _Rules(object_at_the_root=True, every_property_required=True, every_object_closed=True)


@final
@dataclass(frozen=True, slots=True)
class _LeftOut:
    """Where, in a value held to a rewritten schema, a null stands for a property left out.

    `nulls` names the properties of an object here that were optional and
    were made to take null. `properties` says the same of what is under each
    property, and `items` of each element of an array.
    """

    nulls: frozenset[str]
    properties: Mapping[str, "_LeftOut"]
    items: "_LeftOut | None"


@final
@dataclass(frozen=True, slots=True)
class _Rewritten:
    """One schema as a provider is sent it, the types it names, and where a null in a value held to it stands for a property left out."""

    sent: dict[str, JsonValue]
    types: tuple[str, ...]
    left_out: _LeftOut


def _refuse(what: str, at: str) -> NoReturn:
    raise ValueError(f"The element schema cannot be rewritten: {what} (at {at})")


def _under(at: str, *steps: str) -> str:
    """The JSON Pointer of what is `steps` under `at`."""
    return "/".join((at, *(step.replace("~", "~0").replace("/", "~1") for step in steps)))


def _is_scalar(value: JsonValue) -> bool:
    return value is None or isinstance(value, str | int | float)


def _types(schema: Mapping[str, JsonValue], at: str) -> tuple[str, ...]:
    """The types `schema` names: one, or a list of them."""
    if "type" not in schema:
        _refuse("a schema that states no `type`", at)
    stated = schema["type"]
    named = [stated] if isinstance(stated, str) else stated if isinstance(stated, list) else []
    types = tuple(one for one in named if isinstance(one, str) and one in _TYPES)
    if not types or len(types) != len(named) or len(set(types)) != len(types):
        _refuse(f"`type` is not one of {', '.join(_TYPES)}, or a list of them without repeats", at)
    return types


def _required(schema: Mapping[str, JsonValue], properties: Mapping[str, JsonValue], at: str) -> list[str]:
    """The properties `schema` requires, as it lists them. A schema that states no `required` requires none."""
    if "required" not in schema:
        return []
    stated = schema["required"]
    if not isinstance(stated, list):
        _refuse("`required` is not a list of names without repeats", at)
    names = [one for one in stated if isinstance(one, str)]
    if len(names) != len(stated) or len(set(names)) != len(names):
        _refuse("`required` is not a list of names without repeats", at)
    for name in names:
        if name not in properties:
            _refuse(f"`required` names `{name}`, which `properties` does not have", at)
    return names


def _takes_null(made: _Rewritten) -> bool:
    """Whether null satisfies the schema as its writer wrote it."""
    if "null" not in made.types:
        return False
    enum = made.sent.get("enum")
    if isinstance(enum, list) and None not in enum:
        return False
    return "const" not in made.sent or made.sent["const"] is None


def _or_null(made: _Rewritten) -> dict[str, JsonValue]:
    """The schema of what satisfies `made` or is null.

    A schema that states its type and no more takes null as one more type.
    One that states more (an `enum`, a `const`, an object's properties, an
    array's elements) is one of two: itself, or null. `null` added to its
    types alone would leave its `enum` or its `const` refusing the null.
    """
    if made.sent.keys() <= {"type", "description"}:
        types: list[JsonValue] = [*made.types, "null"]
        return {**made.sent, "type": types}
    return {"anyOf": [made.sent, {"type": "null"}]}


def _rewritten(schema: JsonValue, at: str, rules: _Rules) -> _Rewritten:
    """`schema`, which is at `at` in the element schema, as `rules` have it sent. Raises `ValueError` for what is not rewritten."""
    if not isinstance(schema, dict):
        _refuse("a schema that is not a JSON object", at)
    for keyword in schema:
        if keyword not in _KEYWORDS:
            _refuse(f"`{keyword}` is a keyword this package does not rewrite", at)
    types = _types(schema, at)
    if "description" in schema and not isinstance(schema["description"], str):
        _refuse("`description` is not text", at)
    if "enum" in schema:
        enum = schema["enum"]
        if not isinstance(enum, list) or not enum or not all(_is_scalar(one) for one in enum):
            _refuse("`enum` is not a list of at least one string, number, boolean or null", at)
    if "const" in schema and not _is_scalar(schema["const"]):
        _refuse("`const` is not a string, a number, a boolean or null", at)
    for keyword in _OF_AN_OBJECT:
        if keyword in schema and "object" not in types:
            _refuse(f"`{keyword}` on a schema whose `type` does not name object", at)
    if "items" in schema and "array" not in types:
        _refuse("`items` on a schema whose `type` does not name array", at)

    sent: dict[str, JsonValue] = {keyword: copy.deepcopy(value) for keyword, value in schema.items()}
    nulls: set[str] = set()
    under: dict[str, _LeftOut] = {}
    of_each_element: _LeftOut | None = None

    if "object" in types:
        if "properties" not in schema:
            _refuse("an object that states no `properties`", at)
        properties = schema["properties"]
        if not isinstance(properties, dict):
            _refuse("`properties` is not an object of schemas", at)
        if "additionalProperties" in schema and schema["additionalProperties"] is not False:
            _refuse("`additionalProperties` is not false", at)
        required = _required(schema, properties, at)
        properties_sent: dict[str, JsonValue] = {}
        for name, stated in properties.items():
            here = _under(at, "properties", name)
            made = _rewritten(stated, here, rules)
            under[name] = made.left_out
            properties_sent[name] = made.sent
            if rules.every_property_required and name not in required:
                if _takes_null(made):
                    _refuse(
                        f"the optional property `{name}` takes null of its own, and a null is what stands here for a property left out",
                        here,
                    )
                properties_sent[name] = _or_null(made)
                nulls.add(name)
        sent["properties"] = properties_sent
        if rules.every_property_required:
            # In the order of the properties, which is the order a provider that holds a reply to them writes them in.
            sent["required"] = [*properties]
        if rules.every_object_closed:
            sent["additionalProperties"] = False

    if "array" in types:
        if "items" not in schema:
            _refuse("an array that states no `items`", at)
        elements = _rewritten(schema["items"], _under(at, "items"), rules)
        sent["items"] = elements.sent
        of_each_element = elements.left_out

    return _Rewritten(sent=sent, types=types, left_out=_LeftOut(nulls=frozenset(nulls), properties=under, items=of_each_element))


def _restored(value: JsonValue, where: _LeftOut) -> JsonValue:
    """`value` with each null that stands for a property left out taken out of it.

    Nothing else is changed. A value that is not shaped as its schema says is
    left as it came: whether an element satisfies the schema is its caller's
    to check.
    """
    if isinstance(value, dict):
        return {
            name: _restored(member, where.properties[name]) if name in where.properties else member
            for name, member in value.items()
            if not (member is None and name in where.nulls)
        }
    if isinstance(value, list) and where.items is not None:
        return [_restored(member, where.items) for member in value]
    return value


@final
@dataclass(frozen=True, slots=True)
class ArraySchema:
    """What a provider is sent for an array of elements, and the reading back of what it answers."""

    sent: dict[str, JsonValue]
    """The schema the provider is sent."""
    _wrapped: bool
    _left_out: _LeftOut

    def read(self, text: str, stop_reason: str) -> list[JsonValue]:
        """The elements of the provider's answer `text`, each as a provider that takes the schema as written would have written it.

        Raises `StructuredReadError`, carrying `stop_reason`, for text that
        is not JSON, and for JSON that is not what was asked for: where the
        array was to be wrapped, an answer with no wrapper, or one whose
        wrapper holds something that is not an array. None of them is read
        as an empty array.
        """
        if not self._wrapped:
            return [_restored(element, self._left_out) for element in read_array(text, stop_reason)]
        answer = read_json(text, stop_reason)
        if not isinstance(answer, dict):
            raise StructuredReadError(f"parsed to {kind(answer)}, not the object asked for", stop_reason)
        if WRAPPER not in answer:
            raise StructuredReadError(f"the object has no `{WRAPPER}`", stop_reason)
        elements = answer[WRAPPER]
        if not isinstance(elements, list):
            raise StructuredReadError(f"`{WRAPPER}` parsed to {kind(elements)}, not an array", stop_reason)
        return [_restored(element, self._left_out) for element in elements]


def array_schema(element_schema: ElementSchema, dialect: Dialect) -> ArraySchema:
    """What a provider that takes schemas in `dialect` is sent for an array of elements of `element_schema`.

    Raises `ValueError` for an element schema that is not rewritten, naming
    what in it is not and where. `element_schema` is not changed, and what is
    sent shares nothing with it.
    """
    rules = _rules(dialect)
    element = _rewritten(dict(element_schema), "#", rules)
    array: dict[str, JsonValue] = {"type": "array", "items": element.sent}
    if not rules.object_at_the_root:
        return ArraySchema(sent=array, _wrapped=False, _left_out=element.left_out)
    wrapper: dict[str, JsonValue] = {"type": "object", "properties": {WRAPPER: array}, "required": [WRAPPER], "additionalProperties": False}
    return ArraySchema(sent=wrapper, _wrapped=True, _left_out=element.left_out)
