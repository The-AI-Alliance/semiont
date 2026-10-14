"""A unit's state as its readers are given it."""

from collections.abc import AsyncIterator
from typing import Final, final, override

from semiont.watched import Variable, Watched

__all__ = ["Reading"]


@final
class Reading[T](Watched[T]):
    """A state's value and its changes, and nothing that sets or ends it.

    A unit holds each state in a `Variable` of its own and hands out this view
    of it, so a reader cannot write past the unit's logic.
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
