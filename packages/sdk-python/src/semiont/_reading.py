"""A state as its readers are given it: what the SDK hands out of each `Variable` it holds."""

from collections.abc import AsyncIterator
from typing import Final, final, override

from semiont.watched import Variable, Watched

__all__ = ["Reading"]


@final
class Reading[T](Watched[T]):
    """A state's value and its changes, and nothing that sets or ends it.

    Whatever holds a state in a `Variable` (a state unit, the session, a
    transport, a held job) hands out this view of it, so a reader cannot write
    past what holds it.
    """

    def __init__(self, held: Variable[T]) -> None:
        self._held: Final = held

    @property
    @override
    def value(self) -> T:
        return self._held.value

    @override
    def __aiter__(self) -> AsyncIterator[T]:
        return aiter(self._held)
