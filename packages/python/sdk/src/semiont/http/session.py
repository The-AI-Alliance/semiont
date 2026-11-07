"""A person's session with a knowledge base over its gateway.

`session_from_kept` builds one over a sign-in that is kept somewhere: the one
`semiont login` made, when it is kept in a `semiont.sign_in_store.SignInStore`,
or one this application kept earlier. `sign_in_device` makes a sign-in to
keep, from a process with no browser. `sign_out` ends one. Each that reaches
a knowledge base is given its `KbTarget`, and reaches the gateway its HTTP
endpoint names; a target reached any other way is refused.

A session built here renews its token at the issuer its kept sign-in names.
Renewals that are asked for together are one request: a stream refused and a
request refused at the same moment spend one refresh token, not two, of which
an issuer that rotates them would refuse the second. And a renewal, once it
is under way, runs to its end whoever stops waiting for it: a refresh token
that has been spent is not left without the one it bought.

A person's token is one credential source. An agent's is another
(`semiont.http.agent`), which feeds a transport the same way.

**For a registry of knowledge bases** (`semiont.registry`), `HttpSessionFactory`
builds the session of each one it activates, and a person's sign-in by a page
redirect is `begin_sign_in` and `complete_sign_in`: it lands on the entry for
the knowledge base that answered, once `describe_connection` has asked it who
it is.
"""

import asyncio
from collections.abc import AsyncGenerator, Callable, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import Final, final, override

import httpx

from semiont.bus import reply_channels_for
from semiont.channels import BRIDGED_CHANNELS
from semiont.client import CachePersistence, SemiontClient
from semiont.errors import BusRequestError, IdentityUnverifiableError, SemiontError, SessionError, SignInError
from semiont.http.endpoint import gateway_url
from semiont.http.oauth import (
    BeginAuthorizationOptions,
    DeviceCode,
    begin_authorization,
    complete_authorization,
    issuer_client,
    renew_kept,
    revoke_at_issuer,
    sign_in_with_device_grant,
)
from semiont.http.transport import HttpTransport
from semiont.identifiers import UserId
from semiont.identity import kb_did
from semiont.oauth_clients import BROWSER_CLIENT_ID, SCRIPT_CLIENT_ID
from semiont.operations import BROWSE_KB_REQUESTED
from semiont.registry import SemiontBrowser, SessionFactory, SessionFactoryOptions, SignedIn, SignInOutcome, kept_in
from semiont.resume import CoupledBookmarks
from semiont.session import HeldSignIn, SemiontSession, SessionEndReason, SignInKept, Validate
from semiont.storage import SessionStorage
from semiont.stored import StoredSession, last_event_id_key, person_key
from semiont.types import HttpEndpoint, KbDescription, KbTarget, LocalEndpoint, UserResponse
from semiont.watched import Variable

__all__ = [
    "ConnectionIdentity",
    "HttpSessionFactory",
    "begin_sign_in",
    "complete_sign_in",
    "describe_connection",
    "session_from_kept",
    "sign_in_device",
    "sign_out",
]


def _heard(renewal: asyncio.Task[str | None]) -> None:
    """Take a renewal's failure as heard: each of its waiters was told, and there may be none."""
    if not renewal.cancelled():
        renewal.exception()


@final
class _Renewing:
    """A kept sign-in's renewals at its issuer, one at a time: a renewal asked for while one is under way is that one."""

    def __init__(self, kept: SignInKept, token: Variable[str | None], http: httpx.AsyncClient | None) -> None:
        self._kept: Final = kept
        self._token: Final = token
        self._http: Final = http
        self._under_way: asyncio.Task[str | None] | None = None

    async def __call__(self) -> str | None:
        if self._under_way is None:
            self._under_way = asyncio.create_task(self._once())
            # A renewal everyone stopped waiting for has nobody to tell how it ended.
            self._under_way.add_done_callback(_heard)
        # Whoever stops waiting does not stop the renewal.
        return await asyncio.shield(self._under_way)

    async def _once(self) -> str | None:
        try:
            return await renew_kept(self._kept, self._token.value, http=self._http)
        finally:
            self._under_way = None

    async def close(self) -> None:
        """End the renewal under way, when there is one: nobody is left to give its token to."""
        under_way = self._under_way
        if under_way is not None:
            under_way.cancel()
            await asyncio.gather(under_way, return_exceptions=True)


def _asking(base_url: str, http: httpx.AsyncClient | None) -> Validate:
    """Ask the gateway who a token is: one request, by a caller that holds nothing else.

    No stream is opened for it, and nothing renews the token: a refusal is
    the answer.
    """

    async def ask(token: str) -> UserResponse:
        asking = HttpTransport(base_url, token=Variable[str | None](token), channels=(), http=http)
        try:
            return await asking.get_current_user()
        finally:
            await asking.close()

    return ask


@final
class _WhileNamed(SessionStorage):
    """The storage a session's client keeps in, written only while the session's sign-in names the person it keeps for.

    Each write is owed until it is made. What is owed is made after whatever
    holds the sign-in says what it holds (`SignInKept.held`), and only if
    that still names the person: once it does not, because the saved sign-in
    was forgotten, which deletes what was kept for the person where its holder
    can reach, or replaced by a sign-in that names nobody or someone else,
    what is owed is dropped and nothing is written again. A renewal names the
    same person, and changes nothing. A sign-in that cannot be read counts as
    one that no longer names the person, and `unreadable` is told of it once,
    as it happens. A write the storage refuses loses that save, and writing
    goes on: the first refused is raised by `close`. What is owed reads as
    written.
    """

    def __init__(self, storage: SessionStorage, kept: SignInKept, person: str, unreadable: Callable[[Exception], None]) -> None:
        self._storage: Final = storage
        self._kept: Final = kept
        self._person: Final = person
        self._unreadable: Final = unreadable
        self._owed: list[tuple[str, str | None]] = []
        """Each write not yet made, in order: a key, and its value, or nothing for its removal."""
        self._refused: Exception | None = None
        """The first write the storage refused, which `close` raises."""
        self._owing: Final = asyncio.Event()
        self._closing = False
        self._dropped = False
        self._writer: Final = asyncio.get_running_loop().create_task(self._write())

    @override
    def get(self, key: str) -> str | None:
        owed = [value for owed_key, value in self._owed if owed_key == key]
        return owed[-1] if owed else self._storage.get(key)

    @override
    def set(self, key: str, value: str) -> None:
        self._owe(key, value)

    @override
    def delete(self, key: str) -> None:
        self._owe(key, None)

    @override
    def update(self, key: str, change: Callable[[str | None], str | None]) -> None:
        self._owe(key, change(self.get(key)))

    @override
    def subscribe(self, on_change: Callable[[str, str | None], None]) -> Callable[[], None] | None:
        return self._storage.subscribe(on_change)

    def _owe(self, key: str, value: str | None) -> None:
        if not self._dropped:
            self._owed.append((key, value))
            self._owing.set()

    async def _write(self) -> None:
        """Make what is owed whenever something is, until closing, or until the sign-in no longer names the person or cannot be read.

        However it ends, what is owed is dropped and nothing is written again.
        """
        try:
            while True:
                await self._owing.wait()
                self._owing.clear()
                if self._owed:
                    try:
                        held = await self._kept.held()
                    except Exception as unread:
                        self._unreadable(unread)
                        return
                    # Nothing is awaited from here to the last write: where `held` answers without waiting,
                    # as this SDK's holders do, no forgetting falls between its answer and the writes.
                    owed, self._owed = self._owed, []
                    if held is None or held.person_key != self._person:
                        return
                    self._make(owed)
                if self._closing:
                    return
        finally:
            self._dropped = True
            self._owed.clear()

    def _make(self, owed: list[tuple[str, str | None]]) -> None:
        """Make each write in turn, up to one the storage refuses.

        A refusal ends the turn, so a place never lands without the cache
        document it rides with. What it lost is written by the next save,
        which writes its document whole; a place it lost is only late.
        """
        for key, value in owed:
            try:
                if value is None:
                    self._storage.delete(key)
                else:
                    self._storage.set(key, value)
            except Exception as refused:
                if self._refused is None:
                    self._refused = refused
                return

    async def close(self) -> None:
        """Make what is owed, as every write is made, and then nothing more.

        Raises the first write the storage refused, when one was.
        """
        self._closing = True
        self._owing.set()
        await self._writer
        if self._refused is not None:
            raise self._refused


@final
class _Keeping:
    """What a session's client keeps in `storage` for the person its token is, from when it knows who they are.

    It is written only while the sign-in `kept` holds names them (`_WhileNamed`).
    """

    def __init__(
        self,
        kb_id: str,
        storage: SessionStorage,
        kept: SignInKept,
        transport: HttpTransport,
        client: SemiontClient[HttpTransport],
        on_error: Callable[[SessionError], None] | None,
    ) -> None:
        self._kb_id: Final = kb_id
        self._storage: Final = storage
        self._kept: Final = kept
        self._transport: Final = transport
        self._client: Final = client
        self._on_error: Final = on_error
        self._person: str | None = None
        self._beneath: _WhileNamed | None = None

    def attach(self, person: str) -> None:
        """Keep what the client holds for `person` from now on: their caches begin with what was kept, and the stream with its places."""
        self._person = person
        beneath = self._beneath = _WhileNamed(self._storage, self._kept, person, self._unreadable)
        # The stream's place rides the caches' writes, and only when every cache is
        # at rest: a place kept ahead of a cache still taking in the event it names
        # would have the next session skip that event.
        places = CoupledBookmarks(beneath, last_event_id_key(self._kb_id, person))
        places.set_flush_gate(lambda: self._client.persistence_settled)
        self._client.attach_persistence(CachePersistence(storage=places.storage, kb_id=self._kb_id, person_key=person))
        self._transport.attach_bookmarks(places)

    def recording(self, ask: Validate) -> Validate:
        """`ask`, after which the person the gateway names is recorded on the sign-in, and kept for once it is."""

        async def validate(token: str) -> UserResponse:
            user = await ask(token)
            if self._person is None:
                person = person_key(user.did)
                # Recorded only on a sign-in that still holds the token asked
                # about: an answer of who an older token was names nobody of a
                # sign-in that has moved on.
                if await self._kept.record_person_key(token, person) and self._person is None:
                    self.attach(person)
            return user

        return validate

    def _unreadable(self, unread: Exception) -> None:
        """Tell the session's host that its client keeps nothing more: the sign-in could not be read before a save."""
        if self._on_error is None:
            return
        failed = SessionError(
            "session.keep-failed",
            f"The sign-in could not be read before what the client keeps was saved, so it keeps nothing more: {unread}",
            kb_id=self._kb_id,
        )
        failed.__cause__ = unread
        self._on_error(failed)

    async def close(self) -> None:
        """Make what the client still owes once it has closed, as every write is made: only while the sign-in names its person.

        Raises the first write the storage refused (`_WhileNamed.close`).
        """
        if self._beneath is not None:
            await self._beneath.close()


def _gateway_of(kb: KbTarget) -> str:
    """The origin of the gateway `kb` is reached at, for a session.

    Raises `SessionError` (`session.construct-failed`) for a knowledge base
    reached any other way than over HTTP, and for a host that is no host's
    name.
    """
    endpoint = kb.endpoint
    if isinstance(endpoint, LocalEndpoint):
        kind = endpoint.kind
        raise SessionError("session.construct-failed", f'A session over HTTP cannot be built for endpoint kind "{kind}"', kb_id=kb.id)
    try:
        return gateway_url(endpoint)
    except ValueError as invalid:
        raise SessionError("session.construct-failed", str(invalid), kb_id=kb.id) from None


@asynccontextmanager
async def session_from_kept(
    kb: KbTarget,
    *,
    kept: SignInKept,
    validate: bool = True,
    channels: Sequence[str] = BRIDGED_CHANNELS,
    storage: SessionStorage | None = None,
    on_auth_failed: Callable[[SessionEndReason], None] | None = None,
    on_error: Callable[[SessionError], None] | None = None,
    http: httpx.AsyncClient | None = None,
) -> AsyncGenerator[SemiontSession[HttpTransport]]:
    """A session with the knowledge base `kb`, at the gateway its endpoint names, over the sign-in `kept` holds.

    Held with `async with`, and ready inside it: the session, its client and
    the client's transport are open, and each is closed on the way out. A
    token the gateway refuses is renewed through the session, so the transport
    and the session never hold different ones.

    With nothing kept, the session is signed out: its `token` is none, and a
    request made through its client is refused. `validate` is whether the
    gateway is asked who the token is; `channels` are the global channels the
    transport's stream names.

    With a `storage`, what the client's persisted queries hold is kept there
    for the person the gateway says the token is, once `kept` has recorded
    them, and the stream's place in each scope with it: their next session
    over the same storage shows what was kept at once, and is sent what was
    recorded since. A sign-in that names its person already begins with what
    was kept for them. A session that does not `validate` keeps nothing, and
    neither does one whose `kept` records nobody (a `SignInStore`'s).
    Whatever holds the sign-in, it is asked before each write what it holds,
    and once it no longer names the person, because it was forgotten or a new
    sign-in was kept in its place, the session writes nothing more. Forgetting
    a saved sign-in deletes what was kept for its person only where what holds
    it keeps it in `storage` itself, for `kb` (`semiont.registry.kept_in`), as
    a registry's does; a `MemorySignIn` cannot reach the storage, and deletes
    nothing. A sign-in that cannot be read before a write ends what the
    client keeps, and `on_error` is told once (`session.keep-failed`). A write
    the storage refuses loses that save, and writing goes on: the first
    refused is raised on the way out.

    With `http`, every request of the session, of the gateway and of the
    issuer, is made with that client, which its caller built and closes
    (`HttpTransport`, `issuer_client`).

    Raises `SessionError` (`session.construct-failed`), before anything is
    asked, for a knowledge base that is not reached over HTTP or whose host is
    no host's name.
    """
    async with _session_started(
        kb,
        kept=kept,
        validate=validate,
        channels=channels,
        storage=storage,
        on_auth_failed=on_auth_failed,
        on_error=on_error,
        http=http,
    ) as session:
        await session.ready()
        yield session


@asynccontextmanager
async def _session_started(
    kb: KbTarget,
    *,
    kept: SignInKept,
    validate: bool,
    channels: Sequence[str],
    storage: SessionStorage | None,
    on_auth_failed: Callable[[SessionEndReason], None] | None,
    on_error: Callable[[SessionError], None] | None,
    http: httpx.AsyncClient | None,
) -> AsyncGenerator[SemiontSession[HttpTransport]]:
    """`session_from_kept`'s session as soon as it has started, before it is ready: what a registry holds, and waits on itself.

    What its client still owes once it has closed is made as every write is,
    only while `kept` names the person, so what forgetting the sign-in deleted
    stays deleted. A write the storage refused is raised on the way out: a
    registry raises it from its `close`, as it does every failure of what it
    runs.
    """
    base_url = _gateway_of(kb)
    # Read before anything is built: the client begins with what was kept for the person the sign-in names.
    named = await kept.held() if storage is not None and validate else None
    token = Variable[str | None](None)
    renewing = _Renewing(kept, token, http)
    transport = HttpTransport(base_url, token=token, refresher=lambda refused: session.refresh(refused), channels=channels, http=http)
    client = SemiontClient(transport, transport.content, transport)
    asking = _asking(base_url, http) if validate else None
    keeping: _Keeping | None = None
    # A session that never asks who its token is never learns whose its caches would be, and keeps nothing.
    if storage is not None and asking is not None:
        keeping = _Keeping(kb.id, storage, kept, transport, client, on_error)
        if named is not None and named.person_key is not None:
            keeping.attach(named.person_key)
        asking = keeping.recording(asking)
    session: SemiontSession[HttpTransport] = SemiontSession(
        kb=kb,
        client=client,
        token=token,
        kept=kept,
        refresh=renewing,
        validate=asking,
        on_auth_failed=on_auth_failed,
        on_error=on_error,
    )
    try:
        async with transport, client, session:
            yield session
    finally:
        await renewing.close()
        if keeping is not None:
            await keeping.close()


async def sign_in_device(
    kb: KbTarget, kept: SignInKept, on_code: Callable[[DeviceCode], None], *, http: httpx.AsyncClient | None = None
) -> None:
    """Sign in as a person from a process with no browser, and keep the sign-in in `kept`.

    The issuer the knowledge base `kb` trusts mints a code, `on_code` shows
    the person where to approve it, and the tokens come back here: no password
    passes through this process. The knowledge base and the issuer are asked
    with `http`, when one is given (`issuer_client`). Raises `SignInError`
    when the person is not signed in, and (`discovery`) for a knowledge base
    that is not reached over HTTP or whose host is no host's name.
    """
    endpoint = kb.endpoint
    if isinstance(endpoint, LocalEndpoint):
        raise SignInError("discovery", f'The device grant needs an HTTP endpoint; this knowledge base\'s is "{endpoint.kind}"')
    try:
        base_url = gateway_url(endpoint)
    except ValueError as invalid:
        raise SignInError("discovery", str(invalid)) from None
    issuer, tokens = await sign_in_with_device_grant(base_url, on_code, http=http)
    await kept.keep(
        HeldSignIn(
            access=tokens.access,
            refresh=tokens.refresh,
            client_id=SCRIPT_CLIENT_ID,
            token_endpoint=issuer.token,
            revocation_endpoint=issuer.revocation,
        )
    )


async def sign_out(kept: SignInKept, *, http: httpx.AsyncClient | None = None) -> None:
    """End the sign-in `kept` holds: it is revoked at its issuer, when the issuer says where, and kept no more.

    The issuer is told with `http`, when one is given (`issuer_client`). The
    sign-in is forgotten whatever the issuer answers: a person who signs out
    is signed out here, and an issuer that could not be told forgets the token
    when it expires. Forgetting a saved sign-in that `semiont.registry.kept_in`
    keeps deletes what was kept for the person it named too; one kept anywhere
    else deletes nothing.
    """
    held = await kept.held()
    if held is None:
        return
    try:
        await _revoked(held.revocation_endpoint, held.client_id, held.refresh, http)
    finally:
        await kept.forget()


async def _revoked(revocation_endpoint: str | None, client_id: str, refresh: str, http: httpx.AsyncClient | None) -> None:
    """Tell the issuer, when it says where, to forget a refresh token.

    Best effort: one that could not be told forgets it when it expires.
    """
    if revocation_endpoint is None:
        return
    try:
        async with issuer_client(http=http) as client:
            await revoke_at_issuer(client, revocation_endpoint, client_id, refresh)
    except SignInError:
        pass


# ── A registry's sessions, over HTTP ────────────────────────────────────


@final
class HttpSessionFactory(SessionFactory):
    """Builds the session of each knowledge base a registry activates, over its gateway.

    The session's caches, and the stream's place in each scope, are kept in
    the registry's storage for the person its stored session names, once the
    gateway has named them, and only while it names them: once that saved
    sign-in is forgotten or a new one replaces it, here or in another context,
    which deletes what was kept for them, nothing more is written. Its token
    is renewed at the issuer its stored session names. Each session renews
    its own: a knowledge base's old session and its new one, during a
    sign-in, are closed in turn. With `http`, every request of each session,
    and each revocation, is made with that client, which its caller built and
    closes.
    """

    def __init__(self, *, http: httpx.AsyncClient | None = None) -> None:
        self._http: Final = http

    @override
    def session(self, options: SessionFactoryOptions) -> AbstractAsyncContextManager[SemiontSession[HttpTransport]]:
        kb = options.kb
        return _session_started(
            KbTarget(id=kb.id, label=kb.label, endpoint=kb.endpoint),
            kept=kept_in(options.storage, kb.id),
            validate=True,
            channels=BRIDGED_CHANNELS,
            storage=options.storage,
            on_auth_failed=options.signals.notify_session_ended,
            on_error=options.on_error,
            http=self._http,
        )

    @override
    async def revoke(self, stored: StoredSession) -> None:
        await _revoked(stored.revocation_endpoint, stored.client_id, stored.refresh, self._http)


# ── What a completed sign-in learns ─────────────────────────────────────


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ConnectionIdentity:
    """Who the knowledge base at an address says it is."""

    did: UserId
    description: KbDescription


async def describe_connection(target: HttpEndpoint, access: str, *, http: httpx.AsyncClient | None = None) -> ConnectionIdentity:
    """Ask the knowledge base at `target` what it is, with a token just issued, and with `http` when one is given.

    It describes itself only to a caller that is signed in, so this is asked
    after the sign-in, and never assumed from the address a person typed or
    the row they clicked. Raises `IdentityUnverifiableError`: `unreachable`
    when the knowledge base was not reached, `not-reported` when it answered
    that it cannot say what it is.
    """
    try:
        base_url = gateway_url(target)
    except ValueError as invalid:
        raise IdentityUnverifiableError("unreachable", str(invalid)) from None
    # A client of this one operation: it hears its replies and nothing else.
    transport = HttpTransport(base_url, token=Variable[str | None](access), channels=reply_channels_for(BROWSE_KB_REQUESTED), http=http)
    asking = SemiontClient(transport, transport.content, transport)
    try:
        async with transport, asking:
            description = await asking.browse.kb()
    except BusRequestError as refusal:
        # A refusal is the knowledge base answering that it cannot say what it is.
        if refusal.code == "bus.rejected":
            raise IdentityUnverifiableError("not-reported", refusal.message) from None
        raise IdentityUnverifiableError("unreachable", refusal.message) from None
    except SemiontError as unanswered:
        # Anything else is not having reached it.
        raise IdentityUnverifiableError("unreachable", unanswered.message) from None
    try:
        did = kb_did(description.domain)
    except ValueError as invalid:
        # A domain no did can hold says nothing of who this is.
        raise IdentityUnverifiableError("not-reported", str(invalid)) from None
    return ConnectionIdentity(did=did, description=description)


# ── A registry's sign-in through the issuer ─────────────────────────────


async def begin_sign_in(browser: SemiontBrowser, options: BeginAuthorizationOptions, *, http: httpx.AsyncClient | None = None) -> str:
    """Begin a sign-in for a registry.

    It finds the issuer the target trusts, with `http` when one is given,
    remembers the pending sign-in in the registry's storage, and gives the URL
    to send the person to.
    """
    return await begin_authorization(options, browser.storage, http=http)


async def complete_sign_in(browser: SemiontBrowser, callback_url: str, *, http: httpx.AsyncClient | None = None) -> SignInOutcome:
    """Finish a sign-in from the URL the issuer sent the person back to.

    It exchanges the code, asks the knowledge base who it is, each with `http`
    when one is given, and has the registry land the sign-in on the entry for
    the knowledge base that answered (`SemiontBrowser.signed_in`). Raises
    `SignInError` when the grant failed, and `IdentityUnverifiableError` when
    it succeeded and the knowledge base could not say who it is: then nothing
    is registered, and nothing is stored.
    """
    pending, tokens = await complete_authorization(callback_url, browser.storage, http=http)
    identity = await describe_connection(pending.target, tokens.access, http=http)
    return await browser.signed_in(
        SignedIn(
            endpoint=pending.target,
            description=identity.description,
            session=StoredSession(
                access=tokens.access,
                refresh=tokens.refresh,
                client_id=BROWSER_CLIENT_ID,
                token_endpoint=pending.issuer.token,
                revocation_endpoint=pending.issuer.revocation,
            ),
            kb_id=pending.kb_id,
            expected_did=pending.expected_did,
            expected_name=pending.expected_name,
        )
    )
