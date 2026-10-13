"""An embedding provider, played: enough of HTTP/1.1 to answer what a driver asks, as a test said to, and to keep what it was sent.

`Ollama` plays the one call the Ollama driver makes (`POST /api/embed`).
`Voyage` plays the one the Voyage driver makes (`POST /v1/embeddings`), from
Voyage's API reference (https://docs.voyageai.com/reference/embeddings-api):
nothing here has met the real service. What a request says its texts are
for is kept with it (`Asked.input_type`), and changes nothing of the answer.

A request is answered with a vector for each of its texts that says how long
the text is (`told`), unless the test said otherwise: with `script` (the
next requests, in the order they come) or with `rule` (a request, by the
texts it carries).

A stand-in listens while it is held with `async with`. One that `unstarted`
made has its address before that, and a connection to it is refused until it
is entered: that is how a provider that has not started yet looks.

A request of any other method or path lands in `unscripted`, which fails the
test on the way out.
"""

import asyncio
import socket
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from http import HTTPStatus
from types import TracebackType
from typing import Final, Self, final, override

from aio import pass_time, settle, soon
from pydantic import JsonValue, TypeAdapter
from spec import JsonObject, strings

from semiont_vectors.embedding import BatchPolicy, EmbeddingProvider, ProviderName
from semiont_vectors.ollama import OLLAMA_BATCH_POLICY, OllamaEmbeddingProvider
from semiont_vectors.voyage import VOYAGE_BATCH_POLICY, VoyageEmbeddingProvider

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

    @property
    def texts(self) -> list[str]:
        """The texts it asks the vectors of: its `input`."""
        return strings(self.json().get("input"), "input")

    @property
    def input_type(self) -> JsonValue:
        """What it says its texts are for: its `input_type`, and None where it carries none."""
        return self.json().get("input_type")


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
    after: float = 0.0
    """Say nothing for this many seconds of the loop's clock, and then answer."""
    drip: float | None = None
    """Send the head, and then the body one byte at a time, with this many seconds of the loop's clock before each byte."""


HOLD: Final = Answer(hold=True)
HANG_UP: Final = Answer(hang_up=True)


def saying(value: JsonValue, *, status: int = 200) -> Answer:
    """An answer whose body is `value`, as JSON."""
    return Answer(status=status, headers={"content-type": "application/json"}, body=_JSON.dump_json(value))


def told(text: str) -> list[float]:
    """The vector a stand-in answers a text with when nothing else was said: two numbers, the first of which is the text's length."""
    return [float(len(text)), 0.1]


async def _ended(awaited: Awaitable[object]) -> None:
    """Wait for `awaited`, whatever it answers."""
    await awaited


def _phrase(status: int) -> str:
    return HTTPStatus(status).phrase if status in HTTPStatus else "Refused"


def _unruled(texts: list[str]) -> Answer | None:
    """The rule of a stand-in no test gave one: nothing is said of any request."""
    return None


def always(answer: Answer) -> Callable[[list[str]], Answer]:
    """The rule of a stand-in that says `answer` to every request, whatever its texts."""

    def rule(texts: list[str]) -> Answer:
        return answer

    return rule


class Played(ABC):
    """A stand-in for a provider's one call. `origin` is where it is, once it listens or has reserved its address."""

    def __init__(self, *, name: ProviderName, policy: BatchPolicy, path: str) -> None:
        self.origin = ""
        self.name: Final = name
        """Which provider it plays, as a failure names it."""
        self.policy: Final = policy
        """How the driver of this provider asks for many texts."""
        self.path: Final = path
        self.asked: list[Asked] = []
        """Every request, in the order they came."""
        self.answered: list[Asked] = []
        """Every request an answer was sent to, in the order the answers were sent."""
        self.abandoned: list[Asked] = []
        """Every request whose connection the client closed while it was held unanswered."""
        self.unscripted: list[str] = []
        """Everything asked that is not this provider's call."""
        self.rule: Callable[[list[str]], Answer | None] = _unruled
        """What a request is answered with, by its texts, when nothing is scripted for it. With `None` it is answered as usual."""
        self.most_at_once = 0
        """The most requests that were being answered at one time."""
        self._being_answered = 0
        self._scripted: list[Answer] = []
        self._held: list[tuple[Asked, asyncio.Future[Answer]]] = []
        self._connections: set[asyncio.StreamWriter] = set()
        self._news = asyncio.Event()
        self._leaving = asyncio.Event()
        self._server: asyncio.Server | None = None
        # Where it listens once entered. With 0 it is wherever this machine has room.
        self._port: int = 0

    @abstractmethod
    def provider(self, model: str) -> EmbeddingProvider:
        """The driver of this provider, told that its provider is here and asked for `model`."""

    @abstractmethod
    def vectors(self, vectors: Sequence[Sequence[float]]) -> Answer:
        """What this provider answers a request with when these are the vectors of its texts, in the order of the texts."""

    def echo(self, texts: Sequence[str], *, after: float = 0.0, drip: float | None = None) -> Answer:
        """What these texts are answered with when nothing else was said: the vector that tells each one's length."""
        return replace(self.vectors([told(text) for text in texts]), after=after, drip=drip)

    def script(self, *answers: Answer) -> None:
        """What the next requests are answered with, in the order they come, after those already scripted."""
        self._scripted.extend(answers)

    @property
    def inputs(self) -> list[list[str]]:
        """The texts of every request, in the order the requests came."""
        return [asked.texts for asked in self.asked]

    def reserve(self) -> None:
        """Take an address now, and listen at it only once entered: until then a connection to `origin` is refused.

        The address is one this machine had room at a moment ago, and nothing
        holds it in between: no socket that is bound and does not listen is
        left there, since not every system refuses a connection to one.
        """
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as found:
            found.bind(("127.0.0.1", 0))
            self._port = found.getsockname()[1]
        self.origin = f"http://127.0.0.1:{self._port}"

    async def __aenter__(self) -> Self:
        self._server = await asyncio.start_server(self._connection, "127.0.0.1", self._port)
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
            assert self.unscripted == [], f"asked what is not this provider's call: {self.unscripted}"

    async def arrived(self, count: int = 1) -> None:
        """Wait until `count` requests have arrived."""
        await self._until(lambda: len(self.asked) >= count)

    async def given_up(self, count: int = 1) -> None:
        """Wait until the client has closed the connection of `count` requests that were held unanswered."""
        await self._until(lambda: len(self.abandoned) >= count)

    @property
    def holding(self) -> int:
        """How many requests are being held unanswered."""
        return len(self._held)

    def release(self) -> None:
        """Answer every held request as it would have been answered had it not been held: with the vector that tells each text's length."""
        held, self._held = self._held, []
        for asked, waiting in held:
            if not waiting.done():
                waiting.set_result(self.echo(asked.texts))

    def _answer(self, asked: Asked) -> Answer:
        """What this provider says to `asked`."""
        if (asked.method, asked.path) != ("POST", self.path):
            self.unscripted.append(f"{asked.method} {asked.path}")
            return saying({"error": "not found"}, status=404)
        if self._scripted:
            return self._scripted.pop(0)
        ruled = self.rule(asked.texts)
        return self.echo(asked.texts) if ruled is None else ruled

    async def _until(self, happened: Callable[[], bool]) -> None:
        while not happened():
            self._news.clear()
            await self._news.wait()

    async def _left_within(self, seconds: float) -> bool:
        """Wait `seconds` of the loop's clock, and no longer than the test stays. Whether the test left."""
        try:
            async with asyncio.timeout(seconds):
                await self._leaving.wait()
        except TimeoutError:
            return False
        return True

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
                self._being_answered += 1
                self.most_at_once = max(self.most_at_once, self._being_answered)
                self._news.set()
                try:
                    sent = await self._respond(asked, reader, writer)
                finally:
                    self._being_answered -= 1
                if not sent:
                    return
                self.answered.append(asked)
        except ConnectionError:
            pass
        finally:
            self._connections.discard(writer)
            writer.close()

    async def _respond(self, asked: Asked, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> bool:
        """Say to `asked` what the test said to. Whether an answer was sent whole, which leaves the connection good for another request."""
        answer = self._answer(asked)
        if answer.hang_up:
            return False
        if answer.hold:
            released = await self._hold(asked, reader)
            if released is None:
                return False
            answer = released
        if answer.after > 0 and await self._left_within(answer.after):
            return False
        head = [f"HTTP/1.1 {answer.status} {_phrase(answer.status)}", f"Content-Length: {len(answer.body)}"]
        head += [f"{name}: {value}" for name, value in answer.headers.items()]
        writer.write("\r\n".join(head).encode() + b"\r\n\r\n")
        if answer.drip is None:
            writer.write(answer.body)
        else:
            for place in range(len(answer.body)):
                await writer.drain()
                if await self._left_within(answer.drip):
                    return False
                writer.write(answer.body[place : place + 1])
        await writer.drain()
        return True

    async def _hold(self, asked: Asked, reader: asyncio.StreamReader) -> Answer | None:
        """Keep a request waiting. Returns what it is released with, or None when the client or the test left first."""
        released: asyncio.Future[Answer] = asyncio.get_running_loop().create_future()
        held = (asked, released)
        self._held.append(held)
        closed, answered, leaving = (
            asyncio.ensure_future(_ended(reader.read())),
            asyncio.ensure_future(_ended(released)),
            asyncio.ensure_future(_ended(self._leaving.wait())),
        )
        try:
            await asyncio.wait({closed, answered, leaving}, return_when=asyncio.FIRST_COMPLETED)
            if released.done():
                return released.result()
            if closed.done():
                self.abandoned.append(asked)
                self._news.set()
            return None
        finally:
            for waiting in (closed, answered, leaving):
                waiting.cancel()
            # Until the cancelled read has ended it is still waiting on the stream, and the next request cannot be read from it.
            await asyncio.gather(closed, answered, leaving, return_exceptions=True)
            if held in self._held:
                self._held.remove(held)


async def wait_out(played: Played, waits: Sequence[float]) -> None:
    """Move the loop's clock past each of `waits` in turn, each one once the request before it has arrived and been answered.

    It is how a test sees a provider asked again after a wait: no clock is
    hurried, so a request has all of its own time for each attempt.
    """
    for attempt, wait in enumerate(waits, start=1):
        await soon(played.arrived(attempt))
        # Long enough for the answer to be read, and for the wait that follows it to have begun.
        await settle()
        await pass_time(wait, step=wait)


type Play = Callable[[], Played]
"""Makes a stand-in: `Ollama` or `Voyage`, as a test that holds both providers to one case is handed them."""


def unstarted[P: Played](play: Callable[[], P]) -> P:
    """A stand-in that has its address and is not listening at it: a connection to it is refused, until the test enters it."""
    played = play()
    played.reserve()
    return played


# ── Ollama ──────────────────────────────────────────────────────────────

NOT_FETCHED: Final = saying({"error": 'model "nomic-embed-text" not found, try pulling it first'}, status=404)
"""What an Ollama says of a model it does not have, which is also what it says while the model is being fetched."""


@final
class Ollama(Played):
    """A stand-in Ollama, for `POST /api/embed`."""

    def __init__(self) -> None:
        super().__init__(name="ollama", policy=OLLAMA_BATCH_POLICY, path="/api/embed")

    @override
    def provider(self, model: str) -> EmbeddingProvider:
        return OllamaEmbeddingProvider(model=model, base_url=self.origin)

    @override
    def vectors(self, vectors: Sequence[Sequence[float]]) -> Answer:
        embeddings: list[JsonValue] = [[*vector] for vector in vectors]
        # What an Ollama says beside the vectors, which no driver reads.
        beside: JsonObject = {"model": "played", "total_duration": 14143917, "load_duration": 1019500, "prompt_eval_count": 8}
        return saying({**beside, "embeddings": embeddings})


# ── Voyage ──────────────────────────────────────────────────────────────

KEY: Final = "a-key"
"""The key the stand-in Voyage takes."""

MOST_TEXTS: Final = 1000
"""The most texts Voyage's reference says one request may carry."""


def items(vectors: Sequence[Sequence[float]]) -> list[JsonValue]:
    """The `data` of an answer of Voyage's: an item for each vector, which says which text it is of, in the order of the texts."""
    data: list[JsonValue] = []
    for index, vector in enumerate(vectors):
        data.append({"object": "embedding", "embedding": [*vector], "index": index})
    return data


def listed(data: list[JsonValue]) -> Answer:
    """An answer of Voyage's whose `data` is `data`, in the order given."""
    return saying({"object": "list", "data": data, "model": "played", "usage": {"total_tokens": len(data)}})


@final
class Voyage(Played):
    """A stand-in for Voyage's embeddings call, `POST /v1/embeddings`, as its reference states it.

    A request that does not carry `KEY` as its bearer token is answered 401,
    and one of more than `MOST_TEXTS` texts 400. The reference gives those
    statuses and no body for either: the bodies here are this stand-in's.
    """

    def __init__(self) -> None:
        super().__init__(name="voyage", policy=VOYAGE_BATCH_POLICY, path="/v1/embeddings")

    @property
    def endpoint(self) -> str:
        """The whole address of the call, as a config names it."""
        return f"{self.origin}{self.path}"

    @override
    def provider(self, model: str) -> EmbeddingProvider:
        return VoyageEmbeddingProvider(model=model, api_key=KEY, endpoint=self.endpoint)

    @override
    def vectors(self, vectors: Sequence[Sequence[float]]) -> Answer:
        return listed(items(vectors))

    @override
    def _answer(self, asked: Asked) -> Answer:
        if (asked.method, asked.path) == ("POST", self.path):
            if asked.headers.get("authorization") != f"Bearer {KEY}":
                return saying({"detail": "the key is not the one this stand-in takes"}, status=401)
            if len(asked.texts) > MOST_TEXTS:
                return saying({"detail": f"{len(asked.texts)} texts are more than one request may carry"}, status=400)
        return super()._answer(asked)
