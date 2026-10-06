"""A session with one knowledge base: its client, the token the client's transport sends, and who is signed in.

Headless: it runs in an application, a script, a daemon and a test alike, and
shows nobody anything. What it needs of its surroundings it is given:

- `refresh` renews the token: before it expires, and when the gateway refuses
  it. It answers the new token, or nothing when there is nothing to renew
  with, and raises `SignInError` when the renewal failed.
- `validate` asks the gateway who a token is: when the session starts, and of
  a token renewed because the gateway refused the one before.
- `on_auth_failed` is told when the session is over, and why: it could not be
  renewed (`expired`), or the gateway refused a token the issuer had just
  issued (`refused`). A reason is not a sentence: what a person reads is the
  host's to say. `on_error` is told of every failure that makes the session
  unusable.

**How a token is held** is one rule for every SDK
(`specs/src/session/cases.json`, which this package's tests run): when a
token expires, read from its own claims, and how long to wait before renewing
it. The margin before expiry is half the token's lifetime, capped at
`REFRESH_BEFORE_EXP_MS`. A fixed margin can equal the lifetime an issuer
mints, and then every renewal is due the moment it is issued; half a lifetime
cannot, for any lifetime. The wait is never under `MIN_REFRESH_DELAY_MS`, so a
token already past its renewal point is renewed once per interval, not in a
loop.

**What a session does at its start, and when the gateway refuses its token**,
is the same table's `startup` and `refusal`: a token the gateway refuses is
renewed once and asked about once more, and a token the issuer has just
issued and the gateway refuses is final. So one refusal costs at most one
renewal and one ask, whatever the gateway and the issuer answer.

A session that cannot be renewed clears its token and what it kept, so a dead
credential is never used again. One that never had a credential is only
signed out: there is nothing to end, and nothing is said.
"""

import asyncio
import base64
import binascii
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from types import TracebackType
from typing import Final, Literal, Protocol, Self, final, override

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont.client import SemiontClient
from semiont.errors import SemiontError, SessionError, SignInError, TransportError
from semiont.timing import MIN_REFRESH_DELAY_MS, REFRESH_BEFORE_EXP_MS
from semiont.transport import Transport
from semiont.types import UserResponse
from semiont.watched import Variable, Watched

__all__ = [
    "HeldSignIn",
    "MemorySignIn",
    "Refresh",
    "SemiontSession",
    "SessionEndReason",
    "SignInKept",
    "Validate",
    "is_token_expired",
    "refresh_delay",
    "renew_when_due",
    "renewal_delay",
    "text_claim",
    "token_expiry",
]

type SessionEndReason = Literal["expired", "refused"]
"""Why a session ended: its token could not be renewed (`expired`), or the
gateway refused a token its issuer had just issued (`refused`)."""

type Refresh = Callable[[], Awaitable[str | None]]
"""Renew the token: the new one, or nothing when there is nothing to renew with. Raises `SignInError` when the renewal failed."""

type Validate = Callable[[str], Awaitable[UserResponse]]
"""Ask the gateway who a token is. Raises `TransportError` when it refuses, or cannot be asked."""

_CLAIMS: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


# ── How a token is held ─────────────────────────────────────────────────


def _claims(token: str) -> Mapping[str, JsonValue] | None:
    """The claims of a JWT: its second segment of three, base64url without padding, UTF-8 JSON."""
    segments = token.split(".")
    if len(segments) != 3:
        return None
    payload = segments[1]
    try:
        return _CLAIMS.validate_json(base64.b64decode(payload + "=" * (-len(payload) % 4), altchars=b"-_", validate=True))
    except (binascii.Error, ValidationError):
        return None


def _seconds(claims: Mapping[str, JsonValue], name: str) -> float | None:
    """A numeric claim, in seconds. Absent, or zero, is none."""
    value = claims.get(name)
    if isinstance(value, bool) or not isinstance(value, int | float) or value == 0:
        return None
    return value


def text_claim(token: str, name: str) -> str | None:
    """A claim of a token that is text, when the token carries one."""
    claims = _claims(token)
    value = None if claims is None else claims.get(name)
    return value if isinstance(value, str) else None


def token_expiry(token: str) -> float | None:
    """When a token expires, by its `exp` claim, in seconds since the epoch. Nothing when it names no time."""
    claims = _claims(token)
    return None if claims is None else _seconds(claims, "exp")


def is_token_expired(token: str, *, now: float) -> bool:
    """Whether a token is past its expiry at `now`. One that names no expiry is read as expired: nothing says it is still good."""
    expiry = token_expiry(token)
    return expiry is None or expiry < now


def renewal_delay(lifetime: float, remaining: float) -> float:
    """How long to wait, in seconds, before renewing a token that lives `lifetime` in all and has `remaining` of it left."""
    margin = min(REFRESH_BEFORE_EXP_MS / 1000, lifetime / 2)
    return max(remaining - margin, MIN_REFRESH_DELAY_MS / 1000)


def refresh_delay(token: str, *, now: float) -> float | None:
    """How long to wait, in seconds from `now`, before renewing `token`.

    Nothing when it has no readable `exp`: nothing is scheduled. The lifetime
    is the one the issuer chose (`exp - iat`); with no `iat`, what remains of
    it.
    """
    claims = _claims(token)
    expiry = None if claims is None else _seconds(claims, "exp")
    if claims is None or expiry is None:
        return None
    remaining = max(expiry - now, 0)
    issued = _seconds(claims, "iat")
    return renewal_delay(remaining if issued is None else max(expiry - issued, 0), remaining)


async def renew_when_due(token: Watched[str | None], renew: Callable[[], Awaitable[object]]) -> None:
    """Renew a token whenever it is due, for as long as it can change.

    Waits what `refresh_delay` says of the token as it is, and calls `renew`.
    The wait is counted from each token as it arrives, so one renewed some
    other way starts a wait of its own, and a renewal that changed nothing is
    due again a floor later. A token that names no expiry schedules nothing:
    it is renewed when whoever it is shown to refuses it.
    """
    changes = aiter(token)
    try:
        current = await anext(changes)
        while True:
            due = None if not current else refresh_delay(current, now=time.time())
            try:
                async with asyncio.timeout(due):
                    current = await anext(changes)
                continue
            except TimeoutError:
                pass
            await renew()
            current = token.value
    except StopAsyncIteration:
        return


# ── What a session keeps ────────────────────────────────────────────────


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class HeldSignIn:
    """What is kept of a sign-in.

    The tokens an issuer issued, the client they were issued to, and the
    issuer's endpoints a renewal and a sign-out need, learned once at sign-in
    so no session asks again.
    """

    access: str
    refresh: str
    client_id: str
    token_endpoint: str
    revocation_endpoint: str | None = None


class SignInKept(Protocol):
    """Where one knowledge base's sign-in is kept."""

    async def held(self) -> HeldSignIn | None:
        """The sign-in as it is kept now, when there is one."""
        ...

    async def keep(self, sign_in: HeldSignIn) -> None:
        """Keep a sign-in, in place of whatever was kept."""
        ...

    async def renewed(self, access: str, refresh: str) -> bool:
        """Keep the tokens a renewal issued, against what is kept now.

        False when nothing is: a sign-in that was signed out, or ended, while
        it was being renewed is gone, and is not written back.
        """
        ...

    async def forget(self) -> None:
        """Keep the sign-in no more."""
        ...


@final
class MemorySignIn(SignInKept):
    """A sign-in kept for as long as the process lives, and no longer."""

    def __init__(self, sign_in: HeldSignIn | None = None) -> None:
        self._sign_in = sign_in

    @override
    async def held(self) -> HeldSignIn | None:
        return self._sign_in

    @override
    async def keep(self, sign_in: HeldSignIn) -> None:
        self._sign_in = sign_in

    @override
    async def renewed(self, access: str, refresh: str) -> bool:
        if self._sign_in is None:
            return False
        self._sign_in = HeldSignIn(
            access=access,
            refresh=refresh,
            client_id=self._sign_in.client_id,
            token_endpoint=self._sign_in.token_endpoint,
            revocation_endpoint=self._sign_in.revocation_endpoint,
        )
        return True

    @override
    async def forget(self) -> None:
        self._sign_in = None


# ── The session ─────────────────────────────────────────────────────────


def _not_renewed(failure: str | None) -> str:
    """Why a renewal gave no token, for whoever reads the error."""
    return "Token refresh failed" if failure is None else f"Token refresh failed: {failure}"


_JUST_ISSUED_AND_REFUSED: Final = "The gateway refused a token its issuer had just issued"


@final
class SemiontSession[T: Transport]:
    """See the module's documentation.

    Held with `async with`: it starts inside, and `ready` says when it has
    done what it does at its start. `client` is the one whose transport sends
    its token, typed by the kind of transport that is; the session does not
    open or close either.
    """

    def __init__(
        self,
        *,
        kb_id: str,
        client: SemiontClient[T],
        token: Variable[str | None],
        kept: SignInKept,
        refresh: Refresh | None = None,
        validate: Validate | None = None,
        on_auth_failed: Callable[[SessionEndReason], None] | None = None,
        on_error: Callable[[SessionError], None] | None = None,
    ) -> None:
        self.kb_id: Final = kb_id
        self.client: Final[SemiontClient[T]] = client
        self._token: Final = token
        self._kept: Final = kept
        self._refresh: Final = refresh
        self._validate: Final = validate
        self._on_auth_failed: Final = on_auth_failed
        self._on_error: Final = on_error
        self._user: Final[Variable[UserResponse | None]] = Variable(None)
        self._ready: Final = asyncio.Event()
        self._closing: Final = asyncio.Event()
        # Held while a refusal is being answered, so that the refusals that arrive during it are answered by it.
        self._answering: Final = asyncio.Lock()
        self._running: asyncio.Task[None] | None = None

    @property
    def token(self) -> Watched[str | None]:
        """The token the transport sends: the present one, and each after it."""
        return self._token

    @property
    def user(self) -> Watched[UserResponse | None]:
        """Who is signed in, once the gateway has said."""
        return self._user

    def expires_at(self) -> float | None:
        """When the token the session holds expires, in seconds since the epoch."""
        token = self._token.value
        return None if token is None else token_expiry(token)

    async def ready(self) -> None:
        """Wait until the session has done what it does at its start. It returns whatever that came to."""
        await self._ready.wait()

    async def __aenter__(self) -> Self:
        if self._running is not None or self._closing.is_set():
            raise RuntimeError("a session is started once")
        # A kept token that is still good is what the transport sends first, unless it was given one already.
        kept = await self._kept.held()
        if kept is not None and not is_token_expired(kept.access, now=time.time()) and self._token.value is None:
            self._token.set(kept.access)
        self._running = asyncio.create_task(self._run(kept))
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.close()

    async def close(self) -> None:
        """End the session: it renews nothing more. Closing twice is closing once."""
        self._closing.set()
        self._ready.set()
        # The token and who is signed in change no more: whoever reads them is told so.
        self._token.end()
        self._user.end()
        running = self._running
        if running is None:
            return
        running.cancel()
        await asyncio.gather(running, return_exceptions=True)
        # Whatever ended the session's task that was not its closing is raised here.
        if not running.cancelled():
            await running

    async def _run(self, kept: HeldSignIn | None) -> None:
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(renew_when_due(self._token, self._renew))
            try:
                await self._start(kept)
            finally:
                self._ready.set()

    async def refresh(self) -> str | None:
        """The gateway refused the session's token: renew it, and ask the gateway who the new one is.

        Returns the token the session then holds, or nothing: it holds no
        token, and if it had a kept sign-in it is over. A transport asks this
        when the gateway refuses it.

        One refusal is answered at a time, so however many requests were
        refused at once, they cost one renewal and one ask. A gateway that
        cannot be asked refuses nothing: the renewed token is given.
        """
        refused_with = self._token.value
        async with self._answering:
            # Refusals that arrive together are answered together: the first
            # renews and asks, and the rest find that the session's token is no
            # longer the one they were refused with.
            if self._token.value != refused_with:
                return self._token.value
            renewed = await self._renew()
            if renewed is None or self._validate is None:
                return renewed
            # While the session is starting, its start is what asks: it finds
            # the token renewed here and takes it up as the just-issued one.
            if not self._ready.is_set():
                return renewed
            try:
                await self._validate(renewed)
            except SemiontError as refusal:
                # A gateway that could not be asked refused nothing. And only a
                # token the session still holds ends it: one replaced while the
                # gateway was being asked is no longer the session's to be
                # refused.
                refused = isinstance(refusal, TransportError) and refusal.code == "unauthorized"
                if refused and not self._closing.is_set() and self._token.value == renewed:
                    await self._signed_out(
                        "refused", SessionError("session.credential-refused", _JUST_ISSUED_AND_REFUSED, kb_id=self.kb_id)
                    )
            return None if self._closing.is_set() else self._token.value

    async def _try_refresh(self) -> tuple[str | None, str | None]:
        """Ask `refresh`. A renewal that could not be made and one that was refused both leave the session without a token.

        Returns the token, and why there is none, for whoever reads why.
        """
        if self._refresh is None:
            return None, None
        try:
            return await self._refresh(), None
        except SignInError as failure:
            return None, failure.message

    async def _renew(self) -> str | None:
        """Renew the token at the issuer, with nobody asked afterwards: what the session does on its own schedule."""
        if self._closing.is_set() or self._refresh is None:
            return None
        renewed, failure = await self._try_refresh()
        if self._closing.is_set():
            return None
        if renewed is not None:
            self._token.set(renewed)
            return renewed
        self._token.set(None)
        # A session that never had a credential cannot expire: it is signed
        # out, which is no failure. Ending the session below also forgets the
        # credential, so the refusals that follow it are quiet too.
        if await self._kept.held() is not None:
            await self._signed_out("expired", SessionError("session.refresh-exhausted", _not_renewed(failure), kb_id=self.kb_id))
        return None

    async def _signed_out(self, told: SessionEndReason, error: SessionError) -> None:
        """The session is over: its credential is forgotten, and its host is told why. The one teardown, whichever way it ended."""
        self._token.set(None)
        self._user.set(None)
        await self._kept.forget()
        if self._on_auth_failed is not None:
            self._on_auth_failed(told)
        self._failed(error)

    def _failed(self, error: SessionError) -> None:
        if self._on_error is not None:
            self._on_error(error)

    async def _start(self, kept: HeldSignIn | None) -> None:
        """What a session does at its start, with the sign-in it found kept.

        Renew it if it has expired, then ask the gateway who it is. A token
        the gateway refuses is renewed once and asked about once more. A token
        the issuer has just issued and the gateway refuses is final: renewing
        again cannot change the answer. So the gateway is asked at most twice
        and the issuer at most once.
        """
        if kept is None:
            return
        just_issued = is_token_expired(kept.access, now=time.time())
        token = kept.access
        if just_issued:
            renewed, _ = await self._try_refresh()
            if renewed is None:
                # There was no session to end: the sign-in is forgotten, and nothing is said.
                await self._kept.forget()
                return
            token = renewed
            self._token.set(token)
        if self._validate is None:
            return
        while not self._closing.is_set():
            try:
                self._user.set(await self._validate(token))
                return
            except TransportError as refusal:
                if refusal.code != "unauthorized":
                    self._failed(SessionError("session.auth-failed", refusal.message, kb_id=self.kb_id))
                    return
            except SemiontError as other:
                self._failed(SessionError("session.auth-failed", other.message, kb_id=self.kb_id))
                return
            if self._closing.is_set():
                return
            if just_issued:
                await self._signed_out("refused", SessionError("session.credential-refused", _JUST_ISSUED_AND_REFUSED, kb_id=self.kb_id))
                return
            # The session's token is no longer the one asked about: the stream
            # was refused with it too, and `refresh` has renewed it meanwhile.
            # That token is the just-issued one, and is not renewed again.
            current = self._token.value
            if current != token:
                if current is None:
                    return
                token, just_issued = current, True
                continue
            renewed, failure = await self._try_refresh()
            if self._closing.is_set():
                return
            if renewed is None:
                await self._signed_out("expired", SessionError("session.refresh-exhausted", _not_renewed(failure), kb_id=self.kb_id))
                return
            self._token.set(renewed)
            token, just_issued = renewed, True
