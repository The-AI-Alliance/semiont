"""One request of a gateway and its answer: how every request of this transport is made that is neither its stream nor an emit.

A request carries the token the transport has now, and the trace it is made
in. It is made a second time when that is worth it and safe
(`semiont.retry.TRANSPORT`): a status that promises recovery, or no answer at
all, on a method that cannot cause a second effect. A request whose answer has
not begun by its deadline fails as one that got no answer, and is not made
again: the gateway has the request, and may yet act on it. Every failure is
reported on the transport's error stream as it is raised to its caller.

Once the transport is closing nothing is sent: a request made then fails at
once, and one in flight, which the closing ends, is not made again.
"""

import asyncio
from collections.abc import AsyncIterable, Coroutine
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

__all__ = ["Exchange"]

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
        failures: Broadcast[SemiontError],
        deadline_ms: int,
        closing: asyncio.Event,
    ) -> None:
        self._base_url = base_url
        self._http = http
        self._token = token
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

    def headers(self, *, authenticated: bool) -> dict[str, str]:
        """What every request carries: the token there is now, and the trace it is made in."""
        headers = telemetry.trace_headers()
        token = self._token.value
        if authenticated and token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

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
        content: bytes | AsyncIterable[bytes] | None = None,
        at_length: bool = False,
    ) -> httpx.Response:
        """Make a request, and return its answer once it has begun: the response, its body not yet read.

        The caller reads the body and closes the response. A refusal is read
        here and raised. The answer is to begin within the transport's
        deadline, unless the request is made `at_length`: then it may take as
        long as it takes.
        """
        # A body that is sent as it is made cannot be sent twice.
        repeatable = not isinstance(content, AsyncIterable) and TRANSPORT.retryable(RetryFacts(status=503, method=method))
        retried = False
        while True:
            if self._closing.is_set():
                raise self.failed(TransportError("error", f"{method} {path} was not sent: the transport is closed"))
            request = self._http.build_request(
                method,
                f"{self._base_url}{path}",
                headers={**self.headers(authenticated=authenticated), **(headers or {})},
                content=content,
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
            # A 401 is worth a second attempt only with a renewed token, and this transport has no way to renew one.
            if repeatable and not retried and status != 401 and TRANSPORT.retryable(RetryFacts(status=status, method=method)):
                await response.aclose()
                retried = True
                await asyncio.sleep(max(_RETRY_PAUSE_MS, stated_wait_ms or 0) / 1000)
                continue
            try:
                # The gateway's refusal, in its own words when its body states them.
                said = ErrorResponse.model_validate_json(await response.aread()).error
            except (ValidationError, httpx.HTTPError):
                said = f"HTTP {status}: {response.reason_phrase}"
            finally:
                await response.aclose()
            raise self.failed(TransportError.of_status(said, status, stated_wait_ms))

    async def answer[M: WireModel](
        self,
        declared: type[M],
        method: str,
        path: str,
        *,
        authenticated: bool = True,
        headers: dict[str, str] | None = None,
        content: bytes | AsyncIterable[bytes] | None = None,
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
