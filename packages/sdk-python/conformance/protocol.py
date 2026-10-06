"""The driver protocol of `tests/conformance/sdk`, as a program speaks it.

A driver is a process. The suite writes one JSON object to its stdin per line
and reads one from its stdout per line. This is the part every driver shares:
it says it is ready, answers each operation once, and exits 0 when its stdin
ends. An operation it has no way to perform is answered `unsupported` at once,
before the next is read.
"""

import sys
from collections.abc import Mapping

from pydantic import BaseModel, JsonValue, TypeAdapter

__all__ = ["Asked", "say", "serve"]


class Asked(BaseModel, frozen=True, extra="allow"):
    """One operation the suite asks for: `{"id": 7, "op": "emit", ...arguments}`."""

    id: int
    op: str


_LINE = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


def say(line: Mapping[str, JsonValue]) -> None:
    """Write one line of the protocol."""
    sys.stdout.write(_LINE.dump_json(dict(line)).decode() + "\n")
    sys.stdout.flush()


def serve() -> int:
    """Answer the suite until its stdin ends. Returns the process's exit status."""
    say({"ready": True})
    for line in sys.stdin:
        asked = Asked.model_validate_json(line)
        say({"id": asked.id, "unsupported": True})
    return 0
