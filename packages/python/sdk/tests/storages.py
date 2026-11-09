"""Storages a test gives what a client keeps, beyond the one in memory: one that refuses writes."""

from collections.abc import Callable
from typing import Final, final, override

from semiont.storage import MemoryStorage, SessionStorage


@final
class Refusing(SessionStorage):
    """A storage in memory that refuses writes under `refused`, as a full one would, and takes every other.

    It refuses the first `times` of them, and takes every write after; with `times` none, it refuses every one.
    """

    def __init__(self, refused: str, *, times: int | None) -> None:
        self._held: Final = MemoryStorage()
        self._refused: Final = refused
        self._times: Final = times
        self.refusals = 0
        """How many writes it refused."""

    @override
    def get(self, key: str) -> str | None:
        return self._held.get(key)

    @override
    def set(self, key: str, value: str) -> None:
        if key == self._refused and (self._times is None or self.refusals < self._times):
            self.refusals += 1
            raise OSError("the storage is full")
        self._held.set(key, value)

    @override
    def delete(self, key: str) -> None:
        self._held.delete(key)

    @override
    def update(self, key: str, change: Callable[[str | None], str | None]) -> None:
        after = change(self.get(key))
        if after is None:
            self.delete(key)
        else:
            self.set(key, after)

    @override
    def subscribe(self, on_change: Callable[[str, str | None], None]) -> Callable[[], None] | None:
        return None
