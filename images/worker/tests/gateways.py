"""What stands in for the knowledge bases a worker serves: at each, its sign-in, the agent it names, which it is, and a stream each life.

The agent signs in with the SDK's `AgentToken`, opens its streams with its
`HttpTransport`, and holds a `SemiontClient` over its own. Each is stood in
for in the agent's module by one that answers as the test scripts the
knowledge base at the gateway's address: a sign-in there succeeds, naming the
agent by the knowledge base's DID, or raises what the test has it raise; the
stream the agent asks which knowledge base it is on answers as the test
scripts that; and each stream of the agent's own opened there is over a
`Parties` of its own, which the test scripts as the stream opens and reads
back once it has. A stream ends when the test closes its transport, and is
closed when the agent leaves it.
"""

from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from types import TracebackType
from typing import Final, Self, final

import pytest
from holding import Parties
from pydantic import JsonValue
from semiont.client import SemiontClient
from semiont.errors import SemiontError
from semiont.http import ServiceToken
from semiont.identifiers import UserId
from semiont.testing import FaultyTransport, InMemoryContent
from semiont.watched import Variable, Watched
from semiont_service.knowledge_base import CONFIRMING_CHANNELS

from semiont_worker import agent


@final
class KnowledgeBaseStoodIn:
    """One knowledge base as a test scripts it: which it says it is, the agent there, what each sign-in raises, and each stream opened.

    `each_life` scripts each of the agent's streams' `Parties` as it opens,
    given which life of the knowledge base's it is, from 0: each sign-in
    begins one.
    """

    def __init__(self, gateway: str, domain: str | None, did: str, *, each_life: Callable[[Parties, int], None]) -> None:
        self.gateway: Final = gateway
        self.domain: str | None = domain
        """The domain it answers `browse:kb-requested` with: `None` where it answers `browse:kb-failed`."""
        self.away: int = 0
        """How many more times it is asked which it is before the Archivist is there to answer: each is answered `bus.peer-unavailable`."""
        self.unheard: bool = False
        """Whether a stream the agent asks which it is on never opens, so that the question waits out its deadline."""
        self.asked: int = 0
        """How many times it was asked which it is."""
        self.did: Final = UserId(did)
        self._each_life: Final = each_life
        self.refusing: Final[deque[SemiontError]] = deque()
        """What the next sign-ins there raise, one each. Once there is none, a sign-in succeeds."""
        self.sign_ins: int = 0
        """How many times the agent signed in there."""
        self.lives: Final[list[Parties]] = []
        """Each of the agent's own streams opened there, in order."""
        self.streams: Final[list[tuple[str, Sequence[str]]]] = []
        """Each stream opened and closed there, in order: `opened` or `closed`, and what it names."""

    @property
    def parties(self) -> Parties:
        """The last of the agent's own streams opened there."""
        assert self.lives, f"no stream was opened at {self.gateway}"
        return self.lives[-1]

    def opened(self) -> Parties:
        parties = Parties()
        self._each_life(parties, self.sign_ins - 1)
        self.lives.append(parties)
        return parties

    def asking(self) -> FaultyTransport:
        """A stream the agent asks which knowledge base it is on, answering as the test scripts that."""
        transport = FaultyTransport(make_response=self._answer, channels=CONFIRMING_CHANNELS)
        transport.refuse_when(self._refusal)
        if self.unheard:
            transport.set_state("reconnecting")
        return transport

    def _refusal(self, operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        assert operation == "browse:kb-requested"
        self.asked += 1
        if self.away:
            self.away -= 1
            return {"code": "peer-unavailable", "message": "Nothing answers browse:kb-requested"}
        if self.domain is None:
            return {"message": "This knowledge base declares no domain"}
        return None

    def _answer(self, operation: str, payload: Mapping[str, JsonValue]) -> JsonValue:
        assert operation == "browse:kb-requested"
        return {"name": "A knowledge base", "domain": self.domain}


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
            self._transport: FaultyTransport | None = None

        async def __aenter__(self) -> FaultyTransport | _Opened:
            self._at.streams.append(("opened", self._channels))
            if self._channels == CONFIRMING_CHANNELS:
                self._transport = self._at.asking()
                return self._transport
            parties = self._at.opened()
            self._transport = parties.transport
            return _Opened(content=parties.content, client=parties.client)

        async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
            assert self._transport is not None
            await self._transport.close()
            self._at.streams.append(("closed", self._channels))

    def client(transport: _Opened, content: object, operations: object) -> SemiontClient[FaultyTransport]:
        return transport.client

    monkeypatch.setattr(agent, "AgentToken", SignedIn)
    monkeypatch.setattr(agent, "HttpTransport", Stream)
    monkeypatch.setattr(agent, "SemiontClient", client)
