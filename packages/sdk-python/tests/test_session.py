"""What a session does (`specs/src/session/cases.json`: `startup` and `refusal`).

At its start, with the sign-in it finds kept; and when the gateway refuses its
token, which is when its transport asks it to `refresh`. Each row scripts what
the gateway and the issuer answer, and states how often each may be asked.

How a token is held, the table's other half, is `test_session_tables.py`'s.
"""

import asyncio
import time
from collections import deque
from collections.abc import Sequence
from typing import final

import pytest
from aio import pass_time, run, soon, turns
from doubles import RecordingContent, RecordingGateway
from scripted_transport import Scripted
from spec import SPEC, JsonObject, objects, read, strings, text
from tokens import expired, jwt, token

from semiont.client import SemiontClient
from semiont.errors import BusRequestError, SemiontError, SessionError, SignInError, TransportError
from semiont.session import HeldSignIn, MemorySignIn, Refresh, SemiontSession, SessionEndReason, Validate
from semiont.types import UserResponse
from semiont.watched import Variable

TABLE = read(SPEC / "session/cases.json")
STARTUP = objects(TABLE["startup"], "startup")
REFUSAL = objects(TABLE["refusal"], "refusal")
KB = "kb-alpha"

type Renewal = str | SignInError | None
type Validation = UserResponse | SemiontError


def alice() -> UserResponse:
    return UserResponse.model_validate(
        {"did": "did:web:example.org:users:alice", "email": "alice@example.org", "name": "Alice", "image": None, "domain": "example.org"}
    )


def unauthorized() -> TransportError:
    return TransportError.of_status("HTTP 401", 401, None)


def held(access: str) -> HeldSignIn:
    return HeldSignIn(access=access, refresh="a-refresh-token", client_id="semiont-cli", token_endpoint="https://issuer.test/token")


@final
class World:
    """A session's surroundings, and a record of what the session did to them."""

    def __init__(self, *, kept: str | None = None, renewals: Sequence[Renewal] = (), validations: Sequence[Validation] = ()) -> None:
        self.kept = MemorySignIn(None if kept is None else held(kept))
        self.token = Variable[str | None](None)
        self.renewals = deque(renewals)
        """What `refresh` answers, in order; nothing once it is spent."""
        self.renewed = 0
        self.validations = deque(validations)
        """What the gateway says of a token, in order; Alice once it is spent."""
        self.validated: list[str] = []
        self.told: list[SessionEndReason] = []
        self.errors: list[SessionError] = []

    async def refresh(self) -> str | None:
        self.renewed += 1
        answer = self.renewals.popleft() if self.renewals else None
        if isinstance(answer, SignInError):
            raise answer
        return answer

    async def validate(self, asked: str) -> UserResponse:
        self.validated.append(asked)
        answer = self.validations.popleft() if self.validations else alice()
        if isinstance(answer, SemiontError):
            raise answer
        return answer

    def session(self, *, refresh: Refresh | None, validate: Validate | None) -> SemiontSession[Scripted]:
        return SemiontSession(
            kb_id=KB,
            client=SemiontClient(Scripted((), "open"), RecordingContent(), RecordingGateway()),
            token=self.token,
            kept=self.kept,
            refresh=refresh,
            validate=validate,
            on_auth_failed=self.told.append,
            on_error=self.errors.append,
        )

    def its_session(self) -> SemiontSession[Scripted]:
        """A session that renews and asks as the world scripts."""
        return self.session(refresh=self.refresh, validate=self.validate)

    async def is_kept(self) -> bool:
        return await self.kept.held() is not None

    def said(self) -> list[tuple[str, str]]:
        return [(error.code, error.message) for error in self.errors]


def why(row: JsonObject) -> str:
    return text(row["why"], "why")


def count(row: JsonObject, name: str) -> int:
    value = row[name]
    assert isinstance(value, int), f"{name} is not a count"
    return value


def answer(row: JsonObject, who: str, n: int) -> str:
    """The `n`th answer of a script whose last answer repeats."""
    script = strings(row[who], who)
    return script[min(n, len(script) - 1)]


def gateway_says(row: JsonObject, n: int) -> Validation:
    match answer(row, "gateway", n):
        case "accepts":
            return alice()
        case "refuses":
            return unauthorized()
        case "unreachable":
            return TransportError.of_status("HTTP 503", 503, None)
        case other:
            raise AssertionError(f"the gateway {other}")


def issuer_says(row: JsonObject, n: int, renewed: str) -> Renewal:
    match answer(row, "issuer", n):
        case "renews":
            return renewed
        case "refuses":
            return None
        case other:
            raise AssertionError(f"the issuer {other}")


# The script's last answer repeats, so a session that asks without end is
# stopped by one answer more than the case allows: of the gateway, an answer
# that is no refusal; of the issuer, none.
def one_too_many() -> TransportError:
    return TransportError.of_status("asked more than the case allows", 500, None)


def ends(session: SemiontSession[Scripted]) -> str:
    if session.token.value is None:
        return "signed-out"
    return "unconfirmed" if session.user.value is None else "signed-in"


async def is_as_stated(row: JsonObject, world: World, session: SemiontSession[Scripted], asked_before: int) -> None:
    """The session ended as the row states, and one that ended signed out asks nobody anything afterwards, however long it is held."""
    asks, renewals = count(row, "asks"), count(row, "renewals")
    assert (len(world.validated) - asked_before, world.renewed) == (asks, renewals), "how often the gateway and the issuer were asked"
    assert ends(session) == row["ends"]
    assert world.told == ([] if row["told"] is None else [row["told"]]), "why the session ended"
    assert [error.code for error in world.errors] == ([] if row["error"] is None else [row["error"]]), "the error reported"
    assert await world.is_kept() == row["kept"], "whether a sign-in is still kept"
    if ends(session) == "signed-out":
        await pass_time(2 * 60 * 60, step=60)
        assert (len(world.validated) - asked_before, world.renewed) == (asks, renewals), "what was asked once the session was over"


@pytest.mark.parametrize("row", STARTUP, ids=why)
def test_a_session_starts_as_the_table_states(row: JsonObject) -> None:
    asks, renewals = count(row, "asks"), count(row, "renewals")
    kept = {"none": None, "unexpired": token(3600, 0), "expired": expired()}[text(row["stored"], "stored")]
    world = World(
        kept=kept,
        renewals=[issuer_says(row, n, token(3600, n + 1)) for n in range(renewals)],
        validations=[*(gateway_says(row, n) for n in range(asks)), one_too_many()],
    )

    async def scenario() -> None:
        async with world.its_session() as session:
            await soon(session.ready())
            await is_as_stated(row, world, session, 0)

    run(scenario())


@pytest.mark.parametrize("row", REFUSAL, ids=why)
def test_a_refused_session_renews_and_asks_as_the_table_states(row: JsonObject) -> None:
    asks, renewals = count(row, "asks"), count(row, "renewals")
    # The session starts signed in: the gateway accepts the kept token. Then the row's answers.
    world = World(
        kept=token(3600, 0),
        renewals=[issuer_says(row, n, token(3600, 1)) for n in range(renewals)],
        validations=[alice(), *(gateway_says(row, n) for n in range(asks)), one_too_many()],
    )

    async def scenario() -> None:
        async with world.its_session() as session:
            await soon(session.ready())
            assert ends(session) == "signed-in"
            given = await soon(session.refresh())
            assert (given is not None) == row["given"], "whether `refresh` gives a token"
            if given is not None:
                assert given == session.token.value
            await is_as_stated(row, world, session, 1)

    run(scenario())


def test_the_table_was_read() -> None:
    assert len(STARTUP) >= 10
    assert len(REFUSAL) >= 4


# ── At its start ────────────────────────────────────────────────────────


def test_a_kept_token_that_is_still_good_is_the_sessions_at_once_and_says_who_it_is() -> None:
    access = token(3600, 1)
    world = World(kept=access)

    async def scenario() -> None:
        async with world.its_session() as session:
            # Before anything has run: it is what the transport sends first.
            assert session.token.value == access
            await soon(session.ready())
            assert world.validated == [access]
            assert session.user.value == alice()
            assert world.renewed == 0
            expiry = session.expires_at()
            assert expiry is not None
            assert expiry > time.time() + 3500

    run(scenario())


def test_a_kept_token_that_names_no_expiry_is_renewed_before_anyone_is_asked() -> None:
    # Nothing says it is still good.
    renewed = token(3600, 2)
    world = World(kept=jwt({"sub": "alice"}), renewals=[renewed])

    async def scenario() -> None:
        async with world.its_session() as session:
            assert session.token.value is None
            await soon(session.ready())
            assert world.validated == [renewed]
            assert session.token.value == renewed

    run(scenario())


def test_a_gateway_that_fails_in_some_other_way_has_refused_nothing_either() -> None:
    access, renewed = token(3600, 1), token(3600, 2)
    unanswered = BusRequestError("bus.timeout", "nobody answered")

    async def at_its_start() -> None:
        world = World(kept=access, validations=[unanswered])
        async with world.its_session() as session:
            await soon(session.ready())
            assert (session.token.value, session.user.value) == (access, None)
            assert world.said() == [("session.auth-failed", "nobody answered")]
            assert (world.told, world.renewed, await world.is_kept()) == ([], 0, True)

    async def when_refused() -> None:
        world = World(kept=access, renewals=[renewed], validations=[alice(), unanswered])
        async with world.its_session() as session:
            await soon(session.ready())
            assert await soon(session.refresh()) == renewed
            assert (world.told, world.errors, await world.is_kept()) == ([], [], True)

    run(at_its_start())
    run(when_refused())


def test_a_token_the_session_was_given_is_not_replaced_by_the_kept_one() -> None:
    world = World(kept=token(3600, 1))
    given = token(3600, 2)
    world.token.set(given)

    async def scenario() -> None:
        async with world.its_session() as session:
            await soon(session.ready())
            assert session.token.value == given

    run(scenario())


def test_a_session_of_a_service_asks_nobody_who_it_is() -> None:
    access = token(3600, 1)
    world = World(kept=access)

    async def scenario() -> None:
        async with world.session(refresh=world.refresh, validate=None) as session:
            await soon(session.ready())
            assert session.token.value == access
            assert session.user.value is None
            assert world.validated == []

    run(scenario())


def test_an_expired_token_that_cannot_be_renewed_is_forgotten_and_the_session_is_ready_anyway() -> None:
    async def scenario(renewal: Renewal) -> None:
        world = World(kept=expired(), renewals=[renewal])
        async with world.its_session() as session:
            await soon(session.ready())
            assert session.token.value is None
            assert session.user.value is None
            assert not await world.is_kept()
            # There was no session to end: nothing is said.
            assert (world.told, world.errors) == ([], [])

    run(scenario(None))
    run(scenario(SignInError("exchange", "the network is down")))


@final
class Slowly:
    """A gateway that holds its answer about one token until it is released, and then refuses it."""

    def __init__(self, held_token: str, of_others: Validation) -> None:
        self.held_token = held_token
        self.of_others = of_others
        self.asked: list[str] = []
        self.release = asyncio.Event()

    async def validate(self, asked: str) -> UserResponse:
        self.asked.append(asked)
        if asked == self.held_token:
            await self.release.wait()
            raise unauthorized()
        if isinstance(self.of_others, SemiontError):
            raise self.of_others
        return self.of_others


# The session's stream opens with the kept token as the session starts asking
# who that token is, so the stream's refusal can land first. While the session
# is starting, a refusal only renews: the start finds the renewed token and
# asks about it. One renewal, one ask about it, one ending.
def test_a_stream_refused_while_the_session_is_starting_costs_one_renewal_and_one_ending() -> None:
    access, renewed = token(3600, 1), token(3600, 2)
    world = World(kept=access, renewals=[renewed, token(3600, 3)])
    gateway = Slowly(access, unauthorized())

    async def scenario() -> None:
        async with world.session(refresh=world.refresh, validate=gateway.validate) as session:
            await turns()
            # The stream's refusal arrives before the start has its answer.
            refreshing = asyncio.create_task(session.refresh())
            await turns()
            gateway.release.set()
            await soon(session.ready())

            assert await soon(refreshing) == renewed
            assert gateway.asked == [access, renewed]
            assert world.renewed == 1
            assert world.told == ["refused"]
            assert [error.code for error in world.errors] == ["session.credential-refused"]
            assert session.token.value is None

    run(scenario())


def test_a_token_renewed_while_the_session_is_starting_is_taken_up_and_not_renewed_again() -> None:
    access, renewed = token(3600, 1), token(3600, 2)
    world = World(kept=access, renewals=[renewed, token(3600, 3)])
    gateway = Slowly(access, alice())

    async def scenario() -> None:
        async with world.session(refresh=world.refresh, validate=gateway.validate) as session:
            await turns()
            refreshing = asyncio.create_task(session.refresh())
            await turns()
            gateway.release.set()
            await soon(session.ready())

            assert await soon(refreshing) == renewed
            assert gateway.asked == [access, renewed]
            assert world.renewed == 1
            assert session.token.value == renewed
            assert session.user.value == alice()
            assert (world.told, world.errors) == ([], [])

    run(scenario())


# ── When the gateway refuses its token ──────────────────────────────────


def test_refusals_that_arrive_together_cost_one_renewal_and_one_ask() -> None:
    access, renewed = token(3600, 1), token(3600, 2)
    world = World(kept=access)
    renewals = 0

    # An issuer that takes a moment, as one does: the refusals overlap.
    async def refresh() -> str | None:
        nonlocal renewals
        renewals += 1
        await asyncio.sleep(0.01)
        return renewed

    async def scenario() -> None:
        async with world.session(refresh=refresh, validate=world.validate) as session:
            await soon(session.ready())
            # Three requests refused at once: each asks the session to refresh.
            given = await soon(asyncio.gather(session.refresh(), session.refresh(), session.refresh()))
            assert list(given) == [renewed, renewed, renewed]
            assert renewals == 1
            assert world.validated == [access, renewed]
            # A refusal after that is a new one.
            await soon(session.refresh())
            assert renewals == 2

    run(scenario())


def test_a_session_is_not_ended_by_the_refusal_of_a_token_it_no_longer_holds() -> None:
    access, renewed, other = token(3600, 1), token(3600, 2), token(3600, 9)
    world = World(kept=access, renewals=[renewed])
    # The gateway holds its answer about the renewed token until released.
    gateway = Slowly(renewed, alice())

    async def scenario() -> None:
        async with world.session(refresh=world.refresh, validate=gateway.validate) as session:
            await soon(session.ready())
            refreshing = asyncio.create_task(session.refresh())
            await turns()
            # The token is replaced while the gateway is being asked.
            world.token.set(other)
            gateway.release.set()

            assert await soon(refreshing) == other
            assert session.token.value == other
            assert world.told == []

    run(scenario())


def test_refresh_gives_the_new_token_and_makes_it_the_sessions() -> None:
    renewed = token(3600, 2)
    world = World(kept=token(3600, 1), renewals=[renewed])

    async def scenario() -> None:
        async with world.its_session() as session:
            await soon(session.ready())
            assert await soon(session.refresh()) == renewed
            assert session.token.value == renewed
            assert world.told == []

    run(scenario())


# ── How it is renewed ───────────────────────────────────────────────────


def test_an_idle_session_renews_its_token_once_per_half_life_and_no_oftener() -> None:
    # A five-minute token, and every renewal gives another: a margin of five
    # minutes would make each one due the moment it was issued.
    world = World(kept=token(300, 0), renewals=[token(300, n) for n in range(1, 100)])

    async def scenario() -> None:
        async with world.its_session() as session:
            await soon(session.ready())
            # Half its life is 150 seconds, less whatever of a second had passed when it was issued.
            await pass_time(140)
            assert world.renewed == 0
            await pass_time(12)
            assert world.renewed == 1
            # Each token after it is issued as the clock is moved, and the
            # clock a token's claims are read against is not the one moved: so
            # each is due 150 seconds after the one before.
            await pass_time(600)
            assert world.renewed == 5
            # A renewal on the session's own schedule follows no refusal: the
            # gateway was asked who the token is when the session started, and
            # not since.
            assert len(world.validated) == 1

    run(scenario())


def test_a_session_that_cannot_be_renewed_is_over_and_says_so_once() -> None:
    world = World(kept=token(3600, 1))

    async def scenario() -> None:
        async with world.its_session() as session:
            await soon(session.ready())
            assert await soon(session.refresh()) is None
            assert session.token.value is None
            # The dead credential is not kept to be used again.
            assert not await world.is_kept()
            assert world.told == ["expired"]
            assert world.said() == [("session.refresh-exhausted", "Token refresh failed")]
            # What follows finds nothing kept, and is quiet.
            assert await soon(session.refresh()) is None
            assert (len(world.told), len(world.errors)) == (1, 1)

    run(scenario())


def test_a_renewal_that_failed_ends_the_session_as_a_refusal_does_and_names_its_cause() -> None:
    world = World(kept=token(3600, 1), renewals=[SignInError("exchange", "the network is down")])

    async def scenario() -> None:
        async with world.its_session() as session:
            await soon(session.ready())
            assert await soon(session.refresh()) is None
            assert not await world.is_kept()
            assert world.told == ["expired"]
            assert world.said() == [("session.refresh-exhausted", "Token refresh failed: the network is down")]

    run(scenario())


def test_a_session_that_never_signed_in_cannot_expire() -> None:
    world = World()

    async def scenario() -> None:
        async with world.its_session() as session:
            await soon(session.ready())
            assert await soon(session.refresh()) is None
            assert world.renewed == 1
            assert (world.told, world.errors) == ([], [])

    run(scenario())


def test_a_session_given_no_way_to_renew_asks_nothing_and_ends_nothing() -> None:
    access = token(3600, 1)
    world = World(kept=access)

    async def scenario() -> None:
        async with world.session(refresh=None, validate=world.validate) as session:
            await soon(session.ready())
            assert await soon(session.refresh()) is None
            assert session.token.value == access
            assert await world.is_kept()

    run(scenario())


# ── How it ends ─────────────────────────────────────────────────────────


def test_closing_a_session_ends_what_it_holds() -> None:
    world = World(kept=token(300, 1), renewals=[token(300, 2)])

    async def scenario() -> None:
        session = world.its_session()
        async with session:
            await soon(session.ready())
        await session.close()

        # Its token and who is signed in change no more: whoever reads them is told so.
        async def tokens() -> list[str | None]:
            return [value async for value in session.token]

        async def users() -> list[UserResponse | None]:
            return [value async for value in session.user]

        assert await soon(tokens()) == [session.token.value]
        assert await soon(users()) == [session.user.value]
        # Nothing it had scheduled runs, and nothing it is told does anything.
        await pass_time(600)
        assert world.renewed == 0
        assert await soon(session.refresh()) is None
        assert world.renewed == 0
        await soon(session.ready())
        with pytest.raises(RuntimeError, match="started once"):
            await session.__aenter__()

    run(scenario())


def test_a_session_closed_while_it_starts_is_ready_and_says_nothing() -> None:
    access = token(3600, 1)
    world = World(kept=access)
    gateway = Slowly(access, alice())

    async def scenario() -> None:
        async with world.session(refresh=world.refresh, validate=gateway.validate) as session:
            await turns()
            assert gateway.asked == [access]
        await soon(session.ready())
        assert (world.renewed, world.told, world.errors) == (0, [], [])

    run(scenario())
