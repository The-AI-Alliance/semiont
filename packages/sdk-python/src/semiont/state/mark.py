"""Marking, as one resource's state: the annotation being composed, and the delegated job that is running.

**The pending annotation.** A selection (`client.mark.request`, or one of the
quick `mark:select-*` signals) becomes the annotation pending. Submitting it
(`client.mark.submit`) creates it, and it stops being pending when the
knowledge base says it is recorded; a creation that fails leaves it pending and
says `mark:create-error` on the client's own bus. `client.mark.cancel_pending`
drops it.

A request and a submission name the resource they are for, and a unit acts only
on its own: several units over one client, one per open resource, do not answer
for each other.

**The delegated job.** `client.mark.request_delegate` starts one: the `mark`
job whose parameters the request carries, delegated for this unit's resource.
The motivation those parameters state is held while it runs, and its progress
as it comes, with the motivation that progress is of. A finished job's progress
stays until it is dismissed (`client.mark.dismiss_progress`) or the next one
begins, and so does a cancelled one's: its commits stand. One that fails clears
it. Why a job ended without completing is held until the progress is dismissed
or the next job begins. The job's id is held from the queue's answer to its
creation to the job's end: it is what `client.job.cancel` names.

A delegated job that says nothing for `DELEGATE_SILENCE_MS` has gone quiet,
which is not over: the unit says so once (`mark:delegate-timeout`) and keeps
following, so a completion that arrives later still ends it.
"""

import asyncio
from types import TracebackType
from typing import Final, Self, final, override

from pydantic import JsonValue, ValidationError

from semiont._reading import Reading
from semiont.bus import decoded
from semiont.channels import (
    MARK_CANCEL_PENDING,
    MARK_CREATE_ERROR,
    MARK_DELEGATE_REQUEST,
    MARK_DELEGATE_TIMEOUT,
    MARK_PROGRESS_DISMISS,
    MARK_REQUESTED,
    MARK_SELECT_ASSESSMENT,
    MARK_SELECT_COMMENT,
    MARK_SELECT_REFERENCE,
    MARK_SELECT_TAG,
    MARK_SUBMIT,
)
from semiont.client import SemiontClient
from semiont.errors import SemiontError
from semiont.events import Events
from semiont.identifiers import JobId, ResourceId
from semiont.model import WireModel
from semiont.namespaces.follow import Delegation, JobAttemptFailed, JobCompleted, JobCreated, JobProgressed
from semiont.state._jobs import cancelled
from semiont.state._tasks import Tasks
from semiont.state_unit import StateUnit
from semiont.timing import DELEGATE_SILENCE_MS
from semiont.transport import Frame, Transport
from semiont.types import (
    AnnotationSelector,
    AnnotationTarget,
    CreateAnnotationRequest,
    FragmentSelector,
    JobProgress,
    MarkDelegateTimeoutEvent,
    MarkJobCompleteCommand,
    MarkJobParams,
    MarkSubmitEvent,
    Motivation,
    ResourceErrorEvent,
    SelectionData,
    Selector,
    SvgSelector,
    TextQuoteSelector,
)
from semiont.watched import Variable, Watched

__all__ = ["MarkStateUnit", "PendingAnnotation"]

_HEARD: Final = (
    MARK_REQUESTED,
    MARK_SELECT_COMMENT,
    MARK_SELECT_TAG,
    MARK_SELECT_ASSESSMENT,
    MARK_SELECT_REFERENCE,
    MARK_CANCEL_PENDING,
    MARK_SUBMIT,
    MARK_DELEGATE_REQUEST,
    MARK_PROGRESS_DISMISS,
)


@final
class PendingAnnotation(WireModel, frozen=True):
    """An annotation being composed: where it is, and why it is made. Its selector is what `client.mark.submit` takes."""

    selector: AnnotationSelector
    motivation: Motivation


def _selected(selection: SelectionData) -> AnnotationSelector:
    """The selector a quick selection states: its region, its fragment with the text it quotes, or the text alone.

    Each selector states only what the selection did: an empty text is none.
    """
    quoted: dict[str, JsonValue] = {"type": "TextQuoteSelector", "exact": selection.exact}
    if selection.prefix:
        quoted["prefix"] = selection.prefix
    if selection.suffix:
        quoted["suffix"] = selection.suffix
    quote = TextQuoteSelector.model_validate(quoted)
    if selection.svg_selector:
        return SvgSelector.model_validate({"type": "SvgSelector", "value": selection.svg_selector})
    if selection.fragment_selector:
        fragment: dict[str, JsonValue] = {"type": "FragmentSelector", "value": selection.fragment_selector}
        if selection.conforms_to:
            fragment["conformsTo"] = selection.conforms_to
        selectors: list[Selector] = [FragmentSelector.model_validate(fragment)]
        if selection.exact:
            selectors.append(quote)
        return selectors
    return quote


@final
class MarkStateUnit(StateUnit):
    """See the module's documentation. It marks `resource_id`."""

    def __init__(self, client: SemiontClient[Transport], resource_id: ResourceId) -> None:
        self._client: Final = client
        self._resource_id: Final = resource_id
        self._pending: Final = Variable[PendingAnnotation | None](None)
        self._delegating: Final = Variable[Motivation | None](None)
        self._progress: Final = Variable[JobProgress | None](None)
        self._progress_motivation: Final = Variable[Motivation | None](None)
        self._failure: Final = Variable[SemiontError | None](None)
        self._job_id: Final = Variable[JobId | None](None)
        self._tasks: Final = Tasks()
        # One reader of every signal it hears, taken now, so what is said from here on is acted on in the order it was said.
        self._tasks.run(self._listen(client.bus.frames_among([channel.name for channel in _HEARD])))

    @property
    def pending_annotation(self) -> Watched[PendingAnnotation | None]:
        """The annotation being composed, or none."""
        return Reading(self._pending)

    @property
    def delegating_motivation(self) -> Watched[Motivation | None]:
        """The motivation of the delegated job that is running, or none."""
        return Reading(self._delegating)

    @property
    def progress(self) -> Watched[JobProgress | None]:
        """The progress of the delegated job that is running, or of the last one until it is dismissed."""
        return Reading(self._progress)

    @property
    def progress_motivation(self) -> Watched[Motivation | None]:
        """The motivation of the run whose progress `progress` holds, until the progress is dismissed or cleared by a failure."""
        return Reading(self._progress_motivation)

    @property
    def failure(self) -> Watched[SemiontError | None]:
        """Why the last delegated job ended without completing, until it is dismissed or the next job begins."""
        return Reading(self._failure)

    @property
    def job_id(self) -> Watched[JobId | None]:
        """The delegated job's id, from the queue's answer to its creation to its end: what `client.job.cancel` names."""
        return Reading(self._job_id)

    async def _listen(self, heard: Events[Frame]) -> None:
        async with heard:
            async for frame in heard:
                try:
                    self._heard(frame)
                except ValidationError:
                    # A frame that is not its channel's is nobody's to act on.
                    continue

    def _heard(self, frame: Frame) -> None:
        match frame.channel:
            case MARK_REQUESTED.name:
                request = decoded(MARK_REQUESTED, frame.payload)
                if request.source == self._resource_id:
                    self._pending.set(PendingAnnotation(selector=request.selector, motivation=request.motivation))
            case MARK_SELECT_COMMENT.name:
                self._pending.set(
                    PendingAnnotation(selector=_selected(decoded(MARK_SELECT_COMMENT, frame.payload)), motivation="commenting")
                )
            case MARK_SELECT_TAG.name:
                self._pending.set(PendingAnnotation(selector=_selected(decoded(MARK_SELECT_TAG, frame.payload)), motivation="tagging"))
            case MARK_SELECT_ASSESSMENT.name:
                self._pending.set(
                    PendingAnnotation(selector=_selected(decoded(MARK_SELECT_ASSESSMENT, frame.payload)), motivation="assessing")
                )
            case MARK_SELECT_REFERENCE.name:
                self._pending.set(
                    PendingAnnotation(selector=_selected(decoded(MARK_SELECT_REFERENCE, frame.payload)), motivation="linking")
                )
            case MARK_CANCEL_PENDING.name:
                self._pending.set(None)
            case MARK_SUBMIT.name:
                submission = decoded(MARK_SUBMIT, frame.payload)
                if submission.source == self._resource_id:
                    self._tasks.run(self._create(submission))
            case MARK_DELEGATE_REQUEST.name:
                self._delegate(decoded(MARK_DELEGATE_REQUEST, frame.payload).params)
            case MARK_PROGRESS_DISMISS.name:
                self._progress.set(None)
                self._progress_motivation.set(None)
                self._failure.set(None)
            case _:
                pass

    async def _create(self, submission: MarkSubmitEvent) -> None:
        """The annotation stops being pending here, when its own creation is recorded, and not on any creation's reply.

        A reply does not say which resource it was for, so another viewer's would drop this one's selection.
        """
        target = AnnotationTarget(source=self._resource_id, selector=submission.selector)
        request = (
            CreateAnnotationRequest(motivation=submission.motivation, target=target)
            if submission.body is None
            else CreateAnnotationRequest(motivation=submission.motivation, target=target, body=submission.body)
        )
        try:
            await self._client.mark.annotation(request)
        except SemiontError as error:
            self._client.bus.publish(MARK_CREATE_ERROR, ResourceErrorEvent(resource_id=self._resource_id, message=error.message))
            return
        self._pending.set(None)

    def _delegate(self, params: MarkJobParams) -> None:
        motivation = params.motivation
        self._delegating.set(motivation)
        self._progress.set(None)
        self._progress_motivation.set(motivation)
        self._failure.set(None)
        self._job_id.set(None)
        self._tasks.run(self._follow(self._client.mark.delegate(self._resource_id, params), motivation))

    async def _follow(self, run: Delegation[MarkJobCompleteCommand], motivation: Motivation) -> None:
        # This job's id. At the job's end it is let go only while it is still the one held: a job delegated later replaces it.
        created: JobId | None = None
        events = aiter(run)
        # The next event, read on a task of its own: a silence gives up waiting for it, never the reading,
        # since a delegation whose reader is cancelled is abandoned, and a quiet job is still followed.
        coming = asyncio.ensure_future(anext(events))
        # Whether the next silence is still to be said. It is said once, and again only after the job has said something.
        listening_for_silence = True
        try:
            while True:
                heard, _ = await asyncio.wait({coming}, timeout=DELEGATE_SILENCE_MS / 1000 if listening_for_silence else None)
                if not heard:
                    listening_for_silence = False
                    self._gone_quiet(motivation)
                    continue
                try:
                    event = coming.result()
                except StopAsyncIteration:
                    break
                coming = asyncio.ensure_future(anext(events))
                listening_for_silence = True
                match event:
                    case JobCreated(data=job):
                        self._job_id.set(job.job_id)
                        created = job.job_id
                    case JobProgressed(data=progress):
                        self._progress.set(progress)
                    case JobAttemptFailed() | JobCompleted():
                        # An attempt that will be tried again, or the completion, which the end follows.
                        pass
        except SemiontError as error:
            # Why it ended is said before the end itself. A cancelled job's commits stand, and its display stays to say so.
            self._failure.set(error)
            if not cancelled(error):
                self._progress.set(None)
                self._progress_motivation.set(None)
        finally:
            # Disposed while waiting: the reading stops with the unit, and the delegation is abandoned.
            coming.cancel()
        self._delegating.set(None)
        if created is not None and self._job_id.value == created:
            self._job_id.set(None)

    def _gone_quiet(self, motivation: Motivation) -> None:
        """The job is still running as far as anyone here knows, so its motivation stays; a display with no progress is given one."""
        if self._progress.value is None:
            self._progress.set(JobProgress(percentage=0))
        self._client.bus.publish(MARK_DELEGATE_TIMEOUT, MarkDelegateTimeoutEvent(resource_id=self._resource_id, motivation=motivation))

    @override
    def dispose(self) -> None:
        self._tasks.stop()
        self._pending.end()
        self._delegating.end()
        self._progress.end()
        self._progress_motivation.end()
        self._failure.end()
        self._job_id.end()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.dispose()
        await self._tasks.ended()
