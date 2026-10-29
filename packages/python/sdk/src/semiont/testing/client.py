"""A real client for tests. Every namespace, cache and deadline is the client's own; only what it speaks through is a double.

A test scripts the doubles and observes through the client. What a test does
not give is a double that refuses: a request nobody scripted an answer for
fails naming its operation, a read of content nobody stored fails naming the
resource, and an operation of the gateway nobody scripted fails naming it.
"""

from dataclasses import dataclass
from typing import ClassVar, final

from semiont.client import CachePersistence, ClientTiming, SemiontClient
from semiont.testing.content import InMemoryContent
from semiont.testing.gateway import StubGateway
from semiont.testing.transport import FaultyTransport

__all__ = ["TestClient", "create_test_client"]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class TestClient:
    """A client, and the doubles it speaks through."""

    # A name a test runner would otherwise take for a class of tests.
    __test__: ClassVar[bool] = False

    client: SemiontClient[FaultyTransport]
    transport: FaultyTransport
    content: InMemoryContent
    gateway: StubGateway


def create_test_client(
    *,
    transport: FaultyTransport | None = None,
    content: InMemoryContent | None = None,
    gateway: StubGateway | None = None,
    timing: ClientTiming | None = None,
    persistence: CachePersistence | None = None,
) -> TestClient:
    """A real `SemiontClient` over a `FaultyTransport`, an `InMemoryContent` and a `StubGateway`.

    Each double is the one given, as the test scripted it; absent, one that
    nothing is scripted to answer and that holds nothing. `timing` and
    `persistence` are the client's own. The client is held with `async with`
    as any other is, and whoever made the transport closes it.
    """
    over = FaultyTransport() if transport is None else transport
    holding = InMemoryContent() if content is None else content
    answering = StubGateway() if gateway is None else gateway
    client = SemiontClient(over, holding, answering, timing=timing, persistence=persistence)
    return TestClient(client=client, transport=over, content=holding, gateway=answering)
