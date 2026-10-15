"""What a host shows about a session, apart from the session.

That it ended, that a request was refused for lack of permission, that a
different knowledge base is answering at a registered address.

A session is headless and raises none of these itself. A host that shows them
builds one of these beside each live session and wires the session's failures
into it. Each signal is one value: none while nothing is raised, the notice
while something is. Raising it again is a new occurrence, told to every reader
even when the notice equals the last.

A signal says and decides nothing. By the time a session is said to have ended
it has already cleared its token and what it stored.

A notice says what happened, never a sentence: what a person reads is the
host's to write, in their language.
"""

from types import TracebackType
from typing import Annotated, Final, Self, final, override

from pydantic import Field

from semiont._reading import Reading
from semiont.model import WireModel
from semiont.session import SessionEndReason
from semiont.state_unit import StateUnit
from semiont.watched import Variable, Watched

__all__ = ["KbIdentityConflict", "PermissionDenied", "SessionEnded", "SessionSignals"]


@final
class SessionEnded(WireModel, frozen=True):
    """A session ended, and why."""

    reason: SessionEndReason


@final
class PermissionDenied(WireModel, frozen=True):
    """A request was refused for lack of permission. `detail` is the refusal's own message, untranslated; none when there is none."""

    detail: str | None


@final
class KbIdentityConflict(WireModel, frozen=True):
    """What a registered entry said it was, and what answered.

    Both, because neither alone can be acted on: a person has to recognise
    which knowledge base they registered and which one is there now.
    """

    expected_did: Annotated[str, Field(alias="expectedDid")]
    observed_did: Annotated[str, Field(alias="observedDid")]


@final
class SessionSignals(StateUnit):
    """See the module's documentation."""

    def __init__(self) -> None:
        self._session_ended: Final = Variable[SessionEnded | None](None)
        self._permission_denied: Final = Variable[PermissionDenied | None](None)
        self._kb_identity_conflict: Final = Variable[KbIdentityConflict | None](None)

    @property
    def session_ended(self) -> Watched[SessionEnded | None]:
        """The session ended: it expired, or its credential was refused."""
        return Reading(self._session_ended)

    @property
    def permission_denied(self) -> Watched[PermissionDenied | None]:
        """A request was refused for lack of permission."""
        return Reading(self._permission_denied)

    @property
    def kb_identity_conflict(self) -> Watched[KbIdentityConflict | None]:
        """A different knowledge base is answering at the entry's address."""
        return Reading(self._kb_identity_conflict)

    def notify_session_ended(self, reason: SessionEndReason) -> None:
        self._session_ended.raise_(SessionEnded(reason=reason))

    def notify_permission_denied(self, detail: str | None) -> None:
        self._permission_denied.raise_(PermissionDenied(detail=detail))

    def notify_kb_identity_conflict(self, conflict: KbIdentityConflict) -> None:
        self._kb_identity_conflict.raise_(conflict)

    def acknowledge_session_ended(self) -> None:
        self._session_ended.raise_(None)

    def acknowledge_permission_denied(self) -> None:
        self._permission_denied.raise_(None)

    def acknowledge_kb_identity_conflict(self) -> None:
        self._kb_identity_conflict.raise_(None)

    @override
    def dispose(self) -> None:
        self._session_ended.end()
        self._permission_denied.end()
        self._kb_identity_conflict.end()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.dispose()
