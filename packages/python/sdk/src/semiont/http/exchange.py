"""One request of a gateway and its answer: how every request of this transport is made that is neither its stream nor an emit.

A request carries the token the transport has now, and the trace it is made
in. A request whose credential is refused (`refusal`) is made again at once,
on any method, once its refresher has given a token other than the one
refused: it was refused, not processed. Otherwise it is made a second time when
that is worth it and safe (`semiont.retry.TRANSPORT`): a status that promises
recovery, or no answer at all, on a method that cannot cause a second effect.
A request whose answer has not begun by its deadline fails as one that got no
answer, and is not made again: the gateway has the request, and may yet act on
it. Every failure is reported on the transport's error stream as it is raised
to its caller.

Once the transport is closing nothing is sent: a request made then fails at
once, and one in flight, which the closing ends, is not made again.
"""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterable, AsyncIterator, Awaitable, Callable, Coroutine
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from functools import partial
from typing import final, override

import httpx
from pydantic import TypeAdapter, ValidationError

from semiont import telemetry
from semiont._lacks import lacks
from semiont.errors import SemiontError, TransportError
from semiont.events import Broadcast
from semiont.http._withheld import why_unanswered
from semiont.model import WireModel
from semiont.retry import TRANSPORT, RetryFacts, retry_after_ms
from semiont.timing import REQUEST_RETRY_PAUSE_MS
from semiont.types import ErrorResponse, LimitRefusal
from semiont.watched import Watched

__all__ = ["Exchange", "TokenRefresher", "refusal"]

type TokenRefresher = Callable[[], Awaitable[str | None]]
"""How a transport renews its token when the gateway refuses the one it has:
renew it at its source, and say what it is now. Nothing when it could not be
renewed. Whoever gives a transport one also feeds the transport's token, so
the two never hold different ones. It is asked once per outage when the stream's
credential is refused, and once per request or emit whose credential is
refused."""


def refusal(message: str, status: int, body: bytes | None, stated_wait_ms: int | None) -> TransportError:
    """The gateway's refusal of a request, under the code it fails with. `body` is `None` when it could not be read.

    A refused credential (`docs/protocol/TRANSPORT-CONTRACT.md` § A refused
    credential) is `unauthorized`, which is how the stream, an emit and a
    request each know one: a `401`, or a `429` whose body is a `LimitRefusal`
    naming `refusal-rate`. Its token is renewed, never retried, so the wait it
    states is not waited out. Any other refusal is as its status says.
    """
    if status == 401 or (status == 429 and body is not None and _names_refusal_rate(body)):
        return TransportError("unauthorized", message, status=status, retry_after_ms=stated_wait_ms)
    return TransportError.of_status(message, status, stated_wait_ms)


def _names_refusal_rate(body: bytes) -> bool:
    """Whether a `429`'s body is a `LimitRefusal` naming `refusal-rate`."""
    try:
        return LimitRefusal.model_validate_json(body).code == "refusal-rate"
    except ValidationError:
        # Not a limit this build can name: a limit all the same, as its status says.
        return False


@final
class _Waited(httpx.AsyncByteStream):
    """An answer's body, each piece of it awaited as a wait on the wire (`waiting`), which the transport's close ends."""

    def __init__(self, body: httpx.AsyncByteStream, waiting: Callable[[], AbstractAsyncContextManager[None]]) -> None:
        self._body = body
        self._waiting = waiting

    @override
    async def __aiter__(self) -> AsyncIterator[bytes]:
        pieces = aiter(self._body)
        while True:
            async with self._waiting():
                piece = await anext(pieces, None)
            if piece is None:
                return
            yield piece

    @override
    async def aclose(self) -> None:
        await self._body.aclose()


@final
class Exchange:
    """A transport's requests of its gateway, and the tasks it runs for its callers."""

    def __init__(
        self,
        *,
        base_url: str,
        http: httpx.AsyncClient,
        token: Watched[str | None],
        refresher: TokenRefresher | None,
        failures: Broadcast[SemiontError],
        deadline_ms: int,
        closing: asyncio.Event,
    ) -> None:
        self._base_url = base_url
        self._http = http
        self._token = token
        self._refresher = refresher
        self._failures = failures
        self._deadline_ms = deadline_ms
        self._closing = closing
        self._tasks: set[asyncio.Task[object]] = set()
        self._waiting: set[asyncio.Task[object]] = set()
        """The tasks waiting on the wire now."""
        self._cut: set[asyncio.Task[object]] = set()
        """The tasks whose wait `ended` cut."""

    def failed(self, error: TransportError) -> TransportError:
        """Report a failure on the error stream, and hand it back for its caller."""
        self._failures.deliver(error)
        return error

    def _unanswered(self, method: str, path: str) -> TransportError:
        """A request the gateway did not answer by its deadline."""
        return TransportError.without_response(f"{method} {path} got no answer within {self._deadline_ms}ms")

    def _headers(self, token: str | None) -> dict[str, str]:
        """What every request carries: its token, when it sends one, and the trace it is made in."""
        headers = telemetry.trace_headers()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    async def renewal(self, refused: str | None) -> str | None:
        """The token to send again in place of `refused`, the token the gateway refused.

        It is what the refresher gives, when there is a refresher and what it
        gives is another token: the same one would get the same answer.
        """
        if self._refresher is None:
            return None
        try:
            renewed = await self._refresher()
        except SemiontError:
            return None
        return None if renewed == refused else renewed

    def run[T](self, work: Coroutine[object, object, T]) -> asyncio.Task[T]:
        """Run `work` as a task of this transport's: one it has seen the end of by the time it has closed."""
        task = asyncio.ensure_future(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def ended(self) -> None:
        """End every wait on the wire, each as a request that got no answer, and wait for every task `run` began: the transport is over."""
        for task in self._waiting:
            self._cut.add(task)
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    @asynccontextmanager
    async def _on_wire(self, unanswered: str) -> AsyncGenerator[None]:
        """A wait on the wire: a request's answer, or a piece of its body. Ended by `ended`, it fails as a request that got none.

        `unanswered` says what got no answer. Once the transport is closing no
        wait begins. It is ended as a deadline ends one, in its own task, so the
        HTTP client, which may be its caller's, is never closed for it.
        """
        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("a request of a gateway is made in a task")
        if self._closing.is_set():
            raise self.failed(TransportError.without_response(f"{unanswered}: the transport is closed"))
        cancelling = task.cancelling()
        self._waiting.add(task)
        try:
            yield
        except asyncio.CancelledError:
            # Ended by `ended` alone, not by whoever runs the task as well: then it is a request that got no answer.
            if task in self._cut and task.uncancel() <= cancelling:
                raise self.failed(TransportError.without_response(f"{unanswered}: the transport is closed")) from None
            raise
        finally:
            self._waiting.discard(task)

    async def begin(
        self,
        method: str,
        path: str,
        *,
        authenticated: bool = True,
        headers: dict[str, str] | None = None,
        content: bytes | Callable[[], AsyncIterable[bytes]] | None = None,
        at_length: bool = False,
    ) -> httpx.Response:
        """Make a request, and return its answer once it has begun: the response, its body not yet read.

        The caller reads the body and closes the response; the transport's
        close ends a read under way. A refusal is read here and raised. The answer is to begin within the transport's
        deadline, unless the request is made `at_length`: then it may take as
        long as it takes. A body that is sent as it is made is given as what
        makes it, so a second attempt sends it from its start.
        """
        repeatable = TRANSPORT.retryable(RetryFacts(status=503, method=method))
        token = self._token.value if authenticated else None
        retried = False
        renewed = False
        while True:
            if self._closing.is_set():
                raise self.failed(TransportError("error", f"{method} {path} was not sent: the transport is closed"))
            request = self._http.build_request(
                method,
                f"{self._base_url}{path}",
                headers={**self._headers(token), **(headers or {})},
                content=content() if callable(content) else content,
            )
            try:
                async with (
                    asyncio.timeout(None if at_length else self._deadline_ms / 1000),
                    self._on_wire(f"{method} {path} got no answer"),
                ):
                    response = await self._http.send(request, stream=True)
            except TimeoutError:
                raise self.failed(self._unanswered(method, path)) from None
            except httpx.HTTPError as error:
                if repeatable and not retried and not self._closing.is_set():
                    retried = True
                    await asyncio.sleep(REQUEST_RETRY_PAUSE_MS / 1000)
                    continue
                raise self.failed(TransportError.without_response(f"{method} {path} got no answer: {why_unanswered(error)}")) from None
            arriving = response.stream
            if not isinstance(arriving, httpx.AsyncByteStream):
                raise TypeError("an asynchronous client answers with an asynchronous body")
            response.stream = _Waited(arriving, partial(self._on_wire, f"{method} {path} ended before its answer did"))
            if response.is_success:
                return response

            status = response.status_code
            stated_wait_ms = retry_after_ms(response.headers.get("retry-after"))
            body: bytes | None = None
            try:
                body = await response.aread()
                # The gateway's refusal, in its own words when its body states them.
                said = ErrorResponse.model_validate_json(body).error
            except (ValidationError, httpx.HTTPError):
                said = f"HTTP {status}: {response.reason_phrase}"
            finally:
                await response.aclose()
            refused = refusal(said, status, body, stated_wait_ms)
            if refused.code == "unauthorized":
                # Decided before any retry rule is asked. Without another
                # token the same request gets the same answer, so it is made
                # again only with one, and only once.
                if authenticated and not renewed and not self._closing.is_set():
                    renewed = True
                    another = await self.renewal(token)
                    if another is not None:
                        token = another
                        continue
                raise self.failed(refused)
            if not retried and not self._closing.is_set() and TRANSPORT.retryable(RetryFacts(status=status, method=method)):
                retried = True
                await asyncio.sleep(max(REQUEST_RETRY_PAUSE_MS, stated_wait_ms or 0) / 1000)
                continue
            raise self.failed(refused)

    async def answer[M: WireModel](
        self,
        declared: type[M],
        method: str,
        path: str,
        *,
        authenticated: bool = True,
        headers: dict[str, str] | None = None,
        content: bytes | Callable[[], AsyncIterable[bytes]] | None = None,
        at_length: bool = False,
    ) -> M:
        """Make a request, and read its answer as the body the operation declares.

        The answer, once begun, is read within the same deadline.
        """
        return await self._answer(
            declared.model_validate_json,
            (declared,),
            method,
            path,
            authenticated=authenticated,
            headers=headers,
            content=content,
            at_length=at_length,
        )

    async def answer_one_of[T](self, declared: TypeAdapter[T], shapes: tuple[type[WireModel], ...], method: str, path: str) -> T:
        """The same, of an operation that declares one of several shapes: `declared` reads the body, and `shapes` are what it may be."""
        return await self._answer(
            declared.validate_json, shapes, method, path, authenticated=True, headers=None, content=None, at_length=False
        )

    async def _answer[T](
        self,
        read: Callable[[bytes], T],
        shapes: tuple[type[WireModel], ...],
        method: str,
        path: str,
        *,
        authenticated: bool,
        headers: dict[str, str] | None,
        content: bytes | Callable[[], AsyncIterable[bytes]] | None,
        at_length: bool,
    ) -> T:
        """Make a request, and read its answer with `read`. An answer `read` refuses fails, saying what it lacks to be one of `shapes`."""
        response = await self.begin(method, path, authenticated=authenticated, headers=headers, content=content, at_length=at_length)
        try:
            async with asyncio.timeout(None if at_length else self._deadline_ms / 1000):
                body = await response.aread()
        except TimeoutError:
            raise self.failed(self._unanswered(method, path)) from None
        except httpx.HTTPError as error:
            said = f"{method} {path} ended before its answer did: {why_unanswered(error)}"
            raise self.failed(TransportError.without_response(said)) from None
        finally:
            await response.aclose()
        try:
            return read(body)
        except ValidationError as error:
            lacking = lacks(shapes, error, "its declared body")
        # Raised from nothing: the decoder's failure shows the answer, and what a failure is raised from is printed with it.
        raise self.failed(
            TransportError("error", f"{method} {path} answered what is not its declared body: {lacking}", status=response.status_code)
        )
