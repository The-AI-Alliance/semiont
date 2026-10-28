"""What a state unit is: a long-running flow, held as state a consumer reads and watches.

The pattern is `docs/builder/STATE-UNITS.md`'s, kept by every Semiont SDK. A
unit's consumers read it and never write it; it is moved by its methods and by
what it hears on the client's own bus; and it ends by `dispose`.

Each of this package's units names `StateUnit` as its base, as `EventBus` names
`FrameSink`, so that both type checkers hold it to the protocol and a census can
find it in the source.
"""

from typing import Protocol

__all__ = ["StateUnit"]


class StateUnit(Protocol):
    """See the module's documentation."""

    def dispose(self) -> None:
        """End the unit. Calling it again does nothing more.

        When it returns, every state the unit holds has ended, everything it
        had running has been cancelled, and nothing it is told afterwards does
        anything. What the unit was given, such as the client it was built
        over, is not its to end.
        """
        ...
