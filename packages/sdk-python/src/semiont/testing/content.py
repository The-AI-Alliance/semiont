"""A `ContentTransport` with no wire, for tests.

It keeps what `put_binary` receives and gives it back to a read, and records
every call made of it. A read of a resource nobody stored fails as
`not-found`, as a gateway's would, so a test that forgot to seed its content
fails where it forgot rather than on bytes the double made up.
"""

import asyncio
from collections.abc import AsyncGenerator, Callable, Sequence
from dataclasses import dataclass
from typing import Final, final, override

from semiont.errors import TransportError
from semiont.identifiers import ResourceId
from semiont.transport import Content, ContentStream, ContentTransport, PutBinaryRequest, Upload, UploadProgress
from semiont.types import CreateResourceResponse, GetResourceResponse

__all__ = ["ContentCall", "GetBinary", "GetBinaryStream", "GetResourceGraph", "InMemoryContent", "PutBinary"]


@final
@dataclass(frozen=True, slots=True)
class PutBinary:
    """A call of `put_binary`, with what it was given."""

    request: PutBinaryRequest


@final
@dataclass(frozen=True, slots=True)
class GetBinary:
    """A call of `get_binary`."""

    resource_id: ResourceId


@final
@dataclass(frozen=True, slots=True)
class GetBinaryStream:
    """A call of `get_binary_stream`."""

    resource_id: ResourceId


@final
@dataclass(frozen=True, slots=True)
class GetResourceGraph:
    """A call of `get_resource_graph`."""

    resource_id: ResourceId


type ContentCall = PutBinary | GetBinary | GetBinaryStream | GetResourceGraph
"""One call made of the content transport."""


def _not_found(what: str, resource_id: ResourceId) -> TransportError:
    return TransportError.of_status(f"InMemoryContent: no {what} stored for {resource_id}", 404, None)


async def _whole(data: bytes) -> AsyncGenerator[bytes]:
    yield data


@final
class InMemoryContent(ContentTransport):
    """See the module's documentation."""

    def __init__(self) -> None:
        self._stored: Final[dict[ResourceId, Content]] = {}
        self._graphs: Final[dict[ResourceId, GetResourceResponse]] = {}
        self._calls: Final[list[ContentCall]] = []

    def seed(self, resource_id: ResourceId, content: Content) -> None:
        """Store `content` as the bytes of `resource_id`."""
        self._stored[resource_id] = content

    def seed_graph(self, resource_id: ResourceId, graph: GetResourceResponse) -> None:
        """Store `graph` as the description of `resource_id`."""
        self._graphs[resource_id] = graph

    @property
    def calls(self) -> Sequence[ContentCall]:
        """Every call made, in order."""
        return self._calls

    def _read(self, resource_id: ResourceId) -> Content:
        content = self._stored.get(resource_id)
        if content is None:
            raise _not_found("content", resource_id)
        return content

    @override
    def put_binary(self, request: PutBinaryRequest) -> Upload:
        """Stored under an id of this double's making, `test-content-<n>`."""

        async def stored(report: Callable[[UploadProgress], None]) -> CreateResourceResponse:
            resource_id = ResourceId(f"test-content-{len(self._stored) + 1}")
            self._stored[resource_id] = Content(data=request.file, content_type=request.format)
            self._calls.append(PutBinary(request))
            report(UploadProgress(bytes_uploaded=len(request.file), total_bytes=len(request.file)))
            return CreateResourceResponse(resource_id=resource_id)

        return Upload(lambda report: asyncio.ensure_future(stored(report)))

    @override
    async def get_binary(self, resource_id: ResourceId) -> Content:
        self._calls.append(GetBinary(resource_id))
        return self._read(resource_id)

    @override
    async def get_binary_stream(self, resource_id: ResourceId) -> ContentStream:
        self._calls.append(GetBinaryStream(resource_id))
        content = self._read(resource_id)
        return ContentStream(content.content_type, _whole(content.data))

    @override
    async def get_resource_graph(self, resource_id: ResourceId) -> GetResourceResponse:
        self._calls.append(GetResourceGraph(resource_id))
        graph = self._graphs.get(resource_id)
        if graph is None:
            raise _not_found("description", resource_id)
        return graph
