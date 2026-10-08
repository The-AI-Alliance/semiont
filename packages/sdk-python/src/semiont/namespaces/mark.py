"""Mark: annotations, a resource's own metadata, and the annotating of a resource delegated as a job.

Each write is confirmed: it resolves when the knowledge base says it is
recorded, and fails with the failure it answered. What changed then arrives
on the `browse` queries.
"""

from collections.abc import Sequence
from typing import Final, final

from semiont.channel import Empty
from semiont.channels import (
    MARK_CANCEL_PENDING,
    MARK_DELEGATE_REQUEST,
    MARK_DELETE_ERROR,
    MARK_PROGRESS_DISMISS,
    MARK_REQUESTED,
    MARK_SUBMIT,
)
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import stated
from semiont.namespaces.follow import Delegation, follow
from semiont.namespaces.links import Links
from semiont.operations import MARK_ARCHIVE, MARK_CREATE_REQUEST, MARK_DELETE, MARK_UNARCHIVE, MARK_UPDATE_ENTITY_TYPES
from semiont.types import (
    AnnotationSelector,
    CreateAnnotationRequest,
    MarkArchiveCommand,
    MarkCreateOkResponse,
    MarkCreateRequest,
    MarkDelegateRequestEvent,
    MarkDeleteCommand,
    MarkJobCompleteCommand,
    MarkJobCreateCommand,
    MarkJobParams,
    MarkRequestedEvent,
    MarkSubmitEvent,
    MarkUnarchiveCommand,
    MarkUpdateEntityTypesCommand,
    Motivation,
    ResourceErrorEvent,
)

__all__ = ["MarkNamespace"]


@final
class MarkNamespace:
    """See the module's documentation."""

    def __init__(self, links: Links) -> None:
        self._links: Final = links

    async def annotation(self, request: CreateAnnotationRequest) -> MarkCreateOkResponse:
        """Create an annotation on the resource its target names."""
        created = await self._links.request(MARK_CREATE_REQUEST, MarkCreateRequest(resource_id=request.target.source, request=request))
        return created.response

    async def delete(self, resource_id: ResourceId, annotation_id: AnnotationId) -> None:
        """Delete an annotation."""
        await self._links.request(MARK_DELETE, MarkDeleteCommand(annotation_id=annotation_id, resource_id=resource_id))

    async def archive(self, resource_id: ResourceId) -> None:
        """Archive a resource."""
        await self._links.request(MARK_ARCHIVE, MarkArchiveCommand(resource_id=resource_id))

    async def unarchive(self, resource_id: ResourceId) -> None:
        """Bring an archived resource back."""
        await self._links.request(MARK_UNARCHIVE, MarkUnarchiveCommand(resource_id=resource_id))

    async def update_entity_types(self, resource_id: ResourceId, current: Sequence[str], updated: Sequence[str]) -> None:
        """Replace a resource's own entity types: `current` is what it has now, `updated` the whole set it is to have."""
        await self._links.request(
            MARK_UPDATE_ENTITY_TYPES,
            MarkUpdateEntityTypesCommand(resource_id=resource_id, current_entity_types=list(current), updated_entity_types=list(updated)),
        )

    def delegate(self, resource_id: ResourceId, params: MarkJobParams) -> Delegation[MarkJobCompleteCommand]:
        """Delegate the annotating of a resource, as a `mark` job: its progress, any attempt that will be tried again, and its completion.

        `params` is the job's parameters, one shape for each motivation, and
        its `motivation` says which. An option of it given as `None` is an
        option not given.
        """
        create = MarkJobCreateCommand(job_type="mark", resource_id=resource_id, params=stated(params))
        return follow(self._links, create, MarkJobCompleteCommand, resource_id=resource_id, stall_ms=None)

    def request(self, source: ResourceId, selector: AnnotationSelector, motivation: Motivation) -> None:
        """Signal: a new annotation is wanted on `source`."""
        self._links.signal(MARK_REQUESTED, MarkRequestedEvent(source=source, selector=selector, motivation=motivation))

    def request_delegate(self, params: MarkJobParams) -> None:
        """Signal: the annotating of the open resource is to be delegated, as a `mark` job of these parameters.

        They are the ones `delegate` takes. The client's own state runs it.
        """
        self._links.signal(MARK_DELEGATE_REQUEST, MarkDelegateRequestEvent(params=params))

    def submit(self, event: MarkSubmitEvent) -> None:
        """Signal: submit the annotation that is pending."""
        self._links.signal(MARK_SUBMIT, event)

    def cancel_pending(self) -> None:
        """Signal: drop the annotation that is pending."""
        self._links.signal(MARK_CANCEL_PENDING, Empty())

    def dismiss_progress(self) -> None:
        """Signal: dismiss the display of a delegated job's progress."""
        self._links.signal(MARK_PROGRESS_DISMISS, Empty())

    def report_delete_error(self, event: ResourceErrorEvent) -> None:
        """Signal: a delete failed where nothing could show it. Said by whoever awaited `delete`, which knows the resource."""
        self._links.signal(MARK_DELETE_ERROR, event)
