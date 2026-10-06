"""Bytes over the gateway's HTTP transport, as a `semiont.transport.ContentTransport`.

An upload (`POST /resources`), a resource's bytes whole or as a stream
(`GET /resources/{id}`), and its description as linked data
(`GET /resources/{id}/jsonld`). Bytes never ride the bus.

It makes its requests as the bus transport makes its own, so one here is
refused, tried again and reported as any other; and each is made in a span of
the telemetry table (`content.put`, `content.get`, `content.get_graph`).
"""

import asyncio
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Sequence
from typing import Final, Self, final, override

import httpx
from pydantic import TypeAdapter

from semiont import telemetry
from semiont.errors import TransportError
from semiont.http.exchange import Exchange
from semiont.identifiers import ResourceId
from semiont.transport import Content, ContentStream, ContentTransport, PutBinaryRequest, Upload, UploadProgress
from semiont.types import Agent, CreateResourceResponse, GetResourceResponse, ResourceUpload

__all__ = ["HttpContentTransport", "form_of"]

# How much of an upload's body is handed to the connection at a time: the grain its progress is reported in.
_UPLOAD_PIECE_BYTES: Final = 64 * 1024

# The field of an upload's form that holds its bytes.
_FILE: Final = "file"
# The fields that come before the bytes, so whatever reads the form knows what the bytes are before it meets them.
_BEFORE_THE_BYTES: Final = ("name", "format", "storage_uri")

_AGENT: Final = TypeAdapter[Agent](Agent)
_AGENTS: Final = TypeAdapter[list[Agent]](list[Agent])
_NAMES: Final = TypeAdapter[list[str]](list[str])


def _flag(value: bool | None) -> str | None:
    return None if value is None else "true" if value else "false"


def _generated_by(generator: Agent | Sequence[Agent] | None) -> str | None:
    if generator is None:
        return None
    if isinstance(generator, Sequence):
        return _AGENTS.dump_json(list(generator), by_alias=True, exclude_unset=True).decode()
    return _AGENT.dump_json(generator, by_alias=True, exclude_unset=True).decode()


def form_of(request: PutBinaryRequest) -> ResourceUpload:
    """An upload as its form carries it: every field text but the bytes. A field with nothing to say is left out."""
    return ResourceUpload(
        name=request.name,
        file=request.file,
        format=request.format,
        storage_uri=request.storage_uri,
        language=request.language or None,
        entity_types=_NAMES.dump_json(list(request.entity_types)).decode() if request.entity_types else None,
        source_annotation_id=request.source_annotation_id,
        source_resource_id=request.source_resource_id,
        generation_prompt=request.generation_prompt or None,
        generator=_generated_by(request.generator),
        job_id=request.job_id,
        is_draft=_flag(request.is_draft),
        clone_token=request.clone_token or None,
        archive_original=_flag(request.archive_original),
    )


def _quoted(text: str) -> str:
    """`text` as a part's header states it: what would end the value, or the line, written as `%XX`."""
    return text.replace('"', "%22").replace("\r", "%0D").replace("\n", "%0A")


@final
class _Form:
    """A `multipart/form-data` body: each field under its own name, and the bytes as the part `file`."""

    def __init__(self, request: PutBinaryRequest) -> None:
        self.boundary: Final = f"semiont-{uuid.uuid4().hex}"
        form = form_of(request)
        fields = ResourceUpload.model_fields
        before: list[str] = []
        after: list[str] = []
        for name, field in fields.items():
            value: object = getattr(form, name)
            if name == _FILE or value is None:
                continue
            if not isinstance(value, str):
                raise TypeError(f"the upload form's {name} is not text")
            part = f'--{self.boundary}\r\nContent-Disposition: form-data; name="{_quoted(field.alias or name)}"\r\n\r\n{value}\r\n'
            (before if name in _BEFORE_THE_BYTES else after).append(part)
        named = f'name="{fields[_FILE].alias or _FILE}"; filename="{_quoted(form.name)}"'
        before.append(f"--{self.boundary}\r\nContent-Disposition: form-data; {named}\r\nContent-Type: {form.format}\r\n\r\n")
        # The parts before the bytes, the bytes, and what follows them: the bytes are not copied to make the body.
        self._parts: Final = ("".join(before).encode(), form.file, ("\r\n" + "".join(after) + f"--{self.boundary}--\r\n").encode())
        self.size: Final = sum(len(part) for part in self._parts)

    def pieces(self) -> list[memoryview]:
        """The body, a piece at a time."""
        return [
            memoryview(part)[start : start + _UPLOAD_PIECE_BYTES]
            for part in self._parts
            for start in range(0, len(part), _UPLOAD_PIECE_BYTES)
        ]


@final
class _Sending:
    """An upload's body as it is sent: each piece reported as it is handed to the connection."""

    def __init__(self, form: _Form, report: Callable[[UploadProgress], None]) -> None:
        self._pieces = iter(form.pieces())
        self._total = form.size
        self._sent = 0
        self._report = report

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> bytes:
        piece = next(self._pieces, None)
        if piece is None:
            raise StopAsyncIteration
        self._sent += len(piece)
        self._report(UploadProgress(bytes_uploaded=self._sent, total_bytes=self._total))
        return bytes(piece)


def _path_of(resource_id: ResourceId) -> str:
    """Where a resource is read.

    Its id is one segment of the path as it is: the rule an id is held to
    admits nothing a path reads as its own.
    """
    return f"/resources/{resource_id}"


def _content_type(response: httpx.Response) -> str:
    stated: str | None = response.headers.get("content-type")
    return stated or "application/octet-stream"


def _interrupted(resource_id: ResourceId, error: httpx.HTTPError) -> TransportError:
    """A read whose bytes stopped coming."""
    return TransportError.without_response(f"GET {_path_of(resource_id)} ended before its bytes did: {error!r}")


@final
class HttpContentTransport(ContentTransport):
    """Content over the gateway an `HttpTransport` speaks to. It is that transport's `content`."""

    def __init__(self, exchange: Exchange) -> None:
        self._exchange = exchange

    @override
    def put_binary(self, request: PutBinaryRequest) -> Upload:
        def start(report: Callable[[UploadProgress], None]) -> asyncio.Task[CreateResourceResponse]:
            return self._exchange.run(self._put(request, report))

        return Upload(start)

    async def _put(self, request: PutBinaryRequest, report: Callable[[UploadProgress], None]) -> CreateResourceResponse:
        form = _Form(request)
        with telemetry.putting(request.format, len(request.file)):
            # No deadline: how long an upload takes is how large the resource is.
            return await self._exchange.answer(
                CreateResourceResponse,
                "POST",
                "/resources",
                headers={"Content-Type": f"multipart/form-data; boundary={form.boundary}", "Content-Length": str(form.size)},
                content=_Sending(form, report),
                at_length=True,
            )

    @override
    async def get_binary(self, resource_id: ResourceId) -> Content:
        with telemetry.getting(resource_id, stream=False):
            # The deadline is on the bytes beginning to arrive: how long they take after that is how many there are.
            response = await self._exchange.begin("GET", _path_of(resource_id))
            try:
                data = await response.aread()
            except httpx.HTTPError as error:
                raise self._exchange.failed(_interrupted(resource_id, error)) from error
            finally:
                await response.aclose()
            return Content(data=data, content_type=_content_type(response))

    @override
    async def get_binary_stream(self, resource_id: ResourceId) -> ContentStream:
        with telemetry.getting(resource_id, stream=True):
            response = await self._exchange.begin("GET", _path_of(resource_id))
        return ContentStream(_content_type(response), self._arriving(resource_id, response))

    async def _arriving(self, resource_id: ResourceId, response: httpx.Response) -> AsyncGenerator[bytes]:
        pieces: AsyncIterator[bytes] = response.aiter_bytes()
        try:
            async for piece in pieces:
                yield piece
        except httpx.HTTPError as error:
            raise self._exchange.failed(_interrupted(resource_id, error)) from error
        finally:
            # A read left early is ended here, by the one who left it.
            if isinstance(pieces, AsyncGenerator):
                await pieces.aclose()
            await response.aclose()

    @override
    async def get_resource_graph(self, resource_id: ResourceId) -> GetResourceResponse:
        with telemetry.getting_graph(resource_id):
            return await self._exchange.answer(GetResourceResponse, "GET", f"{_path_of(resource_id)}/jsonld")
