"""Where the repository around this project is, for the tests that hold the project to it, and how a case table of it is read."""

from pathlib import Path

from pydantic import JsonValue, TypeAdapter

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[2]
SPEC = ROOT / "specs/src"
SDK = ROOT / "packages/python/sdk"

type JsonObject = dict[str, JsonValue]

_OBJECT = TypeAdapter[JsonObject](JsonObject)


def read(path: Path) -> JsonObject:
    """The JSON object a file holds."""
    return _OBJECT.validate_json(path.read_bytes())


def objects(value: JsonValue, what: str) -> list[JsonObject]:
    """`value`, which is a list of objects."""
    assert isinstance(value, list), f"{what} is not a list"
    found: list[JsonObject] = []
    for item in value:
        assert isinstance(item, dict), f"{what} holds something that is not an object"
        found.append(item)
    return found


def text(value: JsonValue, what: str) -> str:
    """`value`, which is text."""
    assert isinstance(value, str), f"{what} is not text"
    return value
