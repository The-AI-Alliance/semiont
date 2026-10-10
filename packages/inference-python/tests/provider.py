"""A provider, played: enough of HTTP/1.1 to answer what a driver asks, from what a test scripted, and to keep what it was sent.

`Ollama` plays the two calls the Ollama driver makes (`POST /api/show`, `POST
/api/generate`), as `tests/conformance/harness/ollama.ts` plays them for the
Worker service's suite. `Anthropic` plays the three the Anthropic driver makes
through Anthropic's library: the Models API, the one-token probe, and a
generation answered whole or as a stream of events, whichever was asked for.

A request nothing was scripted for, and a request of any other path, lands in
`unscripted`, which fails the test on the way out.
"""

import asyncio
from abc import ABC, abstractmethod
from collections.abc import Awaitable
from dataclasses import dataclass, field
from http import HTTPStatus
from types import TracebackType
from typing import Final, Self, final, override

from pydantic import JsonValue, TypeAdapter
from spec import JsonObject

_OBJECT = TypeAdapter[JsonObject](JsonObject)
_JSON = TypeAdapter[JsonValue](JsonValue)


@final
@dataclass(frozen=True, slots=True)
class Asked:
    """One request, as it arrived."""

    method: str
    path: str
    headers: dict[str, str]
    body: bytes
    at: float
    """When it arrived, by the loop's clock."""

    def json(self) -> JsonObject:
        """Its body, which is a JSON object."""
        return _OBJECT.validate_json(self.body)


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Answer:
    """What the provider says to one request."""

    status: int = 200
    headers: dict[str, str] = field(default_factory=dict[str, str])
    body: bytes = b"{}"
    hold: bool = False
    """Say nothing until `release`, or until the client closes the connection."""
    hang_up: bool = False
    """Close the connection without a word."""


HOLD: Final = Answer(hold=True)
HANG_UP: Final = Answer(hang_up=True)


def saying(value: JsonValue, *, status: int = 200, headers: dict[str, str] | None = None) -> Answer:
    """An answer whose body is `value`, as JSON."""
    return Answer(status=status, headers={"content-type": "application/json", **(headers or {})}, body=_JSON.dump_json(value))


async def _until(awaited: Awaitable[object]) -> None:
    """Wait for `awaited`, whatever it answers."""
    await awaited


def _phrase(status: int) -> str:
    return HTTPStatus(status).phrase if status in HTTPStatus else "Refused"


class Played(ABC):
    """Held with `async with`. `origin` is the base URL a driver is given."""

    def __init__(self) -> None:
        self.asked: list[Asked] = []
        """Every request, in the order they came."""
        self.unscripted: list[str] = []
        """Everything asked that no test scripted."""
        self.closed_by_client = asyncio.Event()
        """Set when a connection a request was being held on is closed from the other end."""
        self.origin = ""
        self._arrival = asyncio.Event()
        self._held: list[asyncio.Future[Answer]] = []
        self._connections: set[asyncio.StreamWriter] = set()
        self._leaving = asyncio.Event()
        self._server: asyncio.Server | None = None

    @abstractmethod
    def _answer(self, asked: Asked) -> Answer:
        """What this provider says to `asked`."""

    async def __aenter__(self) -> Self:
        self._server = await asyncio.start_server(self._connection, "127.0.0.1", 0)
        self.origin = f"http://127.0.0.1:{self._server.sockets[0].getsockname()[1]}"
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self._leaving.set()
        if self._server is not None:
            self._server.close()
            # Whatever a client still holds open is closed from this end: leaving waits for nobody.
            for connection in list(self._connections):
                connection.close()
            await self._server.wait_closed()
        if error is None:
            assert self.unscripted == [], f"asked what no test scripted: {self.unscripted}"

    def of(self, method: str, path: str) -> list[Asked]:
        """The requests of one method and path."""
        return [asked for asked in self.asked if (asked.method, asked.path) == (method, path)]

    async def arrived(self, method: str, path: str, count: int = 1) -> None:
        """Wait until `count` requests of a method and path have arrived."""
        while len(self.of(method, path)) < count:
            self._arrival.clear()
            await self._arrival.wait()

    @property
    def holding(self) -> int:
        """How many requests are being held unanswered."""
        return len(self._held)

    def release(self, answer: Answer) -> None:
        """Answer every held request with `answer`."""
        held, self._held = self._held, []
        for waiting in held:
            if not waiting.done():
                waiting.set_result(answer)

    async def _connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._connections.add(writer)
        try:
            while request_line := await reader.readline():
                method, path = request_line.decode().split(" ")[:2]
                headers: dict[str, str] = {}
                while (line := await reader.readline()).strip():
                    name, _, value = line.decode().partition(":")
                    headers[name.strip().lower()] = value.strip()
                body = await reader.readexactly(int(headers.get("content-length", "0")))
                asked = Asked(method, path, headers, body, asyncio.get_running_loop().time())
                self.asked.append(asked)
                self._arrival.set()
                answer = self._answer(asked)
                if answer.hang_up:
                    return
                if answer.hold:
                    released = await self._hold(reader)
                    if released is None:
                        return
                    answer = released
                head = [f"HTTP/1.1 {answer.status} {_phrase(answer.status)}", f"Content-Length: {len(answer.body)}"]
                head += [f"{name}: {value}" for name, value in answer.headers.items()]
                writer.write("\r\n".join(head).encode() + b"\r\n\r\n" + answer.body)
                await writer.drain()
        except ConnectionError:
            pass
        finally:
            self._connections.discard(writer)
            writer.close()

    async def _hold(self, reader: asyncio.StreamReader) -> Answer | None:
        """Keep a request waiting. Returns what it is released with, or None when the client or the test left first."""
        released: asyncio.Future[Answer] = asyncio.get_running_loop().create_future()
        self._held.append(released)
        closed, answered, leaving = (
            asyncio.ensure_future(_until(reader.read())),
            asyncio.ensure_future(_until(released)),
            asyncio.ensure_future(_until(self._leaving.wait())),
        )
        try:
            await asyncio.wait({closed, answered, leaving}, return_when=asyncio.FIRST_COMPLETED)
            if released.done():
                return released.result()
            if closed.done():
                self.closed_by_client.set()
            return None
        finally:
            for waiting in (closed, answered, leaving):
                waiting.cancel()
            if released in self._held:
                self._held.remove(released)


# ── Ollama ──────────────────────────────────────────────────────────────


def shown(model_info: JsonObject) -> Answer:
    """What `/api/show` answers for a model whose metadata is `model_info`."""
    return saying({"model_info": model_info})


def window(context_length: int) -> Answer:
    """What `/api/show` answers for a model with a window of `context_length` tokens."""
    return shown({"general.architecture": "llama", "llama.context_length": context_length})


def generated(
    response: str,
    *,
    done_reason: str | None = "stop",
    prompt_eval_count: int | None = None,
    eval_count: int | None = None,
    thinking: str | None = None,
) -> Answer:
    """What `/api/generate` answers: the model said `response`, and stopped for `done_reason`. A count is stated only when given."""
    body: JsonObject = {"response": response, "done": True}
    if done_reason is not None:
        body["done_reason"] = done_reason
    if thinking is not None:
        body["thinking"] = thinking
    if prompt_eval_count is not None:
        body["prompt_eval_count"] = prompt_eval_count
    if eval_count is not None:
        body["eval_count"] = eval_count
    return saying(body)


@final
class Ollama(Played):
    """A stand-in Ollama. `show` is what `/api/show` answers; `script` queues the answers of the next generations."""

    def __init__(self, context_length: int = 8192) -> None:
        super().__init__()
        self.show: Answer = window(context_length)
        self._scripted: list[Answer] = []

    def script(self, *answers: Answer) -> None:
        """The answers the next generations get, in order, after those already scripted."""
        self._scripted.extend(answers)

    @property
    def shows(self) -> list[JsonObject]:
        """The body of every `POST /api/show`, in order."""
        return [asked.json() for asked in self.of("POST", "/api/show")]

    @property
    def generations(self) -> list[JsonObject]:
        """The body of every `POST /api/generate`, in order."""
        return [asked.json() for asked in self.of("POST", "/api/generate")]

    @override
    def _answer(self, asked: Asked) -> Answer:
        if (asked.method, asked.path) == ("POST", "/api/show"):
            return self.show
        if (asked.method, asked.path) == ("POST", "/api/generate"):
            if self._scripted:
                return self._scripted.pop(0)
            self.unscripted.append(f"generation {len(self.generations)}")
            return saying({"error": "the stand-in has no reply scripted"}, status=500)
        self.unscripted.append(f"{asked.method} {asked.path}")
        return saying({"error": "not found"}, status=404)


# ── Anthropic ───────────────────────────────────────────────────────────

TEMPERATURE_REFUSED: Final = saying(
    {"type": "error", "error": {"type": "invalid_request_error", "message": "`temperature` is deprecated for this model."}},
    status=400,
)
"""What a model that takes no `temperature` says to a request carrying one."""


def refused(status: int, kind: str, message: str) -> Answer:
    """A refusal as Anthropic's API states one. It asks to be tried again at once, so a test of the library's retries does not wait."""
    return saying({"type": "error", "error": {"type": kind, "message": message}}, status=status, headers={"retry-after-ms": "1"})


def model_info(
    *, max_input_tokens: int | None = 200_000, max_tokens: int | None = 64_000, structured_outputs: bool | None = True
) -> Answer:
    """What the Models API answers for one model. With `structured_outputs` None it states no capabilities at all."""
    info: JsonObject = {
        "type": "model",
        "id": "claude-played",
        "display_name": "Claude, played",
        "created_at": "2026-01-01T00:00:00Z",
        "lifecycle": "active",
        "max_input_tokens": max_input_tokens,
        "max_tokens": max_tokens,
    }
    if structured_outputs is not None:
        info["capabilities"] = {
            "batch": {"supported": True},
            "citations": {"supported": True},
            "image_input": {"supported": True},
            "pdf_input": {"supported": True},
            "structured_outputs": {"supported": structured_outputs},
        }
    return saying(info)


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Reply:
    """What a model answers a generation with. It is sent whole or as a stream of events, as the request asked."""

    content: list[JsonObject]
    stop_reason: str | None
    usage: JsonObject
    # What the provider says of a refusal, beside a `stop_reason` of `refusal`.
    stop_details: JsonObject | None = None


def reply(text: str, *, stop_reason: str | None = "end_turn", usage: JsonObject | None = None) -> Reply:
    """A reply of one text block. With no `usage` given it reports ten tokens read and five written."""
    return Reply(
        content=[{"type": "text", "text": text}],
        stop_reason=stop_reason,
        usage={"input_tokens": 10, "output_tokens": 5} if usage is None else usage,
    )


def _event(name: str, data: JsonObject) -> bytes:
    return f"event: {name}\ndata: ".encode() + _OBJECT.dump_json(data) + b"\n\n"


@final
class Anthropic(Played):
    """A stand-in for Anthropic's API.

    `model` is what the Models API answers. The probe (the one request that
    asks for a single token) is answered by the model itself, unless `probes`
    holds an answer for it. A model that `refuses_temperature` answers 400 to
    any request that carries one. `script` queues the replies of the next
    generations.
    """

    def __init__(self) -> None:
        super().__init__()
        self.model: Answer = model_info()
        self.refuses_temperature = False
        self.probes: list[Answer] = []
        self._scripted: list[Reply | Answer] = []

    def script(self, *replies: Reply | Answer) -> None:
        """What the next generations are answered with, in order, after those already scripted."""
        self._scripted.extend(replies)

    @property
    def retrievals(self) -> list[str]:
        """The path of every request of the Models API, in order."""
        return [asked.path for asked in self.asked if asked.method == "GET" and asked.path.startswith("/v1/models/")]

    @property
    def messages(self) -> list[Asked]:
        """Every `POST /v1/messages`, in order: the probes and the generations."""
        return self.of("POST", "/v1/messages")

    @property
    def probed(self) -> list[JsonObject]:
        """The body of every probe, in order."""
        return [body for body in (asked.json() for asked in self.messages) if body.get("max_tokens") == 1]

    @property
    def generations(self) -> list[JsonObject]:
        """The body of every generation, in order."""
        return [body for body in (asked.json() for asked in self.messages) if body.get("max_tokens") != 1]

    @override
    def _answer(self, asked: Asked) -> Answer:
        if asked.method == "GET" and asked.path.startswith("/v1/models/"):
            return self.model
        if (asked.method, asked.path) != ("POST", "/v1/messages"):
            self.unscripted.append(f"{asked.method} {asked.path}")
            return saying({"type": "error", "error": {"type": "not_found_error", "message": "not found"}}, status=404)
        body = asked.json()
        request_id = f"req_played_{len(self.messages)}"
        if body.get("max_tokens") == 1:
            if self.probes:
                return self.probes.pop(0)
            if self.refuses_temperature and "temperature" in body:
                return TEMPERATURE_REFUSED
            return self._whole(body, reply("ok", stop_reason="max_tokens", usage={"input_tokens": 8, "output_tokens": 1}), request_id)
        if self.refuses_temperature and "temperature" in body:
            return TEMPERATURE_REFUSED
        if not self._scripted:
            self.unscripted.append(f"generation {len(self.generations)}")
            return saying({"type": "error", "error": {"type": "api_error", "message": "the stand-in has no reply scripted"}}, status=500)
        scripted = self._scripted.pop(0)
        if isinstance(scripted, Answer):
            return scripted
        return self._stream(body, scripted, request_id) if body.get("stream") is True else self._whole(body, scripted, request_id)

    @staticmethod
    def _message(body: JsonObject, said: Reply, content: list[JsonObject], stop_reason: str | None) -> JsonObject:
        return {
            "id": "msg_played",
            "type": "message",
            "role": "assistant",
            "model": body["model"],
            "content": [*content],
            "stop_reason": stop_reason,
            "stop_details": said.stop_details if stop_reason is not None else None,
            "stop_sequence": None,
            "usage": said.usage,
        }

    def _whole(self, body: JsonObject, said: Reply, request_id: str) -> Answer:
        """The reply as one message."""
        return saying(self._message(body, said, said.content, said.stop_reason), headers={"request-id": request_id})

    def _stream(self, body: JsonObject, said: Reply, request_id: str) -> Answer:
        """The reply as the events of a stream: each text block in two pieces, with a ping between them."""
        events = [_event("message_start", {"type": "message_start", "message": self._message(body, said, [], None)})]
        for index, block in enumerate(said.content):
            text = block["text"]
            assert isinstance(text, str), "the stand-in streams text blocks alone"
            half = len(text) // 2
            events += [
                _event(
                    "content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}
                ),
                _event(
                    "content_block_delta",
                    {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text[:half]}},
                ),
                _event("ping", {"type": "ping"}),
                _event(
                    "content_block_delta",
                    {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text[half:]}},
                ),
                _event("content_block_stop", {"type": "content_block_stop", "index": index}),
            ]
        events += [
            _event(
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": said.stop_reason, "stop_sequence": None},
                    "usage": {"output_tokens": said.usage.get("output_tokens")},
                },
            ),
            _event("message_stop", {"type": "message_stop"}),
        ]
        return Answer(headers={"content-type": "text/event-stream", "request-id": request_id}, body=b"".join(events))
