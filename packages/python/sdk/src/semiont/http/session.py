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
from semiont.stored import StoredSession
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

    def __init__(self, kept: SignInKept, token: Variable[str | None]) -> None:
        self._kept: Final = kept
        self._token: Final = token
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
            return await renew_kept(self._kept, self._token.value)
        finally:
            self._under_way = None

    async def close(self) -> None:
        """End the renewal under way, when there is one: nobody is left to give its token to."""
        under_way = self._under_way
        if under_way is not None:
            under_way.cancel()
            await asyncio.gather(under_way, return_exceptions=True)


def _asking(base_url: str) -> Validate:
    """Ask the gateway who a token is: one request, by a caller that holds nothing else.

    No stream is opened for it, and nothing renews the token: a refusal is
    the answer.
    """

    async def ask(token: str) -> UserResponse:
        asking = HttpTransport(base_url, token=Variable[str | None](token), channels=())
        try:
            return await asking.get_current_user()
        finally:
            await asking.close()

    return ask


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

    With a `storage`, what the client's small queries hold is kept there
    under the knowledge base's id, and the stream's place in each scope with
    it: the next session over the same storage shows what was kept at once,
    and is sent what was recorded since.

    Raises `SessionError` (`session.construct-failed`), before anything is
    asked, for a knowledge base that is not reached over HTTP or whose host is
    no host's name.
    """
    async with _session_started(
        kb, kept=kept, validate=validate, channels=channels, storage=storage, on_auth_failed=on_auth_failed, on_error=on_error
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
) -> AsyncGenerator[SemiontSession[HttpTransport]]:
    """`session_from_kept`'s session as soon as it has started, before it is ready: what a registry holds, and waits on itself."""
    base_url = _gateway_of(kb)
    token = Variable[str | None](None)
    renewing = _Renewing(kept, token)
    # The stream's place rides the caches' writes, and only when every cache is
    # at rest: a place kept ahead of a cache still taking in the event it names
    # would have the next session skip that event.
    places = None if storage is None else CoupledBookmarks(storage, f"semiont.lastEventId.{kb.id}")
    transport = HttpTransport(base_url, token=token, refresher=lambda: session.refresh(), channels=channels, bookmarks=places)
    client = SemiontClient(
        transport,
        transport.content,
        transport,
        persistence=None if places is None else CachePersistence(storage=places.storage, key_prefix=kb.id),
    )
    if places is not None:
        places.set_flush_gate(lambda: client.persistence_settled)
    session: SemiontSession[HttpTransport] = SemiontSession(
        kb=kb,
        client=client,
        token=token,
        kept=kept,
        refresh=renewing,
        validate=_asking(base_url) if validate else None,
        on_auth_failed=on_auth_failed,
        on_error=on_error,
    )
    try:
        async with transport, client, session:
            yield session
    finally:
        await renewing.close()


async def sign_in_device(kb: KbTarget, kept: SignInKept, on_code: Callable[[DeviceCode], None]) -> None:
    """Sign in as a person from a process with no browser, and keep the sign-in in `kept`.

    The issuer the knowledge base `kb` trusts mints a code, `on_code` shows
    the person where to approve it, and the tokens come back here: no password
    passes through this process. Raises `SignInError` when the person is not
    signed in, and (`discovery`) for a knowledge base that is not reached
    over HTTP or whose host is no host's name.
    """
    endpoint = kb.endpoint
    if isinstance(endpoint, LocalEndpoint):
        raise SignInError("discovery", f'The device grant needs an HTTP endpoint; this knowledge base\'s is "{endpoint.kind}"')
    try:
        base_url = gateway_url(endpoint)
    except ValueError as invalid:
        raise SignInError("discovery", str(invalid)) from None
    issuer, tokens = await sign_in_with_device_grant(base_url, on_code)
    await kept.keep(
        HeldSignIn(
            access=tokens.access,
            refresh=tokens.refresh,
            client_id=SCRIPT_CLIENT_ID,
            token_endpoint=issuer.token,
            revocation_endpoint=issuer.revocation,
        )
    )


async def sign_out(kept: SignInKept) -> None:
    """End the sign-in `kept` holds: it is revoked at its issuer, when the issuer says where, and kept no more.

    The sign-in is forgotten whatever the issuer answers: a person who signs
    out is signed out here, and an issuer that could not be told forgets the
    token when it expires.
    """
    held = await kept.held()
    if held is None:
        return
    try:
        await _revoked(held.revocation_endpoint, held.client_id, held.refresh)
    finally:
        await kept.forget()


async def _revoked(revocation_endpoint: str | None, client_id: str, refresh: str) -> None:
    """Tell the issuer, when it says where, to forget a refresh token.

    Best effort: one that could not be told forgets it when it expires.
    """
    if revocation_endpoint is None:
        return
    try:
        async with issuer_client() as http:
            await revoke_at_issuer(http, revocation_endpoint, client_id, refresh)
    except SignInError:
        pass


# ── A registry's sessions, over HTTP ────────────────────────────────────


@final
class HttpSessionFactory(SessionFactory):
    """Builds the session of each knowledge base a registry activates, over its gateway.

    The session's caches, and the stream's place in each scope, are kept in
    the registry's storage, under the knowledge base's id, and its token is
    renewed at the issuer its stored session names. Each session renews its
    own: a knowledge base's old session and its new one, during a sign-in,
    are closed in turn.
    """

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
        )

    @override
    async def revoke(self, stored: StoredSession) -> None:
        await _revoked(stored.revocation_endpoint, stored.client_id, stored.refresh)


# ── What a completed sign-in learns ─────────────────────────────────────


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ConnectionIdentity:
    """Who the knowledge base at an address says it is."""

    did: UserId
    description: KbDescription


async def describe_connection(target: HttpEndpoint, access: str) -> ConnectionIdentity:
    """Ask the knowledge base at `target` what it is, with a token just issued.

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
    transport = HttpTransport(base_url, token=Variable[str | None](access), channels=reply_channels_for(BROWSE_KB_REQUESTED))
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


async def begin_sign_in(browser: SemiontBrowser, options: BeginAuthorizationOptions) -> str:
    """Begin a sign-in for a registry.

    It finds the issuer the target trusts, remembers the pending sign-in in the
    registry's storage, and gives the URL to send the person to.
    """
    return await begin_authorization(options, browser.storage)


async def complete_sign_in(browser: SemiontBrowser, callback_url: str) -> SignInOutcome:
    """Finish a sign-in from the URL the issuer sent the person back to.

    It exchanges the code, asks the knowledge base who it is, and has the
    registry land the sign-in on the entry for the knowledge base that
    answered (`SemiontBrowser.signed_in`). Raises `SignInError` when the grant
    failed, and `IdentityUnverifiableError` when it succeeded and the
    knowledge base could not say who it is: then nothing is registered, and
    nothing is stored.
    """
    pending, tokens = await complete_authorization(callback_url, browser.storage)
    identity = await describe_connection(pending.target, tokens.access)
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
