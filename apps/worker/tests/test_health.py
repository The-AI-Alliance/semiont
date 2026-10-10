"""The health endpoint: `GET /health`, and nothing else.

`docs/protocol/WORKER-SERVICE.md` H1 states it. The endpoint is HTTP written
out by hand, so each request here is written out by hand too.
"""

import asyncio
import json
import socket

import pytest
from aio import pass_time, run, turns
from pydantic import JsonValue

from semiont_worker.health import Health, bind_health

SAID: JsonValue = {"status": "ok", "agents": 1, "workers": [{"provider": "ollama", "model": "gemma2:27b", "jobsCompleted": 0}]}


async def serve_health(port: int, health: Health) -> asyncio.Server:
    """An endpoint on `port` that has been told to serve."""
    server = await bind_health(port, health)
    await server.start_serving()
    return server


def port_of(server: asyncio.Server) -> int:
    """The port a server asked for any port was given, on the addresses a request here is sent to.

    Asked for any port, it is given one for each family of address it listens on.
    """
    (listening,) = [listener for listener in server.sockets if listener.family == socket.AF_INET]
    name: tuple[object, ...] = listening.getsockname()
    port = name[1]
    assert isinstance(port, int)
    return port


async def asked(port: int, request: bytes) -> tuple[str, dict[str, str], bytes]:
    """What the endpoint answers `request` with: its status line, its headers, and its body. The connection is read to its end."""
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(request)
    await writer.drain()
    answer = await reader.read()
    writer.close()
    await writer.wait_closed()
    head, _, body = answer.partition(b"\r\n\r\n")
    status, *stated = head.decode("ascii").split("\r\n")
    headers = {name.lower(): value for name, value in (line.split(": ", 1) for line in stated)}
    return status, headers, body


def get(path: str) -> bytes:
    return f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode("ascii")


def test_get_health_is_answered_200_with_what_the_service_says_as_json() -> None:
    async def scenario() -> None:
        server = await serve_health(0, lambda: SAID)
        try:
            status, headers, body = await asked(port_of(server), get("/health"))
            assert status == "HTTP/1.1 200 OK"
            assert headers["content-type"] == "application/json"
            assert headers["content-length"] == str(len(body))
            assert headers["connection"] == "close"
            assert json.loads(body) == SAID
        finally:
            server.close()
            await server.wait_closed()

    run(scenario())


def test_each_request_is_answered_with_what_the_service_says_then() -> None:
    async def scenario() -> None:
        completed = 0

        def health() -> JsonValue:
            return {"status": "ok", "jobsCompleted": completed}

        server = await serve_health(0, health)
        try:
            assert json.loads((await asked(port_of(server), get("/health")))[2]) == {"status": "ok", "jobsCompleted": 0}
            completed = 3
            assert json.loads((await asked(port_of(server), get("/health")))[2]) == {"status": "ok", "jobsCompleted": 3}
        finally:
            server.close()
            await server.wait_closed()

    run(scenario())


@pytest.mark.parametrize("path", ["/health?probe=1", "/health?", "/health?a=b&c=/health/x"])
def test_the_path_is_matched_without_its_query_string(path: str) -> None:
    async def scenario() -> None:
        server = await serve_health(0, lambda: SAID)
        try:
            status, _, body = await asked(port_of(server), get(path))
            assert status == "HTTP/1.1 200 OK"
            assert json.loads(body) == SAID
        finally:
            server.close()
            await server.wait_closed()

    run(scenario())


@pytest.mark.parametrize(
    "request_line",
    [
        "GET / HTTP/1.1",
        "GET /health/ HTTP/1.1",
        "GET /healthz HTTP/1.1",
        "GET /healthz?probe=1 HTTP/1.1",
        "GET /api/health HTTP/1.1",
        "GET /HEALTH HTTP/1.1",
        "POST /health HTTP/1.1",
        "HEAD /health HTTP/1.1",
        "PUT /health HTTP/1.1",
        "DELETE /health HTTP/1.1",
        "OPTIONS /health HTTP/1.1",
        "get /health HTTP/1.1",
        "GET /health",
        "nonsense",
        "",
    ],
)
def test_anything_else_is_answered_404_with_no_body(request_line: str) -> None:
    async def scenario() -> None:
        def unasked() -> JsonValue:
            raise AssertionError("the service is asked nothing for a request it does not answer")

        server = await serve_health(0, unasked)
        try:
            status, headers, body = await asked(port_of(server), f"{request_line}\r\nHost: 127.0.0.1\r\n\r\n".encode("ascii"))
            assert status == "HTTP/1.1 404 Not Found"
            assert headers["content-length"] == "0"
            assert "content-type" not in headers
            assert body == b""
        finally:
            server.close()
            await server.wait_closed()

    run(scenario())


def test_a_connection_that_sends_no_request_is_answered_nothing_and_the_next_is_answered() -> None:
    async def scenario() -> None:
        server = await serve_health(0, lambda: SAID)
        try:
            _, writer = await asyncio.open_connection("127.0.0.1", port_of(server))
            writer.write(b"GET /health HTTP/1.1\r\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()
            assert (await asked(port_of(server), get("/health")))[0] == "HTTP/1.1 200 OK"
        finally:
            server.close()
            await server.wait_closed()

    run(scenario())


def test_a_port_something_else_listens_on_is_refused() -> None:
    async def scenario() -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as holder:
            holder.bind(("0.0.0.0", 0))
            holder.listen()
            taken: tuple[object, ...] = holder.getsockname()
            port = taken[1]
            assert isinstance(port, int)
            with pytest.raises(OSError, match="address"):
                await serve_health(port, lambda: SAID)

    run(scenario())


def test_once_closed_it_answers_no_more() -> None:
    async def scenario() -> None:
        server = await serve_health(0, lambda: SAID)
        port = port_of(server)
        server.close()
        await server.wait_closed()
        with pytest.raises(ConnectionRefusedError):
            await asyncio.open_connection("127.0.0.1", port)

    run(scenario())


def test_an_endpoint_that_has_taken_its_port_answers_nothing_until_it_is_told_to_serve() -> None:
    async def scenario() -> None:
        server = await bind_health(0, lambda: SAID)
        port = port_of(server)
        try:
            # Nothing listens yet: a request is refused where it connects, and waits for no answer.
            with pytest.raises(ConnectionRefusedError):
                await asyncio.open_connection("127.0.0.1", port)
            await server.start_serving()
            assert (await asked(port, get("/health")))[0] == "HTTP/1.1 200 OK"
        finally:
            server.close()
            await server.wait_closed()

    run(scenario())


def test_a_connection_that_does_not_finish_its_request_s_head_in_ten_seconds_is_closed() -> None:
    async def scenario() -> None:
        server = await serve_health(0, lambda: SAID)
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", port_of(server))
            writer.write(b"GET /health HTTP/1.1\r\n")
            await writer.drain()
            await asyncio.sleep(0.05)
            await turns()
            # Short of ten seconds the endpoint is still waiting for the rest.
            await pass_time(9, step=1)
            assert not reader.at_eof()
            await pass_time(2, step=1)
            # Then it gives the connection up, having answered nothing.
            assert await asyncio.wait_for(reader.read(), 5) == b""
            writer.close()
            await writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()

    run(scenario())
