"""A pointer's dwell: an annotation is hovered once the pointer has rested on it, and no longer the moment it leaves.

A pointer crossing the page hovers nothing on its way. `say` is told each
change: the annotation hovered, or none. `client.beckon.hover` is what it is
usually given, and `semiont.timing.HOVER_DELAY_MS` the delay, unless the viewer
was told another. Disposing it forgets a rest that has not run its time, and it
says nothing more.
"""

import asyncio
from collections.abc import Callable
from types import TracebackType
from typing import Final, Self, final, override

from semiont.identifiers import AnnotationId
from semiont.state_unit import StateUnit

__all__ = ["HoverDwell"]


@final
class HoverDwell(StateUnit):
    """See the module's documentation. Its rest is a timer of the running loop."""

    def __init__(self, say: Callable[[AnnotationId | None], object], delay_ms: int) -> None:
        self._say: Final = say
        self._delay: Final = delay_ms / 1000
        self._hovering: AnnotationId | None = None
        """What was last said to be hovered."""
        self._resting: asyncio.TimerHandle | None = None
        """The rest that has not run its time yet."""
        self._disposed = False

    def enter(self, annotation_id: AnnotationId) -> None:
        """The pointer is on an annotation: hovered once the pointer has stayed for the delay. One already hovered is not said again."""
        if self._disposed or self._hovering == annotation_id:
            return
        self._interrupt()
        self._resting = asyncio.get_running_loop().call_later(self._delay, self._rested, annotation_id)

    def leave(self) -> None:
        """The pointer left. Said at once, and only when something was hovered."""
        if self._disposed:
            return
        self._interrupt()
        if self._hovering is not None:
            self._hovering = None
            self._say(None)

    def _rested(self, annotation_id: AnnotationId) -> None:
        self._resting = None
        self._hovering = annotation_id
        self._say(annotation_id)

    def _interrupt(self) -> None:
        if self._resting is not None:
            self._resting.cancel()
            self._resting = None

    @override
    def dispose(self) -> None:
        self._disposed = True
        self._interrupt()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.dispose()
