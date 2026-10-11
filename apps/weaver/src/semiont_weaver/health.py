"""The service's health endpoint: `GET /health`, answered with no token asked.

What it says is `docs/protocol/WEAVER.md` § Health's: that the service is up,
how many events it could not apply, and how its two boot passes ended.
Whatever watches the service reads it: an image's health check, a launcher
waiting for the service to start, an operator asking whether the graph was
caught up.

It is HTTP/1.1 as far as that one answer needs. A request is read as far as
the end of its head, answered, and its connection closed.
"""

import asyncio
import contextlib
import json
from collections.abc import Callable
from typing import Final

from pydantic import JsonValue

type Health = Callable[[], JsonValue]
"""What the endpoint answers with, asked afresh for each request."""

_HEAD_SECONDS: Final = 10
"""How long a connection is given to send the head of its request."""


def _answer(status: str, body: bytes, content_type: str | None) -> bytes:
    """A whole response: its status line, what describes its body, and the body."""
    head = [f"HTTP/1.1 {status}", f"Content-Length: {len(body)}", "Connection: close"]
    if content_type is not None:
        head.append(f"Content-Type: {content_type}")
    return "\r\n".join((*head, "", "")).encode("ascii") + body


def _answer_to(request_line: bytes, health: Health) -> bytes:
    """The answer to a request, by its first line.

    The path is matched without its query string, and answered to `GET`
    alone. Anything else, and anything that is no request line at all, is
    answered `404` with no body.
    """
    asked = request_line.split()
    if len(asked) == 3 and asked[0] == b"GET" and asked[1].split(b"?", 1)[0] == b"/health":
        return _answer("200 OK", json.dumps(health()).encode("utf-8"), "application/json")
    return _answer("404 Not Found", b"", None)


async def bind_health(port: int, health: Health) -> asyncio.Server:
    """Take `port`, on every address of the machine, for an endpoint that answers each request from `health`.

    Raises `OSError` where the port cannot be taken. The server it returns
    holds the port and answers nothing: it answers from when it is told to
    start serving (`start_serving`) until it is closed.
    """

    async def answer(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            async with asyncio.timeout(_HEAD_SECONDS):
                head = await reader.readuntil(b"\r\n\r\n")
            writer.write(_answer_to(head.split(b"\r\n", 1)[0], health))
            await writer.drain()
        except (TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            # A connection that sent no request is owed no answer.
            pass
        finally:
            writer.close()
            with contextlib.suppress(ConnectionError):
                await writer.wait_closed()

    return await asyncio.start_server(answer, host=None, port=port, start_serving=False)
