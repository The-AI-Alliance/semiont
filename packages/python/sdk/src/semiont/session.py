"""A session with one knowledge base: the token its client's transport sends, and who is signed in.

A session is a state unit. It writes its token and who is signed in, so
`dispose` ends them, and stops its renewal. It only uses its client, so it
never closes it: whoever made the client and the session ends both, closing
the client first, waiting for its closing flush, and then ending the session
(`semiont.http.session_from_kept` does both).

Headless: it runs in an application, a script, a daemon and a test alike, and
shows nobody anything. What it needs of its surroundings it is given:

- `refresh` renews the token it is handed: before it expires, and when the
  gateway refuses it. It answers the new token, or nothing when there is
  nothing to renew with, and raises `SignInError` when the renewal failed.
- `validate` asks the gateway who a token is: when the session starts, and of
  a token renewed because the gateway refused the one before.
- `on_auth_failed` is told when the session is over, and why: its issuer
  refused to renew it (`expired`), or the gateway refused a token the issuer
  had just issued (`refused`). A reason is not a sentence: what a person reads is the
  host's to say.

What went wrong it says once, on its one errors stream (`errors`): its own
errors, each a `SessionError`, and its transport's failures. It takes no
callback for them. They end when the session ends: what its client's closing
flush meets is said before then, and what the client meets once the session
has ended is said nowhere.

**How a token is held** is one rule for every SDK
(`protocol/specs/src/session/cases.json`, which this package's tests run): when a
token expires, read from its own claims, and how long to wait before renewing
it. The margin before expiry is half the token's lifetime, capped at
`REFRESH_BEFORE_EXP_MS`. A fixed margin can equal the lifetime an issuer
mints, and then every renewal is due the moment it is issued; half a lifetime
cannot, for any lifetime. The wait is never under `MIN_REFRESH_DELAY_MS`, so a
token already past its renewal point is renewed once per interval, not in a
loop. A wait is for the token it was counted from: a token renewed some other
way meanwhile has a wait of its own, so a wait that ran out for a token since
replaced renews nothing.

**What a session does at its start, and when the gateway refuses its token**,
is the same table's `startup` and `refusal`: a token the gateway refuses is
renewed once and asked about once more, and a token the issuer has just
issued and the gateway refuses is final. So one refusal costs at most one
renewal and one ask, whatever the gateway and the issuer answer.

A session whose issuer refuses to renew it clears its token and what it kept,
so a dead credential is never used again. One that never had a credential is
only signed out: there is nothing to end, and nothing is said. A renewal that
got no answer, whenever it is made, leaves the session no usable token and
keeps what is kept: the next refusal renews again, and so does the session on
its own, on the reconnect backoff (each wait a jittered share of a step that
doubles from `RECONNECT_MS` to `MAX_RECONNECT_MS`). A renewal that could not
read what keeps the sign-in got no answer either.

**Every renewal is handed the token it renews**: the token the session holds,
expired or not; at its start, the token found kept, though it has expired;
and once a renewal that got no answer has left it none, the token that
renewal was for. It hands none only when it has held none. So what keeps the
sign-in can tell a renewal made some other way meanwhile from one it must make.
"""

import asyncio
import base64
import binascii
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from types import TracebackType
from typing import Final, Literal, Protocol, Self, final, override
from weakref import WeakKeyDictionary

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont._reading import Reading
from semiont.client import SemiontClient
from semiont.errors import SemiontError, SessionError, SignInError, TransportError
from semiont.events import Broadcast, Events
from semiont.retry import REFRESH, RetryFacts, equal_jitter
from semiont.state_unit import StateUnit
from semiont.timing import MAX_RECONNECT_MS, MIN_REFRESH_DELAY_MS, RECONNECT_MS, REFRESH_BEFORE_EXP_MS
from semiont.transport import ConnectionState, Transport
from semiont.types import KbTarget, UserResponse
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
"""Why a session ended: its issuer refused to renew its token (`expired`), or
the gateway refused a token its issuer had just issued (`refused`)."""

type Refresh = Callable[[str | None], Awaitable[str | None]]
"""Renew the token handed, the one the renewal is for: the new one, or nothing when there is nothing to renew with.

Raises `SignInError` when the renewal failed. Whatever else it raises, a
sign-in that could not be read among it, is a renewal that got no answer.
"""

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


async def renew_when_due(token: Watched[str | None], renew: Callable[[str], Awaitable[object]]) -> None:
    """Renew a token whenever it is due, for as long as it can change.

    Waits what `refresh_delay` says of the token as it is, and hands `renew`
    the token the wait was counted from, to renew only while it is still the
    token held. The wait is counted from each token as it arrives, so one
    renewed some other way starts a wait of its own, even when it arrives as
    the last one's wait runs out, and a renewal that changed nothing is due
    again a floor later. A token that names no expiry schedules nothing: it is
    renewed when whoever it is shown to refuses it.
    """
    changes = aiter(token)
    try:
        current = await anext(changes)
        while True:
            if not current:
                current = await anext(changes)
                continue
            due = current
            try:
                async with asyncio.timeout(refresh_delay(due, now=time.time())):
                    current = await anext(changes)
                continue
            except TimeoutError:
                pass
            await renew(due)
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
    person_key: str | None = None
    """Who a gateway said the sign-in's person is, as the key their caches are kept under
    (`semiont.stored.person_key`); none until a gateway has named them. A renewal keeps it,
    and a new sign-in begins without it."""


class SignInKept(Protocol):
    """Where one knowledge base's sign-in is kept."""

    async def held(self) -> HeldSignIn | None:
        """The sign-in as it is kept now, when there is one.

        A session whose client keeps what it holds asks before each write,
        and writes only while what is kept names its person.
        """
        ...

    async def keep(self, sign_in: HeldSignIn) -> None:
        """Keep a new sign-in, in place of whatever was kept: a renewal is kept with `renewed`."""
        ...

    async def renewed(self, read: HeldSignIn, access: str, refresh: str) -> str | None:
        """Keep the tokens a renewal of `read` issued, against what is kept now: the access token kept then.

        When what is kept no longer holds `read`'s tokens, it was renewed some
        other way meanwhile: that stands, and its access token is the one
        given. Nothing when nothing is kept: a sign-in that was signed out, or
        ended, while it was being renewed is gone, and is not written back.
        """
        ...

    async def record_person_key(self, access: str, person_key: str) -> bool:
        """Record who a gateway said the holder of `access` is, as one step against what is kept now.

        Recorded only on a sign-in that still holds `access`, the token the
        gateway was asked about, and names nobody else: true then, and when it
        names `person_key` already. False when nothing is kept, when what is
        kept moved on to another token, and when it names another person,
        which is never written over. It is how a session records its person
        on whatever keeps its sign-in, and keeps nothing for them unless it
        did.
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
    async def renewed(self, read: HeldSignIn, access: str, refresh: str) -> str | None:
        if self._sign_in is None:
            return None
        if (self._sign_in.access, self._sign_in.refresh) != (read.access, read.refresh):
            return self._sign_in.access
        self._sign_in = replace(self._sign_in, access=access, refresh=refresh)
        return access

    @override
    async def record_person_key(self, access: str, person_key: str) -> bool:
        kept = self._sign_in
        if kept is None or kept.access != access or kept.person_key not in (None, person_key):
            return False
        self._sign_in = replace(kept, person_key=person_key)
        return True

    @override
    async def forget(self) -> None:
        self._sign_in = None


# ── The session ─────────────────────────────────────────────────────────


def _not_renewed(failure: Exception | None) -> str:
    """Why a renewal gave no token, for whoever reads the error."""
    return "Token refresh failed" if failure is None else f"Token refresh failed: {failure}"


def _refused(failure: Exception) -> bool:
    """Whether a renewal failed because the issuer refused it: an answer the `refresh` rule does not try again.

    No answer, one it tries again until the budget is spent, and a sign-in
    that could not be read are no refusal.
    """
    if not isinstance(failure, SignInError) or failure.code != "exchange" or failure.status is None:
        return False
    return not REFRESH.retryable(RetryFacts(status=failure.status, method="POST"))


_JUST_ISSUED_AND_REFUSED: Final = "The gateway refused a token its issuer had just issued"


@final
class SemiontSession[T: Transport](StateUnit):
    """See the module's documentation.

    Held with `async with`: it starts inside, and `ready` says when it has
    done what it does at its start. Leaving it ends the session, as `dispose`
    does, and waits for what the session was running to stop. `client` is the
    one whose transport sends its token, typed by the kind of transport that
    is; the session does not open or close either.

    `said` is what is said of what its client keeps by whoever keeps it
    (`semiont.http.session_from_kept`): that it could not be kept
    (`session.keep-failed`), or that the storage refused a write of it
    (`session.save-refused`). Each is said on the session's errors while the
    session lives. Whoever gave it `said` closes the client first, ends
    `said` once the closing flush is made, and waits for `said_in_full`
    before ending the session: so what that flush meets is said before the
    errors end.
    """

    def __init__(
        self,
        *,
        kb: KbTarget,
        client: SemiontClient[T],
        token: Variable[str | None],
        kept: SignInKept,
        refresh: Refresh | None = None,
        validate: Validate | None = None,
        on_auth_failed: Callable[[SessionEndReason], None] | None = None,
        said: Events[SessionError] | None = None,
    ) -> None:
        self.id: Final = f"session-{uuid.uuid4()}"
        """Which live session this is: a new one for the same knowledge base has another."""
        self.kb: Final = kb
        """The knowledge base the session is with: where it is reached, and `id`, the key its credentials are kept under."""
        self.client: Final[SemiontClient[T]] = client
        self._token: Final = token
        self._kept: Final = kept
        self._refresh: Final = refresh
        self._validate: Final = validate
        self._on_auth_failed: Final = on_auth_failed
        self._said: Final = said
        self._errors: Final = Broadcast[SemiontError]()
        # Its first reader's, made with it: what the session says before anyone asks to hear it is not lost to the first who does.
        self._first: Events[SemiontError] | None = self._errors.listen()
        self._user: Final[Variable[UserResponse | None]] = Variable(None)
        self._ready: Final = asyncio.Event()
        self._closing: Final = asyncio.Event()
        # Held while a refusal is being answered, so that the refusals that arrive during it are answered by it.
        self._answering: Final = asyncio.Lock()
        # Set while a renewal that got no answer is owed another attempt.
        self._unanswered: Final = asyncio.Event()
        self._given_up: str | None = None
        """The token a renewal that got no answer was for, while the session holds none since: the one the next renewal renews."""
        self._running: asyncio.Task[None] | None = None

    @property
    def token(self) -> Watched[str | None]:
        """The token the transport sends: the present one, and each after it."""
        return Reading(self._token)

    @property
    def user(self) -> Watched[UserResponse | None]:
        """Who is signed in, once the gateway has said."""
        return Reading(self._user)

    @property
    def stream_state(self) -> Watched[ConnectionState]:
        """The state of the client's connection."""
        return self.client.transport.state

    def errors(self) -> Events[SemiontError]:
        """The session's one stream of what went wrong: its own errors, each a `SessionError`, and its transport's failures, each said once.

        Its first reader is given everything said since the session was made;
        every later one, what is said from then on. It ends when the session
        does. A host routes them: a refusal for want of a valid token is a
        reason to `refresh`.
        """
        first, self._first = self._first, None
        return self._errors.listen() if first is None else first

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
        # Heard from its start: what its transport fails at from then on is said on the session's errors.
        failures = self.client.transport.failures()
        self._running = asyncio.create_task(self._run(kept, failures))
        if self._said is not None:
            _RELAYS[self] = asyncio.create_task(self._tell(self._said))
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.dispose()
        started = [task for task in (self._running, _RELAYS.pop(self, None)) if task is not None]
        await asyncio.gather(*started, return_exceptions=True)
        # Whatever ended the session's tasks that was not its ending is raised here.
        for task in started:
            if not task.cancelled():
                await task

    @override
    def dispose(self) -> None:
        """End the session: it renews nothing more, and its token and who is signed in change no more. Ending twice is ending once.

        Its errors end with it, and what `said` says that it has not said by
        then is said nowhere. Its client is left to whoever made it.
        """
        self._closing.set()
        self._ready.set()
        # The token and who is signed in change no more: whoever reads them is told so.
        self._token.end()
        self._user.end()
        if self._running is not None:
            self._running.cancel()
        relay = _RELAYS.get(self)
        if relay is not None:
            relay.cancel()
        self._errors.close()

    async def _tell(self, said: Events[SessionError]) -> None:
        """Say each thing `said` says, for as long as the session lives."""
        async with said:
            async for error in said:
                self._errors.deliver(error)

    async def _relay(self, failures: Events[SemiontError]) -> None:
        """Say each failure the transport meets, for as long as the session lives."""
        async with failures:
            async for failure in failures:
                self._errors.deliver(failure)

    async def _run(self, kept: HeldSignIn | None, failures: Events[SemiontError]) -> None:
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(self._relay(failures))
            tasks.create_task(renew_when_due(self._token, self._renew_due))
            tasks.create_task(self._renew_when_unanswered())
            try:
                await self._start(kept)
            finally:
                self._ready.set()

    async def refresh(self, refused: str | None) -> str | None:
        """The gateway refused `refused`: renew it, and ask the gateway who the new one is.

        `refused` is the token a request carried, `None` when it carried none.
        Returns the token the session then holds, or nothing: it holds no
        token, and if the issuer refused to renew a kept sign-in it is over. A
        transport asks this when the gateway refuses it.

        One refusal is answered at a time, so however many requests were
        refused at once, they cost one renewal and one ask, and who the gateway
        says the renewed token is, is who is signed in. A refusal of a token
        the session no longer holds was answered already, however late it
        arrives: the token it holds is given, and nothing is renewed or asked.
        A gateway that cannot be asked refuses nothing: the renewed token is
        given. Once the session has ended, a refusal is given nothing,
        whatever token it refused, and nothing is renewed or asked.
        """
        async with self._answering:
            # Checked once the refusals before it are answered: one that waited for them through the ending is given nothing too.
            if self._closing.is_set():
                return None
            if self._token.value != refused:
                return self._token.value
            renewed = await self._renew()
            if renewed is None or self._validate is None:
                return renewed
            # While the session is starting, its start is what asks: it finds
            # the token renewed here and takes it up as the just-issued one.
            if not self._ready.is_set():
                return renewed
            try:
                user = await self._validate(renewed)
            except SemiontError as refusal:
                # A gateway that could not be asked refused nothing. And only a
                # token the session still holds ends it: one replaced while the
                # gateway was being asked is no longer the session's to be
                # refused.
                renewed_refused = isinstance(refusal, TransportError) and refusal.code == "unauthorized"
                if renewed_refused and not self._closing.is_set() and self._token.value == renewed:
                    await self._signed_out(
                        "refused", SessionError("session.credential-refused", _JUST_ISSUED_AND_REFUSED, kb_id=self.kb.id)
                    )
            else:
                # Who the token the session still holds is, as the gateway said.
                if not self._closing.is_set() and self._token.value == renewed:
                    self._user.set(user)
            return None if self._closing.is_set() else self._token.value

    async def _try_refresh(self, holding: str | None) -> tuple[str | None, Exception | None]:
        """Ask `refresh` to renew `holding`. A renewal not made and one refused both leave the session without a token.

        Returns the token, and why there is none: the `SignInError` it raised,
        or whatever else it raised, which is a renewal that got no answer.
        """
        if self._refresh is None:
            return None, None
        try:
            return await self._refresh(holding), None
        except Exception as failure:
            return None, failure

    def _renews(self) -> str | None:
        """The token a renewal is for: the one the session holds, or, while it holds none since a renewal got no answer, that renewal's."""
        held = self._token.value
        return self._given_up if held is None else held

    async def _renew(self) -> str | None:
        """Renew the token at the issuer, with nobody asked afterwards: what the session does on its own schedule."""
        if self._closing.is_set() or self._refresh is None:
            return None
        holding = self._renews()
        renewed, failure = await self._try_refresh(holding)
        if self._closing.is_set():
            return None
        if renewed is not None:
            self._unanswered.clear()
            self._given_up = None
            self._token.set(renewed)
            return renewed
        self._token.set(None)
        # A session that never had a credential cannot expire: it is signed
        # out, which is no failure. Ending the session below also forgets the
        # credential, so the refusals that follow it are quiet too. A renewal
        # that could not read the sign-in got no answer, and it is not read again.
        if failure is None or isinstance(failure, SignInError):
            try:
                still_kept = await self._kept.held() is not None
            except Exception as unread:
                failure, still_kept = unread, True
            if not still_kept:
                self._unanswered.clear()
                return None
        await self._unrenewed(failure, holding)
        return None

    async def _renew_due(self, due: str) -> None:
        """Renew `due`, whose wait on the session's own schedule ran out, while it is still the token the session holds.

        One replaced meanwhile was renewed some other way, and has a wait of
        its own: nothing is renewed now.
        """
        if self._token.value == due:
            await self._renew()

    async def _renew_when_unanswered(self) -> None:
        """After a renewal that got no answer, renew again on the reconnect backoff.

        Each wait is the equal jitter of its step, the step `RECONNECT_MS`
        doubling to `MAX_RECONNECT_MS`. It ends when a renewal is made or
        refused, when a token arrives some other way, and when the session
        ends. A renewal made while nobody has said who the session's token
        is asks the gateway once, as the start would have.
        """
        while True:
            await self._unanswered.wait()
            step = RECONNECT_MS
            while self._unanswered.is_set():
                await asyncio.sleep(equal_jitter(step) / 1000)
                if self._token.value is not None:
                    self._unanswered.clear()
                elif self._unanswered.is_set():
                    await (self.refresh(None) if self._user.value is None else self._renew())
                step = min(2 * step, MAX_RECONNECT_MS)

    async def _unrenewed(self, failure: Exception | None, holding: str | None) -> None:
        """A renewal of what is kept, for `holding`, gave no token, and the session holds none.

        The issuer's refusal, or nothing left to renew with, ends the session.
        Any other failure keeps what is kept, and says why: the next refusal
        renews again, and so does the reconnect backoff, each renewing `holding`.
        """
        self._token.set(None)
        not_renewed = SessionError("session.refresh-exhausted", _not_renewed(failure), kb_id=self.kb.id)
        if failure is not None and not _refused(failure):
            self._given_up = holding
            self._unanswered.set()
            self._failed(not_renewed)
        else:
            await self._signed_out("expired", not_renewed)

    async def _signed_out(self, told: SessionEndReason, error: SessionError) -> None:
        """The session is over: its credential is forgotten, and its host is told why. The one teardown, whichever way it ended."""
        self._unanswered.clear()
        self._given_up = None
        self._token.set(None)
        self._user.set(None)
        await self._kept.forget()
        if self._on_auth_failed is not None:
            self._on_auth_failed(told)
        self._failed(error)

    def _failed(self, error: SessionError) -> None:
        """Say `error` on the session's errors."""
        self._errors.deliver(error)

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
            # Handed the token found kept, which has expired: the session does not send it, but it is the one renewed.
            renewed, failure = await self._try_refresh(token)
            if renewed is None:
                if failure is None or _refused(failure):
                    # There was no session to end: the sign-in is forgotten, and nothing is said.
                    await self._kept.forget()
                else:
                    # The issuer did not refuse it: the sign-in is kept, and renewed on the reconnect backoff or when a request is refused.
                    self._given_up = token
                    self._unanswered.set()
                    self._failed(SessionError("session.auth-failed", _not_renewed(failure), kb_id=self.kb.id))
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
                    self._failed(SessionError("session.auth-failed", refusal.message, kb_id=self.kb.id))
                    return
            except SemiontError as other:
                self._failed(SessionError("session.auth-failed", other.message, kb_id=self.kb.id))
                return
            if self._closing.is_set():
                return
            if just_issued:
                await self._signed_out("refused", SessionError("session.credential-refused", _JUST_ISSUED_AND_REFUSED, kb_id=self.kb.id))
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
            renewed, failure = await self._try_refresh(token)
            if self._closing.is_set():
                return
            if renewed is None:
                await self._unrenewed(failure, token)
                return
            self._token.set(renewed)
            token, just_issued = renewed, True


_RELAYS: Final = WeakKeyDictionary[SemiontSession[Transport], asyncio.Task[None]]()
"""Each started session's saying of the `said` it was given, from its start until `said` or the session ends; until it is left."""


async def said_in_full(session: SemiontSession[Transport]) -> None:
    """Wait until `session` has said everything the `said` it was given said, once that has ended.

    What whoever gave a session `said` awaits after ending it, before ending
    the session: whatever `said` said is then on the session's errors, by
    construction, before they end. Of a session given no `said`, not
    started, or already left, there is nothing to wait for. It waits for
    good on a `said` that has not ended.
    """
    relay = _RELAYS.get(session)
    if relay is not None:
        await asyncio.wait([relay])
