"""A person's session with a knowledge base over its gateway.

`session_from_kept` builds one over a sign-in that is kept somewhere: the one
`semiont login` made, when it is kept in a `semiont.sign_in_store.SignInStore`,
or one this application kept earlier. `sign_in_device` makes a sign-in to
keep, from a process with no browser. `sign_out` ends one.

A session built here renews its token at the issuer its kept sign-in names.
Renewals that are asked for together are one request: a stream refused and a
request refused at the same moment spend one refresh token, not two, of which
an issuer that rotates them would refuse the second. And a renewal, once it
is under way, runs to its end whoever stops waiting for it: a refresh token
that has been spent is not left without the one it bought.

A person's token is one credential source. An agent's is another
(`semiont.http.agent`), which feeds a transport the same way.
"""

import asyncio
from collections.abc import AsyncGenerator, Callable, Sequence
from contextlib import asynccontextmanager
from typing import Final, final

from semiont.channels import BRIDGED_CHANNELS
from semiont.client import CachePersistence, SemiontClient
from semiont.errors import SessionError, SignInError
from semiont.http.oauth import DeviceCode, issuer_client, renew_kept, revoke_at_issuer, sign_in_with_device_grant
from semiont.http.transport import HttpTransport
from semiont.oauth_clients import SCRIPT_CLIENT_ID
from semiont.resume import CoupledBookmarks
from semiont.session import HeldSignIn, SemiontSession, SessionEndReason, SignInKept, Validate
from semiont.storage import SessionStorage
from semiont.types import UserResponse
from semiont.watched import Variable

__all__ = ["session_from_kept", "sign_in_device", "sign_out"]


def _heard(renewal: asyncio.Task[str | None]) -> None:
    """Take a renewal's failure as heard: each of its waiters was told, and there may be none."""
    if not renewal.cancelled():
        renewal.exception()


@final
class _Renewing:
    """A kept sign-in's renewals at its issuer, one at a time: a renewal asked for while one is under way is that one."""

    def __init__(self, kept: SignInKept) -> None:
        self._kept: Final = kept
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
            return await renew_kept(self._kept)
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


@asynccontextmanager
async def session_from_kept(
    base_url: str,
    *,
    kb_id: str,
    kept: SignInKept,
    validate: bool = True,
    channels: Sequence[str] = BRIDGED_CHANNELS,
    storage: SessionStorage | None = None,
    on_auth_failed: Callable[[SessionEndReason], None] | None = None,
    on_error: Callable[[SessionError], None] | None = None,
) -> AsyncGenerator[SemiontSession[HttpTransport]]:
    """A session with the knowledge base whose gateway is at `base_url`, over the sign-in `kept` holds.

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
    """
    token = Variable[str | None](None)
    renewing = _Renewing(kept)
    # The stream's place rides the caches' writes, and only when every cache is
    # at rest: a place kept ahead of a cache still taking in the event it names
    # would have the next session skip that event.
    places = None if storage is None else CoupledBookmarks(storage, f"semiont.lastEventId.{kb_id}")
    transport = HttpTransport(base_url, token=token, refresher=lambda: session.refresh(), channels=channels, bookmarks=places)
    client = SemiontClient(
        transport,
        transport.content,
        transport,
        persistence=None if places is None else CachePersistence(storage=places.storage, key_prefix=kb_id),
    )
    if places is not None:
        places.set_flush_gate(lambda: client.persistence_settled)
    session: SemiontSession[HttpTransport] = SemiontSession(
        kb_id=kb_id,
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
            await session.ready()
            yield session
    finally:
        await renewing.close()


async def sign_in_device(base_url: str, kept: SignInKept, on_code: Callable[[DeviceCode], None]) -> None:
    """Sign in as a person from a process with no browser, and keep the sign-in in `kept`.

    The issuer the knowledge base at `base_url` trusts mints a code, `on_code`
    shows the person where to approve it, and the tokens come back here: no
    password passes through this process. Raises `SignInError` when the
    person is not signed in.
    """
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
        if held.revocation_endpoint is not None:
            async with issuer_client() as http:
                await revoke_at_issuer(http, held.revocation_endpoint, held.client_id, held.refresh)
    except SignInError:
        pass
    finally:
        await kept.forget()
