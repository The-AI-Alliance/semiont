"""Where the repository around this project is, for the tests that hold the project to it, and how a case table of it is read.

The Librarian's case tables are in `specs/src/librarian`. A runner names its
table's path whole, in its own file.
"""

from collections.abc import Iterable
from pathlib import Path

from pydantic import JsonValue, TypeAdapter

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]
SPEC = ROOT / "specs/src"
SDK = ROOT / "packages/sdk-python"

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


def whole(value: JsonValue, what: str) -> int:
    """`value`, which is a whole number."""
    assert isinstance(value, int), f"{what} is not a whole number"
    assert not isinstance(value, bool), f"{what} is not a whole number"
    return value


def number(value: JsonValue, what: str) -> float:
    """`value`, which is a number, whole or not."""
    assert isinstance(value, int | float), f"{what} is not a number"
    assert not isinstance(value, bool), f"{what} is not a number"
    return float(value)


def only(stated: JsonObject, known: Iterable[str], what: str) -> None:
    """Fail for a member of `stated` that is none of `known`: nothing of the runner that asks would read it."""
    unread = sorted(set(stated) - set(known))
    assert unread == [], f"{what} states {unread}, which nothing here reads"


def why(case: JsonObject) -> str:
    """Why a case is a case: what tells it from the others of its table."""
    return text(case["why"], "why")
