"""Reading a model's reply as the JSON it was asked for. Every driver, and the mock, reads one this way."""

import json
from typing import NoReturn

from pydantic import JsonValue

from semiont_inference.interface import StructuredReadError


def _refuse(constant: str) -> NoReturn:
    # `NaN` and the infinities are not JSON, and the standard library's parser takes them unless told not to.
    raise ValueError(f"{constant} is not JSON")


def kind(value: JsonValue) -> str:
    """What JSON calls `value`."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def read_json(text: str, stop_reason: str) -> JsonValue:
    """`text` as the JSON it is. Raises `StructuredReadError`, carrying `stop_reason`, for text that is not JSON.

    A reply cut off by its budget arrives here as JSON that does not parse,
    and its stop reason says so.
    """
    try:
        parsed: JsonValue = json.loads(text, parse_constant=_refuse)
    except ValueError as error:
        raise StructuredReadError("response is not valid JSON", stop_reason) from error
    return parsed


def read_array(text: str, stop_reason: str) -> list[JsonValue]:
    """`text` as the array it is. Raises `StructuredReadError`, carrying `stop_reason`, for anything else.

    Whatever does not read as an array raises, and is never taken for an
    empty one: "the model could not be read" and "the model found nothing"
    are different results.
    """
    parsed = read_json(text, stop_reason)
    if not isinstance(parsed, list):
        raise StructuredReadError(f"parsed to {kind(parsed)}, not an array", stop_reason)
    return parsed
