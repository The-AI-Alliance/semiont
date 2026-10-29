"""A `SessionFactory` for tests of a registry (`semiont.registry.SemiontBrowser`) and of what is built on one.

Each session it builds is a real `SemiontSession` over a `FaultyTransport` of
its own, and the factory keeps every transport it built, by knowledge base.

A test scripts three things: what each knowledge base's gateway answers, who
the gateway says a token is, and what a renewal gives. Each refuses by name
until it is scripted: an unscripted request names its operation and its
knowledge base, an unscripted renewal is a renewal that failed, and a gateway
nobody scripted a user for cannot say who a token is.
"""

import asyncio
from collections import deque
from collections.abc import AsyncGenerator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Final, final, override

from pydantic import JsonValue

from semiont.errors import SessionError, SignInError, TransportError
from semiont.registry import SessionFactory, SessionFactoryOptions, kept_in
from semiont.session import SemiontSession
from semiont.stored import StoredSession
from semiont.testing.client import create_test_client
from semiont.testing.transport import FaultyTransport
from semiont.types import KbTarget, UserResponse
from semiont.watched import Variable

__all__ = ["ScriptedSessions"]


def _refuse_unscripted(kb_id: str, operation: str, payload: Mapping[str, JsonValue]) -> JsonValue | None:
    """What answers a request of a knowledge base nothing was scripted for: a refusal naming both, never a response made up."""
    raise TransportError("error", f"No response scripted for {operation!r} of knowledge base {kb_id!r}. Build the factory with an answer.")


@final
class ScriptedSessions(SessionFactory):
    """Sessions of knowledge bases whose gateways answer as `answer` says: see the module's documentation.

    `answer` is given the knowledge base's id, the operation and the payload,
    and gives the response, or nothing for a reply that carries none, or
    raises the refusal. With none, every request is refused, naming its
    operation and its knowledge base.
    """

    def __init__(self, *, answer: Callable[[str, str, Mapping[str, JsonValue]], JsonValue | None] = _refuse_unscripted) -> None:
        self._answer: Final = answer
        self._refuse: Callable[[str, str, Mapping[str, JsonValue]], Mapping[str, JsonValue] | None] | None = None
        self._refuses_to_build: str | None = None
        self._user: UserResponse | None = None
        self._answers_after = 0.0
        self._renewals: Final[deque[str | SignInError | None]] = deque()
        self._renewed = 0
        self._built: Final[list[tuple[str, FaultyTransport]]] = []
        self._revoked: Final[list[StoredSession]] = []

    def refuse_when(self, refuse: Callable[[str, str, Mapping[str, JsonValue]], Mapping[str, JsonValue] | None]) -> None:
        """Have a gateway answer with a failure every request `refuse` gives one for, before it is asked for an answer.

        Sessions already built refuse so too.

        `refuse` is given the knowledge base's id, the operation and the
        payload, and gives the payload of the operation's failure channel, or
        nothing to answer as usual.
        """
        self._refuse = refuse

    def refuse_to_build(self, why: str | None) -> None:
        """Refuse to build any session, saying why; none builds again."""
        self._refuses_to_build = why

    def says_who(self, user: UserResponse) -> None:
        """Who the gateway says a token is, of every session built from now."""
        self._user = user

    def answers_after(self, wait: float) -> None:
        """How long, in seconds, the gateway takes to say who a token is, of every session built from now."""
        self._answers_after = wait

    def queue_renewals(self, *renewals: str | SignInError | None) -> None:
        """What the next renewals give, one each, in order.

        A token, nothing for a session that has nothing to renew with, or the failure it raises.
        """
        self._renewals.extend(renewals)

    @property
    def renewed(self) -> int:
        """How many renewals were asked for."""
        return self._renewed

    def transports(self, kb_id: str) -> Sequence[FaultyTransport]:
        """The transports of the sessions built for a knowledge base, in the order they were built."""
        return [transport for built, transport in self._built if built == kb_id]

    @property
    def revoked(self) -> Sequence[StoredSession]:
        """Every stored session the factory was told to revoke, in order."""
        return list(self._revoked)

    @override
    @asynccontextmanager
    async def session(self, options: SessionFactoryOptions) -> AsyncGenerator[SemiontSession[FaultyTransport]]:
        kb_id = options.kb.id
        if self._refuses_to_build is not None:
            raise SessionError("session.construct-failed", self._refuses_to_build, kb_id=kb_id)

        def answer(operation: str, payload: Mapping[str, JsonValue]) -> JsonValue | None:
            return self._answer(kb_id, operation, payload)

        def refuse(operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
            return None if self._refuse is None else self._refuse(kb_id, operation, payload)

        transport = FaultyTransport(make_response=answer)
        transport.refuse_when(refuse)
        client = create_test_client(transport=transport).client
        self._built.append((kb_id, transport))
        user, wait = self._user, self._answers_after

        async def renew() -> str | None:
            self._renewed += 1
            if not self._renewals:
                raise SignInError("exchange", f"ScriptedSessions: not scripted: a renewal of {kb_id!r}. Script one with queue_renewals.")
            renewal = self._renewals.popleft()
            if isinstance(renewal, SignInError):
                raise renewal
            return renewal

        async def validate(token: str) -> UserResponse:
            await asyncio.sleep(wait)
            if user is None:
                raise TransportError("error", f"ScriptedSessions: not scripted: who a token of {kb_id!r} is. Script it with says_who.")
            return user

        session = SemiontSession(
            kb=KbTarget(id=kb_id, label=options.kb.label, endpoint=options.kb.endpoint),
            client=client,
            token=Variable[str | None](None),
            kept=kept_in(options.storage, kb_id),
            refresh=renew,
            validate=validate,
            on_auth_failed=options.signals.notify_session_ended,
            on_error=options.on_error,
        )
        try:
            async with client, session:
                yield session
        finally:
            await transport.close()

    @override
    async def revoke(self, stored: StoredSession) -> None:
        self._revoked.append(stored)
