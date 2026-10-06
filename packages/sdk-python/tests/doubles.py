"""A content transport and a gateway that record what they were asked, and hold nothing.

For tests of what a client asks for. What each call was given is recorded as
`specs/src/client/surface.json` names and states it; every answer is a
refusal, since a test of what was asked does not judge what was answered.
"""

import asyncio
from typing import final, override

from spec import JsonObject

from semiont.errors import TransportError
from semiont.identifiers import ResourceId
from semiont.transport import Content, ContentStream, ContentTransport, GatewayOperations, PutBinaryRequest, Upload
from semiont.types import (
    CreateResourceResponse,
    GetResourceResponse,
    HealthResponse,
    MediaTokenResponse,
    ProtectedResourceMetadata,
    StatusResponse,
    UserResponse,
)


def held_nothing(what: str) -> TransportError:
    return TransportError("not-found", f"the double holds nothing: {what}", status=404)


@final
class RecordingContent(ContentTransport):
    """Every call of the content transport, as the table names it, with what it was given."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, JsonObject]] = []

    @override
    def put_binary(self, request: PutBinaryRequest) -> Upload:
        given: JsonObject = {
            "name": request.name,
            "content": request.file.decode(),
            "format": request.format,
            "storageUri": request.storage_uri,
        }
        if request.clone_token is not None:
            given["cloneToken"] = request.clone_token
        self.calls.append(("putBinary", given))

        async def refused() -> CreateResourceResponse:
            raise held_nothing("putBinary")

        return Upload(lambda _: asyncio.ensure_future(refused()))

    @override
    async def get_binary(self, resource_id: ResourceId) -> Content:
        self.calls.append(("getBinary", {"resourceId": resource_id}))
        raise held_nothing("getBinary")

    @override
    async def get_binary_stream(self, resource_id: ResourceId) -> ContentStream:
        self.calls.append(("getBinaryStream", {"resourceId": resource_id}))
        raise held_nothing("getBinaryStream")

    @override
    async def get_resource_graph(self, resource_id: ResourceId) -> GetResourceResponse:
        self.calls.append(("getResourceGraph", {"resourceId": resource_id}))
        raise held_nothing("getResourceGraph")


@final
class RecordingGateway(GatewayOperations):
    """Every call of the gateway's own operations, as the table names it, with what it was given."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, JsonObject]] = []

    @override
    async def get_current_user(self) -> UserResponse:
        self.calls.append(("getCurrentUser", {}))
        raise held_nothing("getCurrentUser")

    @override
    async def get_media_token(self, resource_id: ResourceId) -> MediaTokenResponse:
        self.calls.append(("getMediaToken", {"resourceId": resource_id}))
        raise held_nothing("getMediaToken")

    @override
    async def get_protected_resource_metadata(self) -> ProtectedResourceMetadata:
        self.calls.append(("getProtectedResourceMetadata", {}))
        raise held_nothing("getProtectedResourceMetadata")

    @override
    async def health_check(self) -> HealthResponse:
        self.calls.append(("healthCheck", {}))
        raise held_nothing("healthCheck")

    @override
    async def get_status(self) -> StatusResponse:
        self.calls.append(("getStatus", {}))
        raise held_nothing("getStatus")
