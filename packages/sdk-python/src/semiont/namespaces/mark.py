"""Mark: annotations, a resource's own metadata, and AI assistance.

Each write is confirmed: it resolves when the knowledge base says it is
recorded, and fails with the failure it answered. What changed then arrives
on the `browse` queries.
"""

from collections.abc import Sequence
from typing import Annotated, Final, final

from pydantic import Field

from semiont.channel import Empty
from semiont.channels import (
    MARK_ASSIST_REQUEST,
    MARK_CANCEL_PENDING,
    MARK_DELETE_ERROR,
    MARK_PROGRESS_DISMISS,
    MARK_REQUESTED,
    MARK_SUBMIT,
)
from semiont.errors import BusRequestError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import WireModel
from semiont.namespaces.follow import JobEvent, follow
from semiont.namespaces.links import Links
from semiont.operations import MARK_ARCHIVE, MARK_CREATE_REQUEST, MARK_DELETE, MARK_UNARCHIVE, MARK_UPDATE_ENTITY_TYPES
from semiont.running import Running
from semiont.types import (
    AnnotationSelector,
    CreateAnnotationRequest,
    JobCreateCommand,
    JobType,
    MarkArchiveCommand,
    MarkAssistRequestEvent,
    MarkAssistRequestEventOptions,
    MarkCreateOkResponse,
    MarkCreateRequest,
    MarkDeleteCommand,
    MarkRequestedEvent,
    MarkSubmitEvent,
    MarkUnarchiveCommand,
    MarkUpdateEntityTypesCommand,
    Motivation,
    ResourceErrorEvent,
)

__all__ = ["MarkAssistOptions", "MarkNamespace"]


@final
class MarkAssistOptions(WireModel, frozen=True):
    """What an assist is asked to do, beyond its motivation.

    Each option that is stated becomes a parameter of the job under its own name.
    """

    entity_types: Annotated[Sequence[str] | None, Field(alias="entityTypes")] = None
    """The entity types to look for. Linking requires at least one."""
    include_descriptive_references: Annotated[bool | None, Field(alias="includeDescriptiveReferences")] = None
    instructions: str | None = None
    density: float | None = None
    tone: str | None = None
    language: str | None = None
    """The language the annotations' own text is written in. BCP 47."""
    source_language: Annotated[str | None, Field(alias="sourceLanguage")] = None
    """The language of the resource being read. BCP 47."""
    schema_id: Annotated[str | None, Field(alias="schemaId")] = None
    """The tag schema to tag with. Tagging requires it."""
    categories: Sequence[str] | None = None
    """The schema's categories to tag with. Tagging requires at least one."""


_JOB_OF: Final[dict[Motivation, JobType]] = {
    "tagging": "tag-annotation",
    "linking": "reference-annotation",
    "highlighting": "highlight-annotation",
    "assessing": "assessment-annotation",
    "commenting": "comment-annotation",
}


def _refused(message: str) -> BusRequestError:
    return BusRequestError("bus.rejected", message)


def _assist_job(resource_id: ResourceId, motivation: Motivation, options: MarkAssistOptions) -> JobCreateCommand:
    """The job an assist of `motivation` creates, once its options are what that job needs.

    Refused here with what the dispatcher would answer later.
    """
    if motivation == "tagging":
        if not options.schema_id:
            raise _refused('mark.assist with motivation "tagging" requires options.schemaId')
        if not options.categories:
            raise _refused('mark.assist with motivation "tagging" requires a non-empty options.categories array')
    if motivation == "linking" and not options.entity_types:
        raise _refused('mark.assist with motivation "linking" requires a non-empty entityTypes array')
    return JobCreateCommand(
        job_type=_JOB_OF[motivation], resource_id=resource_id, params=options.model_dump(mode="json", exclude_none=True)
    )


async def _refuse(refusal: BusRequestError) -> JobEvent:
    raise refusal


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

    def assist(self, resource_id: ResourceId, motivation: Motivation, options: MarkAssistOptions) -> Running[JobEvent]:
        """Have a model annotate a resource: the job's progress, any attempt that failed and will be tried again, and its completion.

        Options the job cannot run without are refused when the operation is
        awaited or read, as every other failure of it is.
        """
        try:
            create = _assist_job(resource_id, motivation, options)
        except BusRequestError as refusal:
            refused = refusal
            return Running(lambda _: self._links.run(_refuse(refused)))
        return follow(self._links, create, resource_id=resource_id, stall_ms=None)

    def request(self, source: ResourceId, selector: AnnotationSelector, motivation: Motivation) -> None:
        """Signal: a new annotation is wanted on `source`."""
        self._links.signal(MARK_REQUESTED, MarkRequestedEvent(source=source, selector=selector, motivation=motivation))

    def request_assist(self, motivation: Motivation, options: MarkAssistRequestEventOptions) -> None:
        """Signal: an assist is wanted. The client's own state runs it."""
        self._links.signal(MARK_ASSIST_REQUEST, MarkAssistRequestEvent(motivation=motivation, options=options))

    def submit(self, event: MarkSubmitEvent) -> None:
        """Signal: submit the annotation that is pending."""
        self._links.signal(MARK_SUBMIT, event)

    def cancel_pending(self) -> None:
        """Signal: drop the annotation that is pending."""
        self._links.signal(MARK_CANCEL_PENDING, Empty())

    def dismiss_progress(self) -> None:
        """Signal: dismiss the display of an assist's progress."""
        self._links.signal(MARK_PROGRESS_DISMISS, Empty())

    def report_delete_error(self, event: ResourceErrorEvent) -> None:
        """Signal: a delete failed where nothing could show it. Said by whoever awaited `delete`, which knows the resource."""
        self._links.signal(MARK_DELETE_ERROR, event)
