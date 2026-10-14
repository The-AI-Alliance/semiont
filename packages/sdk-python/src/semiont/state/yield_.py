"""Generation, as state: whether a resource is being generated, the job's id and progress, and what the finished run produced.

The display it feeds stays once the run is over: the progress and the outcome
are there until they are dismissed, or until the next run begins. A cancelled
run's progress stays too, though it made nothing. A run that fails, or stalls,
clears its progress and is no longer generating. Why a run ended without a
result is held with the rest. A stall is said nowhere else.
"""

from types import TracebackType
from typing import Final, Self, final, override

from semiont.client import SemiontClient
from semiont.errors import SemiontError
from semiont.identifiers import JobId
from semiont.namespaces.follow import Delegation, JobAttemptFailed, JobCompleted, JobCreated, JobProgressed
from semiont.state._jobs import cancelled
from semiont.state._reading import Reading
from semiont.state._tasks import Tasks
from semiont.state_unit import StateUnit
from semiont.transport import Transport
from semiont.types import GenerationJobParams, JobGenerationResult, JobProgress, YieldJobCompleteCommand
from semiont.watched import Variable, Watched

__all__ = ["YieldStateUnit"]


@final
class YieldStateUnit(StateUnit):
    """See the module's documentation. `locale` is the language a generation is written in when its request states none: BCP 47."""

    def __init__(self, client: SemiontClient[Transport], locale: str) -> None:
        self._client: Final = client
        self._locale: Final = locale
        self._generating: Final = Variable(False)
        self._progress: Final = Variable[JobProgress | None](None)
        self._outcome: Final = Variable[JobGenerationResult | None](None)
        self._failure: Final = Variable[SemiontError | None](None)
        self._job_id: Final = Variable[JobId | None](None)
        self._tasks: Final = Tasks()
        self._disposed = False

    @property
    def is_generating(self) -> Watched[bool]:
        """Whether a run is under way: from its first progress to its end."""
        return Reading(self._generating)

    @property
    def progress(self) -> Watched[JobProgress | None]:
        return Reading(self._progress)

    @property
    def outcome(self) -> Watched[JobGenerationResult | None]:
        """What the last finished run produced; none while one runs, and none once dismissed."""
        return Reading(self._outcome)

    @property
    def failure(self) -> Watched[SemiontError | None]:
        """Why the last run ended without a result: it failed, stalled or was cancelled.

        None while one runs, after one that completed, and once dismissed.
        """
        return Reading(self._failure)

    @property
    def job_id(self) -> Watched[JobId | None]:
        """The generation job's id, from the queue's answer to its creation to its end: what `client.job.cancel` names."""
        return Reading(self._job_id)

    def generate(self, params: GenerationJobParams, *, stall_deadline_ms: int | None = None) -> None:
        """Generate a resource from a gathered context, as `client.yield_.delegate` does.

        It is written in this unit's locale when `params` states no language.
        """
        if self._disposed:
            return
        self._progress.set(None)
        self._outcome.set(None)
        self._failure.set(None)
        self._job_id.set(None)
        if not params.language:
            params = params.model_copy(update={"language": self._locale})
        self._tasks.run(self._run(self._client.yield_.delegate(params, stall_deadline_ms=stall_deadline_ms)))

    def dismiss_progress(self) -> None:
        """Clear the display of a run: its progress, its outcome and why it failed."""
        if self._disposed:
            return
        self._progress.set(None)
        self._outcome.set(None)
        self._failure.set(None)

    async def _run(self, run: Delegation[YieldJobCompleteCommand]) -> None:
        # This job's id. At the job's end it is let go only while it is still the one held: a run begun later replaces it.
        created: JobId | None = None
        try:
            async for event in run:
                match event:
                    case JobCreated(data=job):
                        self._job_id.set(job.job_id)
                        created = job.job_id
                    case JobProgressed(data=progress):
                        self._progress.set(progress)
                        self._generating.set(True)
                    case JobCompleted(data=complete):
                        if isinstance(complete.result, JobGenerationResult):
                            self._outcome.set(complete.result)
                    case JobAttemptFailed():
                        # An attempt that failed and will be tried again: the run is not over.
                        pass
        except SemiontError as failure:
            # Why it ended is said before the end itself. A cancelled run's progress stays.
            self._failure.set(failure)
            if not cancelled(failure):
                self._progress.set(None)
        self._generating.set(False)
        if created is not None and self._job_id.value == created:
            self._job_id.set(None)

    @override
    def dispose(self) -> None:
        self._disposed = True
        self._tasks.stop()
        self._generating.end()
        self._progress.end()
        self._outcome.end()
        self._failure.end()
        self._job_id.end()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.dispose()
        await self._tasks.ended()
