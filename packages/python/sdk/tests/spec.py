"""Where the spec is, for the tests that hold this package to it."""

from pathlib import Path

from pydantic import JsonValue, TypeAdapter

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]
SPEC = ROOT / "specs/src"
BUNDLED = ROOT / "specs/openapi.json"

type JsonObject = dict[str, JsonValue]

_JSON = TypeAdapter[JsonValue](JsonValue)


def read(path: Path) -> JsonObject:
    """The JSON object a file of the spec holds."""
    value = _JSON.validate_json(path.read_bytes())
    assert isinstance(value, dict), f"{path} is not a JSON object"
    return value


def objects(value: JsonValue, what: str) -> list[JsonObject]:
    """`value`, which is a list of objects."""
    assert isinstance(value, list), f"{what} is not a list"
    found: list[JsonObject] = []
    for item in value:
        assert isinstance(item, dict), f"{what} holds something that is not an object"
        found.append(item)
    return found


def strings(value: JsonValue, what: str) -> list[str]:
    """`value`, which is a list of text."""
    assert isinstance(value, list), f"{what} is not a list"
    return [text(item, f"an item of {what}") for item in value]


def text(value: JsonValue, what: str) -> str:
    """`value`, which is text."""
    assert isinstance(value, str), f"{what} is not text"
    return value
