"""What stands in for the knowledge bases a worker serves: at each, its sign-in, the agent it names, and a stream over `Parties` each life.

The agent signs in with the SDK's `AgentToken`, opens its stream with its
`HttpTransport`, and holds a `SemiontClient` over it. Each is stood in for in
the agent's module by one that answers as the test scripts the knowledge base
at the gateway's address: a sign-in there succeeds, naming the agent by the
knowledge base's DID, or raises what the test has it raise; and each stream
opened there is over a `Parties` of its own, which the test scripts as the
stream opens and reads back once it has. A stream ends when the test closes
its `Parties`' transport, and is closed when the agent leaves it.
"""

from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from types import TracebackType
from typing import Final, Self, final

import pytest
from holding import Parties
from semiont.client import SemiontClient
from semiont.errors import SemiontError
from semiont.http import ServiceToken
from semiont.identifiers import UserId
from semiont.testing import FaultyTransport, InMemoryContent
from semiont.watched import Variable, Watched

from semiont_worker import agent


@final
class KnowledgeBaseStoodIn:
    """One knowledge base as a test scripts it: the domain it says it is, the agent there, what each sign-in raises, and each stream opened.

    `each_life` scripts each stream's `Parties` as it opens, given which life
    of the knowledge base's it is, from 0.
    """

    def __init__(self, gateway: str, domain: str, did: str, *, each_life: Callable[[Parties, int], None]) -> None:
        self.gateway: Final = gateway
        self.domain: Final = domain
        self.did: Final = UserId(did)
        self._each_life: Final = each_life
        self.refusing: Final[deque[SemiontError]] = deque()
        """What the next sign-ins there raise, one each. Once there is none, a sign-in succeeds."""
        self.sign_ins: int = 0
        """How many times the agent signed in there."""
        self.lives: Final[list[Parties]] = []
        """Each stream opened there, in order."""
        self.channels: Final[list[Sequence[str]]] = []
        """The channels each stream named."""

    @property
    def parties(self) -> Parties:
        """The last stream opened there."""
        assert self.lives, f"no stream was opened at {self.gateway}"
        return self.lives[-1]

    def opened(self) -> Parties:
        parties = Parties()
        parties.domain = self.domain
        self._each_life(parties, len(self.lives))
        self.lives.append(parties)
        return parties


@final
@dataclass(frozen=True, slots=True)
class _Opened:
    """A stream stood in for: what the agent reads content through, and the client the agent then holds over it."""

    content: InMemoryContent
    client: SemiontClient[FaultyTransport]


def stand_in(monkeypatch: pytest.MonkeyPatch, *knowledge_bases: KnowledgeBaseStoodIn) -> None:
    """Stand in for the sign-in, the stream and the client of the agent at each of `knowledge_bases`, by its gateway's address."""
    at: Mapping[str, KnowledgeBaseStoodIn] = {knowledge_base.gateway: knowledge_base for knowledge_base in knowledge_bases}

    @final
    class SignedIn:
        def __init__(self, gateway: str, *, service: ServiceToken) -> None:
            self._at: Final = at[gateway]
            self.token: Final[Watched[str | None]] = Variable[str | None]("issued")

        @property
        def did(self) -> UserId:
            return self._at.did

        async def refresh(self) -> str | None:
            return None

        async def __aenter__(self) -> Self:
            self._at.sign_ins += 1
            if self._at.refusing:
                raise self._at.refusing.popleft()
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

    @final
    class Stream:
        def __init__(self, gateway: str, *, token: object, refresher: object, channels: Sequence[str]) -> None:
            self._at: Final = at[gateway]
            self._channels: Final = channels
            self._parties: Parties | None = None

        async def __aenter__(self) -> _Opened:
            self._parties = self._at.opened()
            self._at.channels.append(self._channels)
            return _Opened(content=self._parties.content, client=self._parties.client)

        async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
            assert self._parties is not None
            await self._parties.transport.close()

    def client(transport: _Opened, content: object, operations: object) -> SemiontClient[FaultyTransport]:
        return transport.client

    monkeypatch.setattr(agent, "AgentToken", SignedIn)
    monkeypatch.setattr(agent, "HttpTransport", Stream)
    monkeypatch.setattr(agent, "SemiontClient", client)
