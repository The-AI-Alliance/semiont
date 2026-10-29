"""A real client and a real session for tests. Every namespace, cache and deadline is the client's; only what it speaks through is a double.

A test scripts the doubles and observes through the client. What a test does
not give is a double that refuses: a request nobody scripted an answer for
fails naming its operation, a read of content nobody stored fails naming the
resource, and an operation of the gateway nobody scripted fails naming it.
"""

from dataclasses import dataclass
from typing import ClassVar, Final, TypedDict, Unpack, final

from semiont.client import CachePersistence, ClientTiming, SemiontClient
from semiont.session import MemorySignIn, SemiontSession, SignInKept
from semiont.testing.content import InMemoryContent
from semiont.testing.gateway import StubGateway
from semiont.testing.transport import FaultyTransport
from semiont.types import HttpEndpoint, KbTarget
from semiont.watched import Variable

__all__ = ["TestClient", "TestSession", "TestSessionOptions", "create_test_client", "create_test_session"]

_TEST_KB: Final = KbTarget(id="test-kb", label="Test KB", endpoint=HttpEndpoint(kind="http", host="localhost", port=4000, protocol="http"))
"""The knowledge base a test session is with, unless a test says another."""


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


class TestSessionOptions(TypedDict, total=False):
    """What a test session is built over: `create_test_session`'s keyword arguments. What a test leaves out is made."""

    client: TestClient
    """The test client the session is over. Left out, `create_test_client()`'s."""
    kb: KbTarget
    """The knowledge base the session is with. Left out, `test-kb` at `http://localhost:4000`."""
    kept: SignInKept
    """Where the session's sign-in is kept: a sign-in kept there is the session's at its start.

    Left out, a `MemorySignIn` that holds none.
    """


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class TestSession:
    """A session, and what it was built over."""

    # A name a test runner would otherwise take for a class of tests.
    __test__: ClassVar[bool] = False

    session: SemiontSession[FaultyTransport]
    client: SemiontClient[FaultyTransport]
    transport: FaultyTransport
    content: InMemoryContent
    gateway: StubGateway
    kept: SignInKept
    """Where the session's sign-in is kept."""
    token: Variable[str | None]
    """The token the session holds. A test that needs a signed-in session sets one."""


def create_test_session(**options: Unpack[TestSessionOptions]) -> TestSession:
    """A real `SemiontSession` over a test client.

    It renews nothing and asks nobody who it is, so, held with `async with`, it
    is ready as soon as it has read where its sign-in is kept, and holds a
    token only if one was kept there. It only uses its client: the caller ends
    the session and then the client, and whoever made the transport closes it.
    """
    given = options.get("client")
    made = create_test_client() if given is None else given
    kb = options.get("kb")
    kept = options.get("kept")
    held = MemorySignIn() if kept is None else kept
    token = Variable[str | None](None)
    session = SemiontSession(kb=_TEST_KB if kb is None else kb, client=made.client, token=token, kept=held)
    return TestSession(
        session=session, client=made.client, transport=made.transport, content=made.content, gateway=made.gateway, kept=held, token=token
    )
