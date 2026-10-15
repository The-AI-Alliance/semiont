"""Attention, as this viewer's state: which annotation is hovered.

It hears the viewer's hover (`client.beckon.hover`) and holds it, and sparkles
an annotation the moment it is hovered. It hears an annotation opened, by this
viewer or by another participant driving it, and turns the viewer's focus to it.
"""

from types import TracebackType
from typing import Final, Self, final, override

from pydantic import ValidationError

from semiont._reading import Reading
from semiont.bus import decoded
from semiont.channels import BECKON_FOCUS, BECKON_HOVER, BECKON_SPARKLE, BROWSE_CLICK
from semiont.client import SemiontClient
from semiont.events import Events
from semiont.identifiers import AnnotationId
from semiont.state._tasks import Tasks
from semiont.state_unit import StateUnit
from semiont.transport import Frame, Transport
from semiont.types import BeckonFocusEvent, BeckonSparkleEvent
from semiont.watched import Variable, Watched

__all__ = ["BeckonStateUnit"]


@final
class BeckonStateUnit(StateUnit):
    """See the module's documentation."""

    def __init__(self, client: SemiontClient[Transport]) -> None:
        self._client: Final = client
        self._hovered: Final = Variable[AnnotationId | None](None)
        self._tasks: Final = Tasks()
        self._disposed = False
        # One reader of both, taken now, so what is said from here on is heard in the order it was said.
        self._tasks.run(self._listen(client.bus.frames_among([BECKON_HOVER.name, BROWSE_CLICK.name])))

    @property
    def hovered_annotation_id(self) -> Watched[AnnotationId | None]:
        """The annotation this viewer hovers, or none."""
        return Reading(self._hovered)

    def focus(self, annotation_id: AnnotationId) -> None:
        """Signal: turn this viewer's focus to an annotation."""
        if not self._disposed:
            self._client.bus.publish(BECKON_FOCUS, BeckonFocusEvent(annotation_id=annotation_id))

    async def _listen(self, heard: Events[Frame]) -> None:
        async with heard:
            async for frame in heard:
                try:
                    self._heard(frame)
                except ValidationError:
                    # A frame that is not its channel's is nobody's to act on.
                    continue

    def _heard(self, frame: Frame) -> None:
        if frame.channel == BECKON_HOVER.name:
            hovered = decoded(BECKON_HOVER, frame.payload).annotation_id
            self._hovered.set(hovered)
            if hovered is not None:
                self._client.bus.publish(BECKON_SPARKLE, BeckonSparkleEvent(annotation_id=hovered))
        else:
            self.focus(decoded(BROWSE_CLICK, frame.payload).annotation_id)

    @override
    def dispose(self) -> None:
        self._disposed = True
        self._tasks.stop()
        self._hovered.end()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.dispose()
        await self._tasks.ended()
