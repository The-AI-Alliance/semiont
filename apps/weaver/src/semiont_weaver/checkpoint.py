"""The Weaver's marks, kept across a restart.

`docs/protocol/WEAVER.md` § What it has applied: a Weaver may keep its marks,
so that when it starts again catch-up applies only what was recorded since.
What is kept is never a correctness input. A Weaver that finds nothing kept,
or finds what it cannot read, applies the whole record again and ends with
the same graph.
"""

import asyncio
import json
import os
from pathlib import Path
from typing import Final, final

from pydantic import JsonValue, TypeAdapter

__all__ = ["Checkpoint"]

_KEPT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


@final
class Checkpoint:
    """The marks, in one file. Reading and writing it is done off the loop."""

    def __init__(self, path: Path) -> None:
        self._path: Final = path

    def _read(self) -> dict[str, int]:
        try:
            kept = _KEPT.validate_json(self._path.read_bytes())
        except (OSError, ValueError):
            # Nothing kept, or nothing readable as marks: either way the answer is the whole record again.
            return {}
        return {resource: sequence for resource, sequence in kept.items() if isinstance(sequence, int) and not isinstance(sequence, bool)}

    def _write(self, marks: dict[str, int]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # Written beside the file and moved over it, so that a process killed while writing leaves the marks it had.
        beside = self._path.with_name(self._path.name + ".tmp")
        beside.write_text(json.dumps(marks), encoding="utf-8")
        os.replace(beside, self._path)

    async def load(self) -> dict[str, int]:
        """The marks kept. None where nothing is kept, or what is kept cannot be read."""
        return await asyncio.to_thread(self._read)

    async def save(self, marks: dict[str, int]) -> None:
        """Keep the marks. Raises `OSError` where they cannot be written."""
        await asyncio.to_thread(self._write, marks)
