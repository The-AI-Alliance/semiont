"""Gathering, as state: the context around an annotation of one resource, and the context around a whole resource.

Each is held with whether it is being gathered and the failure it met. The two
are held apart because both can be in flight at once. An annotation's is asked
for by a signal (`gather:requested` on the client's own bus), since what asks
is far from what shows it; a resource's is asked for by a method, since what
asks holds the unit.

A new request clears what the last one left. Requests are not cancelled by the
next: each lands when it is answered.
"""

from collections.abc import Awaitable, Sequence
from types import TracebackType
from typing import Final, Self, TypedDict, final, override

from semiont.bus import Typed
from semiont.channels import GATHER_REQUESTED
from semiont.client import SemiontClient
from semiont.errors import SemiontError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.state._reading import Reading
from semiont.state._tasks import Tasks
from semiont.state_unit import StateUnit
from semiont.transport import Transport
from semiont.types import GatherAnnotationRequest, GatheredContext
from semiont.watched import Variable, Watched

__all__ = ["GatherStateUnit"]


@final
class _Slot:
    """One gather's state."""

    def __init__(self) -> None:
        self.context: Final = Variable[GatheredContext | None](None)
        self.loading: Final = Variable(False)
        self.error: Final = Variable[SemiontError | None](None)

    def begin(self) -> None:
        self.loading.set(True)
        self.error.set(None)
        self.context.set(None)

    async def land(self, gathering: Awaitable[GatheredContext]) -> None:
        """Hold what `gathering` comes to: the context is there before the gather is said to be over, for a reader told so."""
        try:
            self.context.set(await gathering)
        except SemiontError as error:
            self.error.set(error)
        self.loading.set(False)

    def end(self) -> None:
        self.context.end()
        self.loading.end()
        self.error.end()


class _Window(TypedDict, total=False):
    """The window a request states. One it leaves out is the namespace's to choose."""

    context_window: int


def _window(request: GatherAnnotationRequest) -> _Window:
    window: _Window = {}
    if request.options is not None and request.options.context_window is not None:
        window["context_window"] = request.options.context_window
    return window


@final
class GatherStateUnit(StateUnit):
    """See the module's documentation. It gathers the annotations of `resource_id`, and any resource."""

    def __init__(self, client: SemiontClient[Transport], resource_id: ResourceId) -> None:
        self._client: Final = client
        self._resource_id: Final = resource_id
        self._annotation: Final = _Slot()
        self._annotation_id: Final = Variable[AnnotationId | None](None)
        self._resource: Final = _Slot()
        self._tasks: Final = Tasks()
        self._disposed = False
        # Taken now, so that a gather asked for from here on is heard.
        self._tasks.run(self._listen(client.bus.frames(GATHER_REQUESTED)))

    @property
    def context(self) -> Watched[GatheredContext | None]:
        """The context around the annotation last asked about."""
        return Reading(self._annotation.context)

    @property
    def loading(self) -> Watched[bool]:
        return Reading(self._annotation.loading)

    @property
    def error(self) -> Watched[SemiontError | None]:
        return Reading(self._annotation.error)

    @property
    def annotation_id(self) -> Watched[AnnotationId | None]:
        """The annotation last asked about."""
        return Reading(self._annotation_id)

    @property
    def resource_context(self) -> Watched[GatheredContext | None]:
        """The context around the resource last asked about."""
        return Reading(self._resource.context)

    @property
    def resource_loading(self) -> Watched[bool]:
        return Reading(self._resource.loading)

    @property
    def resource_error(self) -> Watched[SemiontError | None]:
        return Reading(self._resource.error)

    def gather_resource(
        self,
        resource_id: ResourceId,
        *,
        depth: int = 2,
        max_resources: int = 10,
        include_content: bool = True,
        include_summary: bool = False,
        exclude_entity_types: Sequence[str] = (),
    ) -> None:
        """Gather the context around a whole resource, with what `client.gather.resource` takes."""
        if self._disposed:
            return
        self._resource.begin()
        gathering = self._client.gather.resource(
            resource_id,
            depth=depth,
            max_resources=max_resources,
            include_content=include_content,
            include_summary=include_summary,
            exclude_entity_types=exclude_entity_types,
        )
        self._tasks.run(self._resource.land(gathering))

    async def _listen(self, heard: Typed[GatherAnnotationRequest]) -> None:
        async with heard:
            async for asked in heard:
                request = asked.payload
                self._annotation.begin()
                self._annotation_id.set(request.annotation_id)
                self._tasks.run(self._annotation.land(self._gather_annotation(request)))

    async def _gather_annotation(self, request: GatherAnnotationRequest) -> GatheredContext:
        complete = await self._client.gather.annotation(self._resource_id, request.annotation_id, **_window(request))
        return complete.response

    @override
    def dispose(self) -> None:
        self._disposed = True
        self._tasks.stop()
        self._annotation.end()
        self._annotation_id.end()
        self._resource.end()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.dispose()
        await self._tasks.ended()
