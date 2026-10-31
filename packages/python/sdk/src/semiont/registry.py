"""What an application holds beside its knowledge bases: a registry of them.

The list of the ones it has registered, which of them is active, the active
one's session, and what a person has open in each. It builds sessions through
the `SessionFactory` it is given, and so knows nothing of how a knowledge base
is reached; `semiont.http.session.HttpSessionFactory` reaches one over its
gateway. A person's sign-in by a page redirect lands here
(`semiont.http.session.begin_sign_in`, `complete_sign_in`). What it keeps in
its storage, and under which keys, is `semiont.stored`'s.

**One session is live at a time,** the active knowledge base's. Making another
active closes it first: its readers see no session, then the new one.
Activations do not overlap, and one that was overtaken while it waited does
nothing. `session_activating` is true while one is under way, which is what
tells "a session is coming" from "there is none".

**Look up by address, verify by did.** A sign-in lands on the entry, among
those at the address, whose did is the one the knowledge base reported, or on
a new entry. The address, the entry a person re-authenticated and the row
they clicked say what they believed, and are reported back, never acted on.
So an entry's did never changes, and its label and last read are written only
from an answer that carried its did.

**What is open is per knowledge base,** and shown only while that knowledge
base has a live session. When a session comes up, the knowledge base is asked
who it is and each open resource is checked against it:

- a resource the knowledge base says does not exist is closed; one whose
  check failed any other way stays open;
- a different knowledge base answering voids what was open and where the
  person was, and raises the conflict for a host to show. The entry is left
  as it was written;
- no answer is no verdict, and changes nothing.

A request the gateway refuses for want of a valid token renews the session,
and only a session that cannot be renewed is said to have expired. A request
refused for lack of permission is said at once.

Every change to what is open is made against what the storage holds, as one
step, so two contexts that each open a resource both keep theirs, and what
another context writes is shown here. A write the storage refuses raises, and
changes nothing, there or here.

Held with `async with`: inside it, the active knowledge base's session is
brought up, and on the way out the registry is closed, as `close` does.
"""

import asyncio
import time
import uuid
from collections.abc import Callable, Coroutine, Iterable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from dataclasses import dataclass
from datetime import UTC, datetime
from types import TracebackType
from typing import Annotated, Final, Literal, Protocol, Self, final, override

from pydantic import Field, JsonValue, TypeAdapter, ValidationError

from semiont._reading import Reading
from semiont.errors import BusRequestError, SemiontError, SessionError, TransportError
from semiont.event_bus import EventBus
from semiont.events import Broadcast, Events
from semiont.identifiers import ResourceId
from semiont.identity import kb_did
from semiont.model import WireModel, written
from semiont.resources import primary_media_type
from semiont.session import HeldSignIn, SemiontSession, SignInKept, is_token_expired
from semiont.session_signals import KbIdentityConflict, SessionSignals
from semiont.storage import SessionStorage
from semiont.stored import (
    ACTIVE_KEY,
    KNOWLEDGE_BASES_KEY,
    LAST_VIEWED_RESOURCE_BY_KB_KEY,
    OPEN_RESOURCES_BY_KB_KEY,
    StoredSession,
    session_key,
)
from semiont.transport import Transport
from semiont.types import HttpEndpoint, KbDescription, KbEndpoint, KbRead, KnowledgeBase, NewKnowledgeBase
from semiont.watched import Variable, Watched

__all__ = [
    "Expected",
    "KbReadKind",
    "KbReadVerdict",
    "KbSessionStatus",
    "OpenResource",
    "SemiontBrowser",
    "SemiontBrowserConfig",
    "SessionFactory",
    "SessionFactoryOptions",
    "SignInOutcome",
    "SignedIn",
    "TabCheck",
    "TabVerdict",
    "apply_tab_checks",
    "clear_stored_session",
    "kept_in",
    "load_knowledge_bases",
    "save_knowledge_bases",
    "sort_open_resources",
    "store_session",
    "stored_session",
]

_CHECKS_AT_ONCE: Final = 4
"""How many open resources are checked at once when a session comes up: a connection just opened is not handed every check together."""

_LIST: Final = TypeAdapter[list[JsonValue]](list[JsonValue])


# ── What it keeps ───────────────────────────────────────────────────────


def stored_session(storage: SessionStorage, kb_id: str) -> StoredSession | None:
    """The session stored for a knowledge base; nothing when none is, or what is stored lacks a member a session has."""
    stored = storage.get(session_key(kb_id))
    if stored is None:
        return None
    try:
        return StoredSession.model_validate_json(stored)
    except ValidationError:
        return None


def store_session(storage: SessionStorage, kb_id: str, session: StoredSession) -> None:
    """Store a knowledge base's session, in place of what was stored."""
    storage.set(session_key(kb_id), session.model_dump_json(by_alias=True, exclude_none=True))


def clear_stored_session(storage: SessionStorage, kb_id: str) -> None:
    """Forget a knowledge base's session."""
    storage.delete(session_key(kb_id))


def load_knowledge_bases(storage: SessionStorage) -> list[KnowledgeBase]:
    """The registered knowledge bases.

    Each entry is read on its own, and one that is not a knowledge base with a
    did is dropped: whoever it was is registered again. What an entry holds
    beyond a knowledge base's members is not read.
    """
    stored = storage.get(KNOWLEDGE_BASES_KEY)
    if stored is None:
        return []
    try:
        entries = _LIST.validate_json(stored)
    except ValidationError:
        return []
    kbs: list[KnowledgeBase] = []
    for entry in entries:
        try:
            kbs.append(KnowledgeBase.model_validate(entry))
        except ValidationError:
            continue
    return kbs


def save_knowledge_bases(storage: SessionStorage, kbs: Sequence[KnowledgeBase]) -> None:
    """Store the registered knowledge bases, in place of what was stored."""
    storage.set(KNOWLEDGE_BASES_KEY, _LIST.dump_json([written(kb) for kb in kbs]).decode())


@final
class _KeptIn(SignInKept):
    """A knowledge base's sign-in, kept where a registry keeps it."""

    def __init__(self, storage: SessionStorage, kb_id: str) -> None:
        self._storage: Final = storage
        self._kb_id: Final = kb_id

    @override
    async def held(self) -> HeldSignIn | None:
        stored = stored_session(self._storage, self._kb_id)
        return None if stored is None else _held(stored)

    @override
    async def keep(self, sign_in: HeldSignIn) -> None:
        store_session(self._storage, self._kb_id, _stored(sign_in))

    @override
    async def renewed(self, read: HeldSignIn, access: str, refresh: str) -> str | None:
        current: list[str] = []

        def renew(stored: str | None) -> str | None:
            session = None if stored is None else _session_in(stored)
            if session is None:
                return stored
            if (session.access, session.refresh) != (read.access, read.refresh):
                current.append(session.access)
                return stored
            current.append(access)
            return session.model_copy(update={"access": access, "refresh": refresh}).model_dump_json(by_alias=True, exclude_none=True)

        self._storage.update(session_key(self._kb_id), renew)
        return current[0] if current else None

    @override
    async def forget(self) -> None:
        clear_stored_session(self._storage, self._kb_id)


def _session_in(stored: str) -> StoredSession | None:
    try:
        return StoredSession.model_validate_json(stored)
    except ValidationError:
        return None


def _held(stored: StoredSession) -> HeldSignIn:
    return HeldSignIn(
        access=stored.access,
        refresh=stored.refresh,
        client_id=stored.client_id,
        token_endpoint=stored.token_endpoint,
        revocation_endpoint=stored.revocation_endpoint,
    )


def _stored(held: HeldSignIn) -> StoredSession:
    return StoredSession(
        access=held.access,
        refresh=held.refresh,
        client_id=held.client_id,
        token_endpoint=held.token_endpoint,
        revocation_endpoint=held.revocation_endpoint,
    )


def kept_in(storage: SessionStorage, kb_id: str) -> SignInKept:
    """A knowledge base's sign-in as a session keeps it, in a registry's storage, under `session_key(kb_id)`.

    A renewal is written as one step against what is stored then, so one made
    meanwhile by another session or context stands.
    """
    return _KeptIn(storage, kb_id)


type KbSessionStatus = Literal["authenticated", "expired", "signed-out"]
"""What the credential stored for a knowledge base says, read without asking
anyone: a token is stored and has not expired (`authenticated`), a token is
stored and has expired (`expired`), nothing is stored (`signed-out`)."""


# ── What is open ────────────────────────────────────────────────────────


@final
class OpenResource(WireModel, frozen=True):
    """One resource open in a knowledge base (a tab, where there are tabs)."""

    id: ResourceId
    name: str
    opened_at: Annotated[int, Field(alias="openedAt")]
    """When it was opened, in milliseconds since the epoch."""
    order: int
    """Its place among the others."""
    media_type: Annotated[str | None, Field(alias="mediaType")] = None
    storage_uri: Annotated[str | None, Field(alias="storageUri")] = None
    """Where it is in the working tree, such as `file://docs/overview.md`; none when that is not known."""


type TabVerdict = Literal["gone", "ready", "unknown"]
"""What checking one open resource against its knowledge base concluded: the
knowledge base said it does not exist (`gone`), it has it and said what it is
(`ready`), or the check failed some other way (`unknown`)."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class TabCheck:
    """One open resource's verdict.

    `gone` is the only verdict that removes, and it means the knowledge base
    said the resource does not exist, not that the check failed. A transport
    failure, a timeout and a peer that is down are all `unknown`, and an
    unknown resource stays open: closing everything because a service was
    briefly down would be worse than the stale entries this removes.
    """

    verdict: TabVerdict
    name: str | None = None
    """What the knowledge base named a resource it has: a `ready`'s alone."""
    media_type: str | None = None
    """The media type it said of a resource it has; none when it said none."""


def apply_tab_checks(opened: Iterable[OpenResource], checks: Mapping[ResourceId, TabCheck]) -> list[OpenResource]:
    """Apply each verdict to what is open.

    What is gone is dropped, what was found takes its name and media type, and
    everything else is left as it was. One with no verdict is left: it was
    opened while the checks were in flight.
    """
    kept: list[OpenResource] = []
    for tab in opened:
        check = checks.get(tab.id)
        match check:
            case TabCheck(verdict="gone"):
                continue
            case TabCheck(verdict="ready", name=str(name), media_type=media_type):
                kept.append(tab.model_copy(update={"name": name, "media_type": tab.media_type if media_type is None else media_type}))
            case _:
                kept.append(tab)
    return kept


def sort_open_resources(resources: Iterable[OpenResource]) -> list[OpenResource]:
    """`resources` by the place each has, and among those given the same place, by when each was opened."""
    return sorted(resources, key=lambda resource: (resource.order, resource.opened_at))


_OPEN_BY_KB: Final = TypeAdapter[dict[str, list[OpenResource]]](dict[str, list[OpenResource]])
_VIEWED_BY_KB: Final = TypeAdapter[dict[str, ResourceId]](dict[str, ResourceId])


def _open_by_kb_of(stored: str | None) -> dict[str, list[OpenResource]]:
    """What is stored of each knowledge base's open resources; none for what does not read as that."""
    if stored is None:
        return {}
    try:
        return _OPEN_BY_KB.validate_json(stored)
    except ValidationError:
        return {}


def _viewed_by_kb_of(stored: str | None) -> dict[str, ResourceId]:
    """What is stored of where the person was in each knowledge base; none for what does not read as that."""
    if stored is None:
        return {}
    try:
        return _VIEWED_BY_KB.validate_json(stored)
    except ValidationError:
        return {}


# ── What builds a session ───────────────────────────────────────────────


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SessionFactoryOptions:
    """What a session is built from."""

    kb: KnowledgeBase
    """The knowledge base the session is for."""
    storage: SessionStorage
    """Where its tokens are kept: the registry's own storage."""
    signals: SessionSignals
    """Where the session says it is over, for a host to show."""
    on_error: Callable[[SessionError], None]
    """Told each failure that makes the session unusable."""


class SessionFactory(Protocol):
    """What builds the sessions a registry activates, and ends the credentials of one.

    A registry is given one, and so manages sessions over any transport without knowing which.
    """

    def session(self, options: SessionFactoryOptions) -> AbstractAsyncContextManager[SemiontSession[Transport]]:
        """The session of a knowledge base, over a client of its own.

        Held with `async with`: inside, the session has started, and the
        registry waits for it to be ready. On the way out the session is
        ended, then its client. A knowledge base this factory cannot reach is
        refused on the way in with a `SessionError` (`session.construct-failed`).
        """
        ...

    async def revoke(self, stored: StoredSession) -> None:
        """Tell whoever issued a stored session that it has been forgotten, so its refresh token is good for nothing.

        Best effort: the sign-out has happened whether or not the issuer hears of it.
        """
        ...


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SemiontBrowserConfig:
    """What a registry is made of."""

    storage: SessionStorage
    """Where everything the registry keeps is kept."""
    session_factory: SessionFactory
    """What builds a knowledge base's session."""


# ── What a sign-in lands ────────────────────────────────────────────────


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SignedIn:
    """What a completed sign-in learned.

    Where it was, who the knowledge base there says it is, the tokens, and what
    the person believed they were signing in to.
    """

    endpoint: KbEndpoint
    description: KbDescription
    """What the knowledge base said of itself, asked with the new token."""
    session: StoredSession
    kb_id: str | None = None
    """The registered entry the person re-authenticated; none when it was none."""
    expected_did: str | None = None
    """The did of a row the person clicked; none when it was none."""
    expected_name: str | None = None
    """The name of a row the person clicked; none when it was none."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Expected:
    """What a person believed they were signing in to."""

    did: str
    name: str | None
    """None when nothing was named."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SignInOutcome:
    """The entry a sign-in landed on, and what the person believed.

    A host sets the two against each other and says when they differ. The
    sign-in stands either way: the knowledge base that answered is the one
    reached.
    """

    kb: KnowledgeBase
    expected: Expected | None
    """None when the person named nothing."""


type KbReadKind = Literal["recorded", "conflict", "no-verdict"]
"""What a knowledge base said when it was asked to describe itself, read against
the entry it was asked as: it answered as that entry, and its name and branch
are on it now (`recorded`); a different knowledge base answered, whose did and
name are on the verdict and nowhere else (`conflict`); it did not answer, or
could not say who it is, which is evidence of nothing (`no-verdict`)."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class KbReadVerdict:
    """One reading of a knowledge base against its entry."""

    kind: KbReadKind
    observed_did: str | None = None
    """The did of the knowledge base that answered: a `conflict`'s alone."""
    observed_name: str | None = None
    """The name it gave itself: a `conflict`'s alone."""


_NO_VERDICT: Final = KbReadVerdict(kind="no-verdict")


def _same_place(one: KbEndpoint, other: KbEndpoint) -> bool:
    """Whether two endpoints are one place: for a gateway, its host and port; for a loaded knowledge base, its id."""
    if isinstance(one, HttpEndpoint):
        return isinstance(other, HttpEndpoint) and (one.host, one.port) == (other.host, other.port)
    return not isinstance(other, HttpEndpoint) and one.kb_id == other.kb_id


def _read_now(description: KbDescription) -> KbRead:
    """What a knowledge base said of itself now, beyond its name: the time as RFC 3339, in UTC, to the millisecond."""
    at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return KbRead(at=at, git_branch=description.git_branch)


# ── The registry ────────────────────────────────────────────────────────


@final
class _Live:
    """A live session's holder, and what a host is shown of it."""

    def __init__(self, stop: asyncio.Event, holder: asyncio.Task[None], signals: SessionSignals) -> None:
        self._stop: Final = stop
        self._holder: Final = holder
        self.signals: Final = signals

    async def close(self) -> None:
        """End the session, then the client it was built with, then what a host was shown of it."""
        self._stop.set()
        await asyncio.gather(self._holder, return_exceptions=True)
        self.signals.dispose()


@final
class SemiontBrowser:
    """A registry of knowledge bases: see the module's documentation."""

    def __init__(self, config: SemiontBrowserConfig) -> None:
        """A registry over what `config.storage` holds.

        What was read is what is kept: an entry that did not read as a
        knowledge base is gone from the storage too.
        """
        self._storage: Final = config.storage
        self._factory: Final = config.session_factory
        kbs = load_knowledge_bases(self._storage)
        active = self._storage.get(ACTIVE_KEY)
        if not any(kb.id == active for kb in kbs):
            active = kbs[0].id if kbs else None
        self._kbs: Final = Variable[tuple[KnowledgeBase, ...]](())
        self._active_kb_id: Final = Variable[str | None](None)
        self._active_session: Final = Variable[SemiontSession[Transport] | None](None)
        self._active_signals: Final = Variable[SessionSignals | None](None)
        self._session_activating: Final = Variable(False)
        self._open_resources: Final = Variable[tuple[OpenResource, ...]](())
        self._last_viewed: Final = Variable[ResourceId | None](None)
        self._identity_token: Final = Variable[str | None](None)
        self._failures: Final = Broadcast[SessionError]()
        self._bus: Final = EventBus()
        self._open_by_kb = _open_by_kb_of(self._storage.get(OPEN_RESOURCES_BY_KB_KEY))
        self._viewed_by_kb = _viewed_by_kb_of(self._storage.get(LAST_VIEWED_RESOURCE_BY_KB_KEY))
        self._activations = 0
        self._live: _Live | None = None
        # One activation at a time: an activation that waits its turn waits here.
        self._turn: Final = asyncio.Lock()
        self._tasks: Final[set[asyncio.Task[object]]] = set()
        self._failed_tasks: Final[list[BaseException]] = []
        self._stop_listening: Callable[[], None] | None = None
        self._entered = False
        self._closing: Final = asyncio.Event()
        self._put_kbs(tuple(kbs))
        self._put_active_id(active)

    async def __aenter__(self) -> Self:
        if self._entered or self._closing.is_set():
            raise RuntimeError("a registry is held once")
        self._entered = True
        self._stop_listening = self._storage.subscribe(self._written_elsewhere)
        active = self._active_kb_id.value
        if active is not None:
            self._spawn(self._set_active_kb(active))
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.close()

    # ── What it holds ───────────────────────────────────────────────────

    @property
    def kbs(self) -> Watched[tuple[KnowledgeBase, ...]]:
        """The registered knowledge bases."""
        return Reading(self._kbs)

    @property
    def active_kb_id(self) -> Watched[str | None]:
        """The id of the active knowledge base; none for none.

        It names the one meant: its session may still be on its way, or there may be none.
        """
        return Reading(self._active_kb_id)

    @property
    def active_session(self) -> Watched[SemiontSession[Transport] | None]:
        """The active knowledge base's session; none when it has none."""
        return Reading(self._active_session)

    @property
    def active_signals(self) -> Watched[SessionSignals | None]:
        """What a host shows about the active session. There exactly when the session is."""
        return Reading(self._active_signals)

    @property
    def session_activating(self) -> Watched[bool]:
        """Whether a session is being brought up."""
        return Reading(self._session_activating)

    @property
    def open_resources(self) -> Watched[tuple[OpenResource, ...]]:
        """What is open in the active knowledge base, in order. Empty while it has no live session."""
        return Reading(self._open_resources)

    @property
    def last_viewed_resource(self) -> Watched[ResourceId | None]:
        """The resource last viewed in the active knowledge base; none while it has no live session, and never another knowledge base's."""
        return Reading(self._last_viewed)

    def errors(self) -> Events[SessionError]:
        """The failures that made a session unusable, from now on, until the registry is closed."""
        return self._failures.listen()

    @property
    def identity_token(self) -> Watched[str | None]:
        """The token of an identity the host's environment supplies; none for none."""
        return Reading(self._identity_token)

    def set_identity_token(self, token: str | None) -> None:
        """Set the identity token; none for none."""
        self._identity_token.set(token)

    @property
    def storage(self) -> SessionStorage:
        """Where the registry keeps what it keeps: what a sign-in that is under way is remembered in, too."""
        return self._storage

    @property
    def bus(self) -> EventBus:
        """The application's own bus: what its parts say to each other whether or not a knowledge base is active.

        Apart from a client's own bus, which carries what happens in one knowledge base.
        """
        return self._bus

    # ── The knowledge bases ─────────────────────────────────────────────

    async def add_kb(self, kb: NewKnowledgeBase, session: StoredSession) -> KnowledgeBase:
        """Register a knowledge base that a sign-in reached, keep its tokens, and make it the active one.

        Returns once its session is up, or known not to be.
        """
        added = KnowledgeBase(id=str(uuid.uuid4()), label=kb.label, did=kb.did, endpoint=kb.endpoint, last_read=kb.last_read)
        store_session(self._storage, added.id, session)
        self._put_kbs((*self._kbs.value, added))
        await self._set_active_kb(added.id)
        return added

    async def remove_kb(self, kb_id: str) -> None:
        """Forget a knowledge base: its entry, its tokens, what was open in it and where the person was.

        If it was active, the first of the others becomes active.
        """
        clear_stored_session(self._storage, kb_id)
        self._forget_kept_of(kb_id)
        rest = tuple(kb for kb in self._kbs.value if kb.id != kb_id)
        self._put_kbs(rest)
        if self._active_kb_id.value == kb_id:
            await self._set_active_kb(rest[0].id if rest else None)

    def update_kb(self, kb_id: str, *, label: str | None = None, last_read: KbRead | None = None) -> None:
        """Write what a knowledge base last said of itself onto its entry: a label, and a last read, each unless it is none.

        Its endpoint is not changed in place, and its did is never changed.
        """
        self._put_kbs(
            tuple(
                kb
                if kb.id != kb_id
                else KnowledgeBase(
                    id=kb.id,
                    label=kb.label if label is None else label,
                    did=kb.did,
                    endpoint=kb.endpoint,
                    last_read=kb.last_read if last_read is None else last_read,
                )
                for kb in self._kbs.value
            )
        )

    def kb_session_status(self, kb_id: str) -> KbSessionStatus:
        """What the credential stored for a knowledge base says, read without asking anyone."""
        stored = stored_session(self._storage, kb_id)
        if stored is None:
            return "signed-out"
        return "expired" if is_token_expired(stored.access, now=time.time()) else "authenticated"

    async def set_active_kb(self, kb_id: str | None) -> None:
        """Make a knowledge base the active one, or none. Returns once its session is up, or once it is known there will be none."""
        await self._set_active_kb(kb_id)

    async def sign_in(self, kb_id: str, session: StoredSession) -> None:
        """Keep new tokens for a registered knowledge base and bring its session up on them.

        A session it already had is closed and replaced.
        """
        if self._closing.is_set():
            return
        store_session(self._storage, kb_id, session)
        # A session it already has is on the old tokens: it is closed, and the
        # one built next reads the new ones.
        if self._active_kb_id.value == kb_id:
            taken = self._take_session()
            if taken is not None:
                await taken.close()
        await self._set_active_kb(kb_id)

    async def signed_in(self, signed_in: SignedIn) -> SignInOutcome:
        """The registry's half of a sign-in: land it on the entry for the knowledge base that answered (see the module's documentation).

        Raises `ValueError` for a description whose domain no did can hold, and nothing is registered.
        """
        did = kb_did(signed_in.description.domain)
        label = signed_in.description.name
        last_read = _read_now(signed_in.description)
        kbs = self._kbs.value
        at_address = [kb for kb in kbs if _same_place(kb.endpoint, signed_in.endpoint)]
        # An address with several entries singles out no belief of its own.
        believed: KnowledgeBase | None = None
        if signed_in.kb_id is not None:
            believed = next((kb for kb in kbs if kb.id == signed_in.kb_id), None)
        elif len(at_address) == 1:
            believed = at_address[0]
        expected: Expected | None = None
        if signed_in.expected_did is not None:
            expected = Expected(did=signed_in.expected_did, name=signed_in.expected_name)
        elif believed is not None:
            expected = Expected(did=believed.did, name=believed.label)

        answered = next((kb for kb in at_address if kb.did == did), None)
        if answered is not None:
            self.update_kb(answered.id, label=label, last_read=last_read)
            landed = next(kb for kb in self._kbs.value if kb.id == answered.id)
            await self.sign_in(answered.id, signed_in.session)
            return SignInOutcome(kb=landed, expected=expected)
        added = await self.add_kb(
            NewKnowledgeBase(label=label, did=did, endpoint=signed_in.endpoint, last_read=last_read), signed_in.session
        )
        return SignInOutcome(kb=added, expected=expected)

    async def sign_out(self, kb_id: str) -> None:
        """Sign out of a knowledge base: its tokens are forgotten, and the issuer is told so its refresh token is good for nothing.

        If it is active, its session is closed.
        """
        if self._closing.is_set():
            return
        stored = stored_session(self._storage, kb_id)
        clear_stored_session(self._storage, kb_id)
        if stored is not None:
            # The sign-out is the local act: an issuer that cannot be reached
            # does not keep anyone in a session they asked to end.
            self._spawn(self._factory.revoke(stored))
        # Said again, so whoever shows each knowledge base's status reads it anew.
        self._kbs.raise_(self._kbs.value)
        if self._active_kb_id.value == kb_id:
            taken = self._take_session()
            if taken is not None:
                await taken.close()

    # ── What is open ────────────────────────────────────────────────────

    def add_open_resource(
        self, resource_id: ResourceId, name: str, *, media_type: str | None = None, storage_uri: str | None = None
    ) -> None:
        """Open a resource in the active knowledge base.

        One open already takes its name, and its media type and storage URI
        unless each is none.

        Nothing is opened while it has no live session.
        """

        def opened(tabs: list[OpenResource]) -> list[OpenResource]:
            for place, tab in enumerate(tabs):
                if tab.id == resource_id:
                    tabs[place] = tab.model_copy(
                        update={
                            "name": name,
                            "media_type": tab.media_type if media_type is None else media_type,
                            "storage_uri": tab.storage_uri if storage_uri is None else storage_uri,
                        }
                    )
                    return tabs
            # After the last place taken, not the count: a place freed by a removal is not handed out twice.
            order = max((tab.order + 1 for tab in tabs), default=0)
            opened_at = int(time.time() * 1000)
            tab = OpenResource(id=resource_id, name=name, opened_at=opened_at, order=order, media_type=media_type, storage_uri=storage_uri)
            return [*tabs, tab]

        self._mutate_open_resources(opened)

    def remove_open_resource(self, resource_id: ResourceId) -> None:
        """Close a resource in the active knowledge base."""
        self._mutate_open_resources(lambda tabs: [tab for tab in tabs if tab.id != resource_id])

    def update_open_resource_name(self, resource_id: ResourceId, name: str) -> None:
        """Give an open resource of the active knowledge base a name."""
        self._mutate_open_resources(lambda tabs: [tab.model_copy(update={"name": name}) if tab.id == resource_id else tab for tab in tabs])

    def reorder_open_resources(self, from_: int, to: int) -> None:
        """Move the open resource at one place in the visible list to another. A place that is not in the list moves nothing."""

        def reordered(tabs: list[OpenResource]) -> list[OpenResource]:
            if not (0 <= from_ < len(tabs) and 0 <= to < len(tabs)):
                return tabs
            ordered = sort_open_resources(tabs)
            ordered.insert(to, ordered.pop(from_))
            return [tab.model_copy(update={"order": place}) for place, tab in enumerate(ordered)]

        self._mutate_open_resources(reordered)

    def set_last_viewed_resource(self, resource_id: ResourceId) -> None:
        """Record the resource a person is looking at, in the active knowledge base. Nothing is recorded while it has no live session."""
        kb_id = self._live_kb_id()
        if kb_id is None:
            return

        def viewed(by_kb: dict[str, ResourceId]) -> None:
            by_kb[kb_id] = resource_id

        self._mutate_viewed(viewed)

    async def read_active_kb(self) -> KbReadVerdict:
        """Ask the active knowledge base to describe itself again, and say what it answered.

        Asking is not activating: an answer as the entry is recorded on it, and
        a different knowledge base answering is reported. Nothing is voided and
        nothing raised.
        """
        session, kb_id = self._active_session.value, self._active_kb_id.value
        if session is None or kb_id is None:
            return _NO_VERDICT
        return await self._read_kb(session, kb_id)

    async def close(self) -> None:
        """End the registry: its session is closed, and everything it holds ends.

        Returns once what it was running has stopped, and raises what any of it
        failed with. Called from within what it runs, it ends that work too
        but does not wait for it, which would be waiting for itself, and raises
        what has failed so far. Closing twice is closing once.
        """
        if self._closing.is_set():
            return
        self._closing.set()
        taken = self._take_session()
        if self._stop_listening is not None:
            self._stop_listening()
        if taken is not None:
            await taken.close()
        within = next((task for task in self._tasks if task is asyncio.current_task()), None)
        running = [task for task in self._tasks if task is not within]
        for task in running:
            task.cancel()
        await asyncio.gather(*running, return_exceptions=True)
        if within is not None:
            # Ended once closing has nothing left to wait for: at its next wait, after this returns.
            within.cancel()
        self._failures.close()
        for held in (
            self._kbs,
            self._active_kb_id,
            self._active_session,
            self._active_signals,
            self._session_activating,
            self._open_resources,
            self._last_viewed,
            self._identity_token,
        ):
            held.end()
        self._bus.destroy()
        if self._failed_tasks:
            raise self._failed_tasks[0]

    # ── Within ──────────────────────────────────────────────────────────

    def _spawn(self, work: Coroutine[None, None, object]) -> None:
        """Run `work` for as long as the registry lives: closing ends it, and raises what it failed with."""
        task = asyncio.create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._done)

    def _done(self, task: asyncio.Task[object]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and (failure := task.exception()) is not None:
            self._failed_tasks.append(failure)

    def _put_kbs(self, kbs: tuple[KnowledgeBase, ...]) -> None:
        if self._closing.is_set():
            return
        save_knowledge_bases(self._storage, kbs)
        self._kbs.raise_(kbs)

    def _put_active_id(self, kb_id: str | None) -> None:
        if self._closing.is_set():
            return
        if kb_id is None:
            self._storage.delete(ACTIVE_KEY)
        else:
            self._storage.set(ACTIVE_KEY, kb_id)
        self._active_kb_id.set(kb_id)

    def _failed(self, error: SessionError) -> None:
        self._failures.deliver(error)

    # ── The active session ──────────────────────────────────────────────

    def _take_session(self) -> _Live | None:
        """Take the live session out: its readers see none, and what is open is shown no more. Whoever takes it closes it."""
        taken = self._live
        if taken is None:
            return None
        self._live = None
        self._active_session.set(None)
        self._active_signals.set(None)
        self._project()
        return taken

    def _put_session(self, session: SemiontSession[Transport], live: _Live) -> None:
        """Put a session that is up as the live one.

        The signals first: putting the session is what starts the checks of
        it, and a conflict they find is said through the signals. A session is
        put once, so what is open is checked once per session.
        """
        self._live = live
        self._active_signals.set(live.signals)
        self._active_session.set(session)
        self._project()
        self._spawn(self._validate_open_resources(session))

    async def _set_active_kb(self, kb_id: str | None) -> None:
        if self._closing.is_set():
            return
        previous = self._active_kb_id.value
        if kb_id == previous and self._active_session.value is not None:
            return
        # Said at once: what is meant now is `kb_id`, and no session is live.
        # An activation that waited reads this to learn it was overtaken.
        if previous != kb_id:
            self._put_active_id(kb_id)
        taken = self._take_session()
        self._activating(1)
        try:
            async with self._turn:
                if taken is not None:
                    await taken.close()
                if not self._closing.is_set() and self._active_kb_id.value == kb_id:
                    # One left live by whoever had the turn before.
                    left = self._take_session()
                    if left is not None:
                        await left.close()
                    if kb_id is not None:
                        await self._activate(kb_id)
        finally:
            self._activating(-1)

    def _activating(self, change: int) -> None:
        self._activations += change
        self._session_activating.set(self._activations > 0)

    async def _activate(self, kb_id: str) -> None:
        kb = next((kb for kb in self._kbs.value if kb.id == kb_id), None)
        if kb is None:
            return
        # The signals exist before the session does: the session says it is
        # over through them, and may be over before it is ready.
        signals = SessionSignals()
        came_up: asyncio.Future[SemiontSession[Transport] | None] = asyncio.get_running_loop().create_future()
        stop = asyncio.Event()
        holder = asyncio.create_task(self._hold(kb, signals, came_up, stop))
        self._tasks.add(holder)
        holder.add_done_callback(self._done)
        live = _Live(stop, holder, signals)
        session = await came_up
        if session is not None:
            await session.ready()
        if session is None or self._closing.is_set() or self._active_kb_id.value != kb_id:
            await live.close()
            return
        self._put_session(session, live)

    async def _hold(
        self,
        kb: KnowledgeBase,
        signals: SessionSignals,
        came_up: asyncio.Future[SemiontSession[Transport] | None],
        stop: asyncio.Event,
    ) -> None:
        """Hold one session, from its factory's building it until it is to stop."""
        options = SessionFactoryOptions(kb=kb, storage=self._storage, signals=signals, on_error=self._failed)
        try:
            async with AsyncExitStack() as holding:
                try:
                    session = await holding.enter_async_context(self._factory.session(options))
                except SemiontError as refused:
                    if not self._closing.is_set():
                        self._failed(_construct_failed(refused, kb.id))
                    return
                # Heard from the moment it is held: a refusal while it starts is routed too.
                failures = session.errors()
                routing = asyncio.create_task(self._route(session, failures, signals))
                came_up.set_result(session)
                try:
                    await stop.wait()
                finally:
                    routing.cancel()
                    await asyncio.gather(routing, return_exceptions=True)
        finally:
            if not came_up.done():
                came_up.set_result(None)

    async def _route(self, session: SemiontSession[Transport], failures: Events[SemiontError], signals: SessionSignals) -> None:
        """Route what the session's transport fails at.

        A refusal for want of a valid token renews the session: it heals
        quietly, or the session ends itself and says so once. A refusal for
        lack of permission has no remedy, and is said.
        """
        async with failures:
            async for failure in failures:
                if not isinstance(failure, TransportError):
                    continue
                match failure.code:
                    case "unauthorized":
                        # Refusals that arrive together are answered by one renewal: the session holds them while it renews.
                        self._spawn(session.refresh())
                    case "forbidden":
                        signals.notify_permission_denied(failure.message)
                    case _:
                        pass

    # ── What is shown ───────────────────────────────────────────────────

    def _live_kb_id(self) -> str | None:
        """The id of the active knowledge base when it has a live session; none otherwise."""
        return None if self._active_session.value is None else self._active_kb_id.value

    def _project(self) -> None:
        """Show what is open, and where the person was, in the active knowledge base: only while it has a live session."""
        kb_id = self._live_kb_id()
        if kb_id is None:
            self._open_resources.set(())
            self._last_viewed.set(None)
            return
        self._open_resources.set(tuple(sort_open_resources(self._open_by_kb.get(kb_id, []))))
        self._last_viewed.set(self._viewed_by_kb.get(kb_id))

    def _mutate_open_resources(self, mutate: Callable[[list[OpenResource]], list[OpenResource]]) -> None:
        """Change what is open in the active knowledge base, against what the storage holds, as one step."""
        kb_id = self._live_kb_id()
        if kb_id is None:
            return
        committed: list[dict[str, list[OpenResource]]] = []

        def change(stored: str | None) -> str:
            by_kb = _open_by_kb_of(stored)
            by_kb[kb_id] = mutate(list(by_kb.get(kb_id, [])))
            committed.append(by_kb)
            return _OPEN_BY_KB.dump_json(by_kb, by_alias=True, exclude_none=True).decode()

        self._storage.update(OPEN_RESOURCES_BY_KB_KEY, change)
        self._open_by_kb = committed[0]
        self._project()

    def _mutate_viewed(self, mutate: Callable[[dict[str, ResourceId]], None]) -> None:
        committed: list[dict[str, ResourceId]] = []

        def change(stored: str | None) -> str:
            by_kb = _viewed_by_kb_of(stored)
            mutate(by_kb)
            committed.append(by_kb)
            return _VIEWED_BY_KB.dump_json(by_kb).decode()

        self._storage.update(LAST_VIEWED_RESOURCE_BY_KB_KEY, change)
        self._viewed_by_kb = committed[0]
        self._project()

    def _forget_kept_of(self, kb_id: str) -> None:
        """Forget what was open in a knowledge base, and where the person was."""
        committed: list[dict[str, list[OpenResource]]] = []

        def change(stored: str | None) -> str:
            by_kb = _open_by_kb_of(stored)
            by_kb.pop(kb_id, None)
            committed.append(by_kb)
            return _OPEN_BY_KB.dump_json(by_kb, by_alias=True, exclude_none=True).decode()

        self._storage.update(OPEN_RESOURCES_BY_KB_KEY, change)
        self._open_by_kb = committed[0]

        def forgotten(by_kb: dict[str, ResourceId]) -> None:
            by_kb.pop(kb_id, None)

        self._mutate_viewed(forgotten)

    def _written_elsewhere(self, key: str, value: str | None) -> None:
        """Another context changed what is open, or where the person was."""
        if self._closing.is_set() or value is None:
            return
        try:
            if key == OPEN_RESOURCES_BY_KB_KEY:
                self._open_by_kb = _OPEN_BY_KB.validate_json(value)
            elif key == LAST_VIEWED_RESOURCE_BY_KB_KEY:
                self._viewed_by_kb = _VIEWED_BY_KB.validate_json(value)
            else:
                return
        except ValidationError:
            return
        self._project()

    # ── The checks a session's arrival starts ───────────────────────────

    def _is_live(self, session: SemiontSession[Transport]) -> bool:
        live = self._active_session.value
        return not self._closing.is_set() and live is not None and live.id == session.id

    async def _validate_open_resources(self, session: SemiontSession[Transport]) -> None:
        # The session's own knowledge base: by the time this runs, another may be the active one.
        kb_id = session.kb.id
        # Who it is, first: if a different knowledge base is answering, every
        # answer about a resource would be an answer to a question asked of
        # the wrong one.
        verdict = await self._read_kb(session, kb_id)
        if verdict.kind == "conflict":
            # The read was of this session's knowledge base: what it voids is
            # the active one's, so only while this is still the active one.
            if self._is_live(session) and verdict.observed_did is not None:
                self._void_for_conflict(kb_id, verdict.observed_did)
            return
        # What the storage holds, not what is in memory: another context may
        # have opened a resource before this session came up.
        waiting = [tab.id for tab in _open_by_kb_of(self._storage.get(OPEN_RESOURCES_BY_KB_KEY)).get(kb_id, [])]
        if not waiting:
            return
        lanes = asyncio.Semaphore(_CHECKS_AT_ONCE)

        async def checked(resource_id: ResourceId) -> tuple[ResourceId, TabCheck]:
            async with lanes:
                return resource_id, await _check_open_resource(session, resource_id)

        checks = dict(await asyncio.gather(*(checked(resource_id) for resource_id in waiting)))
        if self._is_live(session):
            self._mutate_open_resources(lambda tabs: apply_tab_checks(tabs, checks))

    async def _read_kb(self, session: SemiontSession[Transport], kb_id: str) -> KbReadVerdict:
        """Ask the knowledge base to describe itself, against the entry it is asked as.

        If it is the one the entry says, its name and branch are recorded on
        the entry; otherwise nothing is recorded. A did is read one way only.
        It is not unique, so one that differs says a different knowledge base
        answered, and one that matches says nothing about what is in it: that
        is each resource's own check.
        """
        entry = next((kb for kb in self._kbs.value if kb.id == kb_id), None)
        if entry is None:
            return _NO_VERDICT
        try:
            description = await session.client.browse.kb()
            observed = kb_did(description.domain)
        except (SemiontError, ValueError):
            # Not answered, or a domain no did can hold: a knowledge base that could not say who it is.
            return _NO_VERDICT
        if observed != entry.did:
            return KbReadVerdict(kind="conflict", observed_did=observed, observed_name=description.name)
        if self._closing.is_set():
            return _NO_VERDICT
        self.update_kb(kb_id, label=description.name, last_read=_read_now(description))
        return KbReadVerdict(kind="recorded")

    def _void_for_conflict(self, kb_id: str, observed_did: str) -> None:
        """A different knowledge base answered for the active entry.

        What claims to be about the entry's contents is voided, both at once,
        and the conflict is raised.

        Registering the knowledge base that answered is a person's act.
        """
        entry = next((kb for kb in self._kbs.value if kb.id == kb_id), None)
        if entry is None:
            return
        self._mutate_open_resources(lambda tabs: [])

        def forgotten(by_kb: dict[str, ResourceId]) -> None:
            by_kb.pop(kb_id, None)

        self._mutate_viewed(forgotten)
        signals = self._active_signals.value
        if signals is not None:
            signals.notify_kb_identity_conflict(KbIdentityConflict(expected_did=entry.did, observed_did=observed_did))


def _construct_failed(refused: SemiontError, kb_id: str) -> SessionError:
    """A factory's refusal as the failure a registry says: the factory's own when it is a session's."""
    if isinstance(refused, SessionError):
        return refused
    return SessionError("session.construct-failed", refused.message, kb_id=kb_id)


async def _check_open_resource(session: SemiontSession[Transport], resource_id: ResourceId) -> TabCheck:
    """One open resource's verdict. Asking for it freshly also puts what it answered in the client's cache, where a viewer reads it."""
    try:
        descriptor = await session.client.browse.resource(resource_id).fresh()
    except BusRequestError as refusal:
        return TabCheck(verdict="gone" if refusal.code == "bus.not-found" else "unknown")
    except SemiontError:
        # Anything else is a symptom, not a verdict.
        return TabCheck(verdict="unknown")
    return TabCheck(verdict="ready", name=descriptor.name, media_type=primary_media_type(descriptor))
