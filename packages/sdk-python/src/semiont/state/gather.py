"""Gathering, as state: the context around an annotation of one resource, and the context around a whole resource.

Each is held with whether it is being gathered and the failure it met. The two
are held apart because both can be in flight at once. Each is asked of the unit
itself (`gather_annotation`, `gather_resource`), so a gather asked of one
resource's unit reaches no other.

A new request clears what the last one left. Requests are not cancelled by the
next: each lands when it is answered.
"""

from collections.abc import Awaitable, Callable, Sequence
from types import TracebackType
from typing import Final, Self, final, override

from semiont._reading import Reading
from semiont.client import SemiontClient
from semiont.errors import SemiontError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.state._tasks import Tasks
from semiont.state_unit import StateUnit
from semiont.transport import Transport
from semiont.types import GatheredContext
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

    async def land(self, start: Callable[[], Awaitable[GatheredContext]]) -> None:
        """Hold what the gather `start` begins comes to: the context is there before the gather is said to be over, for a reader told so."""
        try:
            # Begun here, not by the caller: a task cancelled before its first turn never enters
            # this body, and would leave what it was handed unawaited.
            self.context.set(await start())
        except SemiontError as error:
            self.error.set(error)
        self.loading.set(False)

    def end(self) -> None:
        self.context.end()
        self.loading.end()
        self.error.end()


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

    def gather_annotation(self, annotation_id: AnnotationId, *, context_window: int = 2000) -> None:
        """Gather the context around an annotation of this unit's resource, with what `client.gather.annotation` takes."""
        if self._disposed:
            return
        self._annotation.begin()
        self._annotation_id.set(annotation_id)
        self._tasks.run(self._annotation.land(lambda: self._gather_annotation(annotation_id, context_window)))

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
        self._tasks.run(
            self._resource.land(
                lambda: self._client.gather.resource(
                    resource_id,
                    depth=depth,
                    max_resources=max_resources,
                    include_content=include_content,
                    include_summary=include_summary,
                    exclude_entity_types=exclude_entity_types,
                )
            )
        )

    async def _gather_annotation(self, annotation_id: AnnotationId, context_window: int) -> GatheredContext:
        complete = await self._client.gather.annotation(self._resource_id, annotation_id, context_window=context_window)
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
