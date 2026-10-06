"""A query of the knowledge base.

Building one sends nothing. `fresh` asks the service now and gives its
answer; a failure is raised.
"""

from collections.abc import Awaitable, Callable
from typing import Final, final

__all__ = ["Cached"]


@final
class Cached[T]:
    """See the module's documentation. Made with what asks the service."""

    def __init__(self, ask: Callable[[], Awaitable[T]]) -> None:
        self._ask: Final = ask

    async def fresh(self) -> T:
        """Ask the service now, whatever was answered before, and give its answer."""
        return await self._ask()
