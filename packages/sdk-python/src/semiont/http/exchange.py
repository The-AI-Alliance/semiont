"""One request of a gateway and its answer: how every request of this transport is made that is neither its stream nor an emit.

A request carries the token the transport has now, and the trace it is made
in. It is made a second time when that is worth it and safe
(`semiont.retry.TRANSPORT`): a `401` once a renewed token is in hand, on any
method; a status that promises recovery, or no answer at all, on a method that
cannot cause a second effect. A request whose answer has not begun by its
deadline fails as one that got no answer, and is not made again: the gateway
has the request, and may yet act on it. Every failure is reported on the
transport's error stream as it is raised to its caller.

Once the transport is closing nothing is sent: a request made then fails at
once, and one in flight, which the closing ends, is not made again.
"""

import asyncio
from collections.abc import AsyncIterable, Awaitable, Callable, Coroutine
from typing import Final, final

import httpx
from pydantic import ValidationError

from semiont import telemetry
from semiont.errors import SemiontError, TransportError
from semiont.events import Broadcast
from semiont.model import WireModel
from semiont.retry import TRANSPORT, RetryFacts, retry_after_ms
from semiont.types import ErrorResponse
from semiont.watched import Watched

__all__ = ["Exchange", "TokenRefresher"]

type TokenRefresher = Callable[[], Awaitable[str | None]]
"""How a transport renews its token when the gateway refuses the one it has:
renew it at its source, and say what it is now. Nothing when it could not be
renewed. Whoever gives a transport one also feeds the transport's token, so
the two never hold different ones. It is asked once per outage when the stream
is refused `401`, and once per request refused `401`."""

# The wait before a request that is safe to repeat is made a second time.
_RETRY_PAUSE_MS: Final = 300


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

    async def _renewed(self) -> str | None:
        """The token the refresher gives in place of one the gateway refused, when there is a refresher and it gives one."""
        if self._refresher is None:
            return None
        try:
            return await self._refresher()
        except SemiontError:
            return None

    def run[T](self, work: Coroutine[object, object, T]) -> asyncio.Task[T]:
        """Run `work` as a task of this transport's: one it has seen the end of by the time it has closed."""
        task = asyncio.ensure_future(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def ended(self) -> None:
        """Wait for every task `run` began. Called once the HTTP client is closed, which ends each of them."""
        await asyncio.gather(*self._tasks, return_exceptions=True)

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

        The caller reads the body and closes the response. A refusal is read
        here and raised. The answer is to begin within the transport's
        deadline, unless the request is made `at_length`: then it may take as
        long as it takes. A body that is sent as it is made is given as what
        makes it, so a second attempt sends it from its start.
        """
        repeatable = TRANSPORT.retryable(RetryFacts(status=503, method=method))
        token = self._token.value if authenticated else None
        retried = False
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
                async with asyncio.timeout(None if at_length else self._deadline_ms / 1000):
                    response = await self._http.send(request, stream=True)
            except TimeoutError:
                raise self.failed(self._unanswered(method, path)) from None
            except httpx.HTTPError as error:
                if repeatable and not retried and not self._closing.is_set():
                    retried = True
                    await asyncio.sleep(_RETRY_PAUSE_MS / 1000)
                    continue
                raise self.failed(TransportError.without_response(f"{method} {path} got no answer: {error!r}")) from error
            if response.is_success:
                return response

            status = response.status_code
            stated_wait_ms = retry_after_ms(response.headers.get("retry-after"))
            try:
                # The gateway's refusal, in its own words when its body states them.
                said = ErrorResponse.model_validate_json(await response.aread()).error
            except (ValidationError, httpx.HTTPError):
                said = f"HTTP {status}: {response.reason_phrase}"
            finally:
                await response.aclose()
            if not retried and not self._closing.is_set() and TRANSPORT.retryable(RetryFacts(status=status, method=method)):
                if status != 401:
                    retried = True
                    await asyncio.sleep(max(_RETRY_PAUSE_MS, stated_wait_ms or 0) / 1000)
                    continue
                # A 401 earns its second attempt only if a renewed token
                # arrives: without one the same request gets the same answer.
                renewed = await self._renewed() if authenticated else None
                if renewed is not None:
                    token, retried = renewed, True
                    continue
            raise self.failed(TransportError.of_status(said, status, stated_wait_ms))

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
        response = await self.begin(method, path, authenticated=authenticated, headers=headers, content=content, at_length=at_length)
        try:
            async with asyncio.timeout(None if at_length else self._deadline_ms / 1000):
                body = await response.aread()
        except TimeoutError:
            raise self.failed(self._unanswered(method, path)) from None
        except httpx.HTTPError as error:
            raise self.failed(TransportError.without_response(f"{method} {path} ended before its answer did: {error!r}")) from error
        finally:
            await response.aclose()
        try:
            return declared.model_validate_json(body)
        except ValidationError as error:
            raise self.failed(
                TransportError("error", f"{method} {path} answered what is not its declared body: {error}", status=response.status_code)
            ) from error
