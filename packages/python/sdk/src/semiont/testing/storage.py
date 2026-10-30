"""A storage several contexts share, for tests of what one context does when another writes.

Each context is a handle on the same stored values, and hears what the others
write, never what it wrote itself. That is how two windows on one browser
storage, and two processes on one file, see each other.
"""

from collections.abc import Callable
from typing import Final, final, override

from semiont.storage import SessionStorage

__all__ = ["SharedStorage"]


@final
class _Shared:
    """What every context's handle reads and writes, and who listens from which context."""

    def __init__(self) -> None:
        self.stored: Final[dict[str, str]] = {}
        self.listeners: Final[dict[int, tuple[int, Callable[[str, str | None], None]]]] = {}
        self.contexts = 0
        self.subscriptions = 0


@final
class SharedStorage(SessionStorage):
    """One context's handle on a storage several share: see the module's documentation.

    Made holding nothing, as the first context's handle; `context` is
    another's.
    """

    def __init__(self) -> None:
        self._shared = _Shared()
        self._context = 0

    def context(self) -> "SharedStorage":
        """Another context's handle on the same storage."""
        self._shared.contexts += 1
        other = SharedStorage()
        other._shared = self._shared
        other._context = self._shared.contexts
        return other

    def _tell(self, key: str, value: str | None) -> None:
        """Tell the other contexts' listeners of a change."""
        for context, heard in list(self._shared.listeners.values()):
            if context != self._context:
                heard(key, value)

    @override
    def get(self, key: str) -> str | None:
        return self._shared.stored.get(key)

    @override
    def set(self, key: str, value: str) -> None:
        self._shared.stored[key] = value
        self._tell(key, value)

    @override
    def delete(self, key: str) -> None:
        self._shared.stored.pop(key, None)
        self._tell(key, None)

    @override
    def update(self, key: str, change: Callable[[str | None], str | None]) -> None:
        after = change(self._shared.stored.get(key))
        if after is None:
            self._shared.stored.pop(key, None)
        else:
            self._shared.stored[key] = after
        self._tell(key, after)

    @override
    def subscribe(self, on_change: Callable[[str, str | None], None]) -> Callable[[], None] | None:
        self._shared.subscriptions += 1
        subscription = self._shared.subscriptions
        self._shared.listeners[subscription] = (self._context, on_change)

        def stop() -> None:
            self._shared.listeners.pop(subscription, None)

        return stop
