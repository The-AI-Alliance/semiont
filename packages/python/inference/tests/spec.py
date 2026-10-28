"""Where the repository around this package is, for the tests that hold the package to it."""

from pathlib import Path

from pydantic import JsonValue, TypeAdapter

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]
SPEC = ROOT / "specs/src"
SDK = ROOT / "packages/sdk-python"
WORKER_SERVICE_SUITE = ROOT / "tests/conformance/worker-service"

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


def strings(value: JsonValue, what: str) -> list[str]:
    """`value`, which is a list of text."""
    assert isinstance(value, list), f"{what} is not a list"
    found: list[str] = []
    for item in value:
        assert isinstance(item, str), f"{what} holds something that is not text"
        found.append(item)
    return found


def text(value: JsonValue, what: str) -> str:
    """`value`, which is text."""
    assert isinstance(value, str), f"{what} is not text"
    return value


def thing(value: JsonValue, what: str) -> JsonObject:
    """`value`, which is an object."""
    assert isinstance(value, dict), f"{what} is not an object"
    return value
