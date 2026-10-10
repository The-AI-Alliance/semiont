"""A stream that is stopped ends every connection it began, whatever became of the first cancellation it sent each.

A connection is a task, and a task is ended by cancelling it. The HTTP
library can take a cancellation for its own. While a connection is being
made, the library cancels a scope of its own that the connection's task is
in. A cancellation of the task that is asked for in the same turn of the
loop, after the library's, is delivered as the one the library already asked
for: the library's scope takes it, and the task goes on with nothing left to
end it. A stream that waited for such a connection would never be closed.

The library's part is stood in for here: a connection whose making takes the
first cancellation it is sent, and goes on.
"""

import asyncio
import contextlib
from collections.abc import AsyncIterator
from typing import Final, final, override

import httpx
import pytest
from aio import run, soon

from semiont.errors import SemiontError
from semiont.events import Broadcast
from semiont.http.stream import Stream, Timing
from semiont.transport import FrameHub, ReplyRouter
from semiont.watched import Variable

QUICK: Final = Timing(reconnect_ms=10)


@final
class _Silent(httpx.AsyncByteStream):
    """A response's body that never says anything."""

    @override
    async def __aiter__(self) -> AsyncIterator[bytes]:
        await asyncio.Event().wait()
        yield b""


@final
class TakesItsFirstCancellation(httpx.AsyncBaseTransport):
    """A connection whose making takes the first cancellation it is sent, as a scope of the HTTP library's does, and goes on.

    What it goes on to is its test's to say: an answer that never comes, or
    a stream that opens and says nothing.
    """

    def __init__(self, *, answers: bool) -> None:
        self._answers: Final = answers
        self.entered: Final = asyncio.Event()
        self.went_on = False

    @override
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.entered.set()
        # Taken, and not raised again: the task is still asked to end, and nothing will deliver the asking.
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.Event().wait()
        self.went_on = True
        if not self._answers:
            await asyncio.Event().wait()
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=_Silent())


@pytest.mark.parametrize("answers", [False, True], ids=["an answer that never comes", "a stream that says nothing"])
def test_a_stream_that_is_stopped_ends_a_connection_whose_first_cancellation_was_taken_whatever_the_connection_went_on_to(
    answers: bool,
) -> None:
    async def scenario() -> None:
        connecting = TakesItsFirstCancellation(answers=answers)
        async with httpx.AsyncClient(transport=connecting) as http:
            stream = Stream(
                base_url="http://gateway.invalid",
                http=http,
                token=Variable[str | None]("t"),
                refresher=None,
                client_id="client-1",
                channels=("beckon:focus",),
                timing=QUICK,
                hub=FrameHub(),
                router=ReplyRouter(),
                failures=Broadcast[SemiontError](),
                bookmarks=None,
            )
            running = asyncio.ensure_future(stream.run())
            await soon(connecting.entered.wait())
            stream.stop()
            # Every task the stream started has ended when its own does.
            await soon(running)
            assert connecting.went_on, "the connection ended at its first cancellation: nothing here was taken"
            assert stream.state.value == "closed"

    run(scenario())
