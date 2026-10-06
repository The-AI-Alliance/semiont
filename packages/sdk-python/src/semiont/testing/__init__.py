"""What a consumer's tests are built on: a real client over doubles.

`create_test_client` gives a real `SemiontClient` (its namespaces, its cache
and its deadlines are the client's own) over a transport a test scripts
(`FaultyTransport`), a content transport that keeps what it is given
(`InMemoryContent`), and a gateway that answers only what it was told to
(`StubGateway`). A test scripts the doubles and observes through the client.

    made = create_test_client()
    made.transport.queue_reply("browse:resource-requested", [{"resource": {...}, ...}])
    async with made.client as client:
        described = await client.browse.resource(resource_id).fresh()
    assert made.transport.request_log[0].payload == {"resourceId": resource_id}

A double answers what a test told it to and refuses the rest by name. It
never answers with a value of its own making: a request nobody scripted an
answer for fails naming its operation, and a read of content nobody stored
fails naming the resource, so a test that forgot to say something fails where
it forgot.
"""

from semiont.testing.client import TestClient, create_test_client
from semiont.testing.content import ContentCall, GetBinary, GetBinaryStream, GetResourceGraph, InMemoryContent, PutBinary
from semiont.testing.gateway import StubGateway
from semiont.testing.transport import (
    Delay,
    Deliver,
    DropReply,
    DuplicateReply,
    FaultAction,
    FaultyTransport,
    MakeResponse,
    Refuse,
    RejectEmit,
    RequestLogEntry,
    refuse_unscripted_operation,
    retry_key_of,
)

__all__ = [
    "ContentCall",
    "Delay",
    "Deliver",
    "DropReply",
    "DuplicateReply",
    "FaultAction",
    "FaultyTransport",
    "GetBinary",
    "GetBinaryStream",
    "GetResourceGraph",
    "InMemoryContent",
    "MakeResponse",
    "PutBinary",
    "Refuse",
    "RejectEmit",
    "RequestLogEntry",
    "StubGateway",
    "TestClient",
    "create_test_client",
    "refuse_unscripted_operation",
    "retry_key_of",
]
