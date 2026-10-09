"""The worker driver: a worker written on this SDK, as `tests/conformance/worker` drives it.

It reaches the worker's surface only as a worker's author does: `job.claim`
on the SDK's client, the claims it returns, and the held jobs they hand out.

As a worker's code does, it runs each job it is handed in a span of its own,
`job:{jobType}` carrying the job's id as `job.id`: opened in the trace the
job states, where the job is handed to it, and ended once it has settled the
job. Everything it does for the job it does in that span. The suite's
operations for one job arrive one at a time, each in a task of its own, so no
`async with job` block can hold them: the span is opened in `job.trace`, the
value, as work outside such a block is.

Started with `OTEL_EXPORTER_OTLP_ENDPOINT` in its environment, it exports its
telemetry there over OTLP/HTTP, and has exported all of it by the time it
exits.
"""

import asyncio
import sys
from collections.abc import Generator
from contextlib import AsyncExitStack, contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Final, final

from opentelemetry import context as otel_context
from opentelemetry import trace as otel_trace
from opentelemetry.context import Context
from opentelemetry.trace import Span, SpanKind
from protocol import Arguments, Misuse, Operation, count, exporting, failure, object_of, say, serve, text, texts
from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont import telemetry
from semiont.claims import JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS, ClaimRefusal, Claims, HeldJob
from semiont.client import SemiontClient
from semiont.errors import SemiontError
from semiont.events import Events
from semiont.http import HttpTransport, Timing
from semiont.identifiers import InvalidIdentifier, ResourceId
from semiont.model import written
from semiont.timing import HELD_JOB_STALL_CHECK_MS, HELD_JOB_STALL_MS, JOB_CLAIM_TIMEOUT_MS, MARK_COMMIT_TIMEOUT_MS
from semiont.transport import ConnectionState, ResourceHold
from semiont.types import Annotation, FailureClass, JobFilter, JobProgress, MarkJobResult, UnitCursor, YieldJobResult
from semiont.watched import Variable

_FILTERS: Final = TypeAdapter[list[JobFilter]](list[JobFilter])
_CURSORS: Final = TypeAdapter[dict[str, UnitCursor]](dict[str, UnitCursor])
_CLASS: Final = TypeAdapter[FailureClass](FailureClass)
_PROGRESS: Final = TypeAdapter[JobProgress](JobProgress)
_MARK_RESULT: Final = TypeAdapter[MarkJobResult](MarkJobResult)
_YIELD_RESULT: Final = TypeAdapter[YieldJobResult](YieldJobResult)
_ANNOTATIONS: Final = TypeAdapter[list[Annotation]](list[Annotation])


@final
@dataclass(frozen=True, slots=True)
class _Waits:
    """A worker's waits, as `open` stated them: each the table's unless a case states another."""

    job_claim_timeout_ms: int = JOB_CLAIM_TIMEOUT_MS
    held_job_stall_ms: int = HELD_JOB_STALL_MS
    held_job_stall_check_ms: int = HELD_JOB_STALL_CHECK_MS
    mark_commit_timeout_ms: int = MARK_COMMIT_TIMEOUT_MS


def _timings(stated: Arguments) -> tuple[Timing, _Waits]:
    """The timing a case states, each entry by its name in `specs/src/client/timing.json`: the transport's, and a worker's."""
    known = Timing()
    reconnect_ms, lazy_remove_ms, linger_ms = known.reconnect_ms, known.lazy_remove_ms, known.linger_ms
    waits = _Waits()
    job_claim_timeout_ms, held_job_stall_ms, held_job_stall_check_ms, mark_commit_timeout_ms = (
        waits.job_claim_timeout_ms,
        waits.held_job_stall_ms,
        waits.held_job_stall_check_ms,
        waits.mark_commit_timeout_ms,
    )
    for name in stated:
        match name:
            case "reconnectMs":
                reconnect_ms = count(stated, name)
            case "lazyRemoveMs":
                lazy_remove_ms = count(stated, name)
            case "lingerMs":
                linger_ms = count(stated, name)
            case "jobClaimTimeoutMs":
                job_claim_timeout_ms = count(stated, name)
            case "heldJobStallMs":
                held_job_stall_ms = count(stated, name)
            case "heldJobStallCheckMs":
                held_job_stall_check_ms = count(stated, name)
            case "markCommitTimeoutMs":
                mark_commit_timeout_ms = count(stated, name)
            case _:
                raise Misuse(f"this driver cannot override {name}")
    return (
        Timing(
            reconnect_ms=reconnect_ms,
            lazy_remove_ms=lazy_remove_ms,
            linger_ms=linger_ms,
            emit_retry=known.emit_retry,
            seen_event_ids_count=known.seen_event_ids_count,
        ),
        _Waits(
            job_claim_timeout_ms=job_claim_timeout_ms,
            held_job_stall_ms=held_job_stall_ms,
            held_job_stall_check_ms=held_job_stall_check_ms,
            mark_commit_timeout_ms=mark_commit_timeout_ms,
        ),
    )


def _as_the_suite_wrote_it[T](shape: TypeAdapter[T], value: object, name: str) -> T:
    """What a case states as the wire carries it, as the SDK's type for it. One the type refuses is the suite's mistake."""
    try:
        return shape.validate_python(value)
    except ValidationError as error:
        raise Misuse(f"{name}: {error}") from error


def _cursors(args: Arguments) -> dict[str, UnitCursor] | None:
    """The cursors a case states for the units a job is part-way through, when it states any."""
    if "unitCursors" not in args:
        return None
    return _as_the_suite_wrote_it(_CURSORS, args["unitCursors"], "unitCursors")


def _failure_class(args: Arguments) -> FailureClass | None:
    """The class a case states for a failure, when it states one."""
    if "failureClass" not in args:
        return None
    return _as_the_suite_wrote_it(_CLASS, args["failureClass"], "failureClass")


def _iso(at: datetime | None) -> str | None:
    """A time as the protocol carries one."""
    return None if at is None else at.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@final
class Worker:
    """One worker, and what the suite asked it to report."""

    def __init__(self, held: AsyncExitStack, reporters: asyncio.TaskGroup) -> None:
        self._held: Final = held
        self._reporters: Final = reporters
        self._transport: HttpTransport | None = None
        self._client: SemiontClient[HttpTransport] | None = None
        self._waits = _Waits()
        self._claims: Claims | None = None
        self._job: HeldJob | None = None
        """The job the worker last came to hold, as its claims handed it out."""
        self._span: tuple[Span, Context] | None = None
        """The span the held job is run in, and the context in which that span is the current one."""
        self._holds: Final[list[ResourceHold]] = []
        self._telling: Final[list[asyncio.Task[None]]] = []
        """The tasks that say what the worker's claims hand out and tell it: ended when the driver is done."""
        self._reported: ConnectionState | None = None

    def _opened(self) -> SemiontClient[HttpTransport]:
        if self._client is None:
            raise Misuse("no transport is open")
        return self._client

    def _claiming(self) -> Claims:
        if self._claims is None:
            raise Misuse("the worker is not claiming")
        return self._claims

    def _hold(self, job: HeldJob) -> None:
        """Hold `job`, and open the span it is run in: in the trace the job states."""
        with telemetry.continuing(job.trace):
            span = otel_trace.get_tracer("semiont-conformance-driver").start_span(
                f"job:{job.job_type}", kind=SpanKind.CONSUMER, attributes={"job.id": job.job_id}
            )
            self._job = job
            self._span = (span, otel_trace.set_span_in_context(span))

    @contextmanager
    def _working(self) -> Generator[HeldJob]:
        """The held job, for something done for it: done in the job's span."""
        if self._job is None or self._span is None:
            raise Misuse("the worker has held no job")
        current = otel_context.attach(self._span[1])
        try:
            yield self._job
        finally:
            otel_context.detach(current)

    @contextmanager
    def _settling(self) -> Generator[HeldJob]:
        """The held job, to be settled: its span ends once that is done, however it went."""
        span = self._span
        try:
            with self._working() as job:
                yield job
        finally:
            if span is not None:
                span[0].end()

    async def _states(self, transport: HttpTransport) -> None:
        async for state in transport.state:
            if state != self._reported:
                self._reported = state
                say({"state": state})

    async def _failures(self, failures: Events[SemiontError]) -> None:
        async for error in failures:
            say({"error": failure(error)})

    async def open(self, _: int, args: Arguments) -> JsonValue:
        if self._client is not None:
            raise Misuse("a transport is already open")
        wire, self._waits = _timings(object_of(args, "timing") if "timing" in args else {})
        commits = args.get("commits", False)
        if not isinstance(commits, bool):
            raise Misuse("commits must be a boolean")
        # What a worker's stream names for its claims, and for its commits when
        # it will make any, and no more: this worker awaits nothing else.
        channels = [*JOB_CLAIM_CHANNELS, *JOB_COMMIT_CHANNELS] if commits else list(JOB_CLAIM_CHANNELS)
        transport = HttpTransport(text(args, "baseUrl"), token=Variable[str | None](text(args, "token")), channels=channels, timing=wire)
        self._transport = await self._held.enter_async_context(transport)
        self._client = await self._held.enter_async_context(SemiontClient(transport, transport.content, transport))
        self._reporters.create_task(self._states(transport))
        self._reporters.create_task(self._failures(transport.failures()))
        return None

    async def close(self, _: int, __: Arguments) -> JsonValue:
        """A worker that stops: a job it still holds is failed first."""
        client = self._opened()
        if self._claims is not None:
            await self._claims.aclose()
        await client.close()
        if self._transport is not None:
            await self._transport.close()
        return None

    async def subscribe_resource(self, _: int, args: Arguments) -> JsonValue:
        try:
            resource = ResourceId(text(args, "resource"))
        except InvalidIdentifier as error:
            raise Misuse(f"resource is not a resource's id: {error}") from error
        transport = self._transport
        if transport is None:
            raise Misuse("no transport is open")
        self._holds.append(transport.subscribe_to_resource(resource))
        return None

    async def claim(self, _: int, args: Arguments) -> JsonValue:
        """Begin claiming, and say what the claims hand out."""
        if self._claims is not None:
            raise Misuse("the worker is already claiming")
        accepts = _as_the_suite_wrote_it(_FILTERS, args.get("accepts"), "accepts")
        claims = self._opened().job.claim(
            accepts,
            job_claim_timeout_ms=self._waits.job_claim_timeout_ms,
            held_job_stall_ms=self._waits.held_job_stall_ms,
            held_job_stall_check_ms=self._waits.held_job_stall_check_ms,
            mark_commit_timeout_ms=self._waits.mark_commit_timeout_ms,
        )
        self._claims = claims
        self._telling.append(self._reporters.create_task(self._reading(claims)))
        self._telling.append(self._reporters.create_task(self._stalls(claims)))
        return None

    async def _reading(self, claims: Claims) -> None:
        async for handed in claims:
            if isinstance(handed, ClaimRefusal):
                refused: dict[str, JsonValue] = {"detail": handed.message}
                if handed.code is not None:
                    refused["code"] = handed.code
                say({"refused": refused})
                continue
            self._hold(handed)
            self._telling.append(self._reporters.create_task(self._signalled(handed)))
            say(
                {
                    "claimed": {
                        "jobId": handed.job_id,
                        "jobType": handed.job_type,
                        "resourceId": handed.resource_id,
                        "params": written(handed.params),
                        "completedUnits": list(handed.completed_units),
                        "unitCursors": {unit: written(cursor) for unit, cursor in handed.unit_cursors.items()},
                        "retryCount": handed.retry_count,
                        "maxRetries": handed.max_retries,
                    }
                }
            )

    async def _signalled(self, job: HeldJob) -> None:
        async for cancelled in job.cancelled:
            if cancelled:
                say({"signalled": job.job_id})
                return

    async def _stalls(self, claims: Claims) -> None:
        async for stall in claims.stalled:
            if stall is not None:
                say({"stalled": stall.job_id})

    async def start(self, _: int, __: Arguments) -> JsonValue:
        with self._working() as job:
            await job.start()
        return None

    async def progress(self, _: int, args: Arguments) -> JsonValue:
        stated = {name: args[name] for name in ("percentage", "message") if name in args}
        with self._working() as job:
            await job.progress(_as_the_suite_wrote_it(_PROGRESS, stated, "progress"))
        return None

    async def checkpoint(self, _: int, args: Arguments) -> JsonValue:
        with self._working() as job:
            await job.checkpoint(texts(args, "completedUnits"), _cursors(args))
        return None

    async def commit(self, _: int, args: Arguments) -> JsonValue:
        """The held job commits for itself: it cites its own id, and remembers what the commit observed for its settle.

        A case states an annotation as the wire carries one.
        """
        try:
            resource = ResourceId(text(args, "resourceId"))
        except InvalidIdentifier as error:
            raise Misuse(f"resourceId is not a resource's id: {error}") from error
        annotations = _as_the_suite_wrote_it(_ANNOTATIONS, args.get("annotations"), "annotations")
        with self._working() as job:
            await job.commit(resource, annotations)
        return None

    async def complete(self, _: int, args: Arguments) -> JsonValue:
        """A completion is its verb's, so the verb is read before the result is given.

        A case states a result as the wire carries one, and the gateway
        refuses one that is the other verb's.
        """
        result = object_of(args, "result")
        with self._settling() as job:
            if job.job_type == "mark":
                await job.complete(_as_the_suite_wrote_it(_MARK_RESULT, result, "result"))
            else:
                await job.complete(_as_the_suite_wrote_it(_YIELD_RESULT, result, "result"))
        return None

    async def fail(self, _: int, args: Arguments) -> JsonValue:
        with self._settling() as job:
            await job.fail(
                text(args, "error"),
                failure_class=_failure_class(args),
                completed_units=texts(args, "completedUnits") if "completedUnits" in args else None,
                unit_cursors=_cursors(args),
            )
        return None

    async def cancel(self, _: int, args: Arguments) -> JsonValue:
        with self._settling() as job:
            await job.cancel(
                texts(args, "completedUnits") if "completedUnits" in args else None,
                _cursors(args),
            )
        return None

    async def vitals(self, _: int, __: Arguments) -> JsonValue:
        vitals = self._claiming().vitals()
        active = vitals.active_job
        return {
            "lastQueuedEventAt": _iso(vitals.last_queued_event_at),
            "lastClaimAt": _iso(vitals.last_claim_at),
            "lastFinishedAt": _iso(vitals.last_finished_at),
            "lastActivityAt": _iso(vitals.last_activity_at),
            "activeJob": None if active is None else {"jobId": active.job_id, "type": active.job_type, "since": _iso(active.since)},
            "jobsCompleted": vitals.jobs_completed,
        }

    async def sync(self, _: int, __: Arguments) -> JsonValue:
        """Answers after everything the worker reported before it."""
        return None

    async def dispose(self) -> None:
        """The suite is done with this worker, and it ends as a worker that is killed ends.

        It says nothing more, of a job it holds or of anything else: only
        `close` stops the worker, and a job failed here would be one no case
        accounts for. So the claims are not stopped. The client's close ends
        their tasks, and what told the suite of them is ended here.
        """
        for telling in self._telling:
            telling.cancel()
        if self._client is not None:
            await self._client.close()
        if self._transport is not None:
            await self._transport.close()

    def operations(self) -> dict[str, Operation]:
        return {
            "open": Operation(self.open, in_turn=True),
            "close": Operation(self.close, in_turn=True),
            "subscribe-resource": Operation(self.subscribe_resource, in_turn=True),
            "claim": Operation(self.claim, in_turn=True),
            "start": Operation(self.start, in_turn=True),
            "progress": Operation(self.progress, in_turn=True),
            "checkpoint": Operation(self.checkpoint, in_turn=True),
            # Not in turn: a commit settles when the record answers it, and the suite asks other things of the worker until then.
            "commit": Operation(self.commit),
            "complete": Operation(self.complete, in_turn=True),
            "fail": Operation(self.fail, in_turn=True),
            "cancel": Operation(self.cancel, in_turn=True),
            "vitals": Operation(self.vitals, in_turn=True),
            "sync": Operation(self.sync, in_turn=True),
        }


async def main() -> int:
    flush = exporting()
    try:
        async with AsyncExitStack() as held, asyncio.TaskGroup() as reporters:
            worker = Worker(held, reporters)
            return await serve(worker.operations(), worker.dispose)
    finally:
        if flush is not None:
            flush()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
