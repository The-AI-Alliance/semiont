"""Trying again, held to the cases every SDK runs (`specs/src/retry/cases.json`).

The table states four rules. This SDK keeps the ones it has a use for, and the
rest are named below with what will bring each: a rule the table gains, or one
this SDK comes to keep, fails here until this file says so.
"""

import asyncio

import pytest
from aio import run
from spec import SPEC, JsonObject, objects, read, text

from semiont.errors import SemiontError, TransportError
from semiont.retry import BOOT, RETRY_RULES, RetryFacts, RetryPolicy, equal_jitter, retry_after_ms, retry_with_backoff

TABLE = read(SPEC / "retry/cases.json")
RULES = objects(TABLE["rules"], "rules")
STATED_WAITS = objects(TABLE["retryAfter"], "retryAfter")

# The rules of the table this SDK does not keep, each with what it waits for.
NOT_KEPT = {
    "job": "a job's retry budget is its worker's, which is not this SDK's",
}


def whole(row: JsonObject, name: str) -> int | None:
    value = row.get(name)
    assert value is None or (isinstance(value, int) and not isinstance(value, bool)), f"{name} is not a whole number"
    return value


def test_every_rule_of_the_table_is_kept_or_named_as_not_kept() -> None:
    stated = {text(row["rule"], "a rule") for row in RULES}
    assert set(RETRY_RULES) | set(NOT_KEPT) == stated
    assert set(RETRY_RULES) & set(NOT_KEPT) == set()
    assert all(why.strip() for why in NOT_KEPT.values())


@pytest.mark.parametrize("row", [row for row in RULES if row["rule"] in RETRY_RULES], ids=lambda row: f"{row['rule']}: {row['why']}")
def test_a_rule_answers_as_the_table_does(row: JsonObject) -> None:
    rule = RETRY_RULES[text(row["rule"], "a rule")]
    method = row.get("method")
    assert method is None or isinstance(method, str)
    assert rule.retryable(RetryFacts(status=whole(row, "status"), method=method)) is row["retries"], row["why"]


@pytest.mark.parametrize("row", STATED_WAITS, ids=lambda row: str(row["why"]))
def test_a_retry_after_header_states_the_wait_the_table_gives(row: JsonObject) -> None:
    header = row["header"]
    assert header is None or isinstance(header, str)
    assert retry_after_ms(header) == whole(row, "ms"), row["why"]


def test_jitter_stays_between_half_the_cap_and_the_cap() -> None:
    for _ in range(1000):
        assert 500 <= equal_jitter(1000) <= 1000


def refused(status: int, retry_after: int | None = None) -> TransportError:
    return TransportError.of_status(f"refused {status}", status, retry_after)


def worth_another(error: SemiontError) -> bool:
    return BOOT.retryable(RetryFacts(status=error.status))


def test_a_budget_is_spent_and_the_last_failure_raised() -> None:
    async def scenario() -> tuple[int, int | None]:
        made = 0

        async def attempt() -> None:
            nonlocal made
            made += 1
            raise refused(503)

        try:
            await retry_with_backoff(
                RetryPolicy(attempts=3, initial_delay_ms=1, max_delay_ms=2), attempt, retryable=worth_another, give_up=asyncio.Event()
            )
        except TransportError as error:
            return made, error.status
        return made, None

    assert run(scenario()) == (3, 503)


def test_a_failure_not_worth_another_attempt_is_raised_at_once_and_a_success_ends_the_attempts() -> None:
    async def scenario() -> tuple[int, str]:
        made = 0

        async def refused_outright() -> None:
            nonlocal made
            made += 1
            raise refused(409)

        async def third_time() -> str:
            nonlocal made
            made += 1
            if made < 4:
                raise refused(429)
            return "accepted"

        policy = RetryPolicy(attempts=5, initial_delay_ms=1, max_delay_ms=1)
        with pytest.raises(TransportError):
            await retry_with_backoff(policy, refused_outright, retryable=worth_another, give_up=asyncio.Event())
        answer = await retry_with_backoff(policy, third_time, retryable=worth_another, give_up=asyncio.Event())
        return made, answer

    assert run(scenario()) == (4, "accepted")


def test_the_wait_a_failure_states_is_a_floor_under_the_backoff() -> None:
    async def scenario() -> float:
        made = 0

        async def attempt() -> None:
            nonlocal made
            made += 1
            if made == 1:
                raise refused(429, retry_after=60)

        started = asyncio.get_running_loop().time()
        await retry_with_backoff(
            RetryPolicy(attempts=2, initial_delay_ms=1, max_delay_ms=1), attempt, retryable=worth_another, give_up=asyncio.Event()
        )
        return asyncio.get_running_loop().time() - started

    assert run(scenario()) >= 0.06


def test_giving_up_ends_a_wait_in_progress_with_the_failure_that_began_it() -> None:
    async def scenario() -> tuple[int, float]:
        made = 0
        give_up = asyncio.Event()

        async def attempt() -> None:
            nonlocal made
            made += 1
            raise refused(429, retry_after=60_000)

        started = asyncio.get_running_loop().time()
        retrying = asyncio.ensure_future(
            retry_with_backoff(
                RetryPolicy(attempts=5, initial_delay_ms=1, max_delay_ms=1), attempt, retryable=worth_another, give_up=give_up
            )
        )
        await asyncio.sleep(0.01)
        give_up.set()
        with pytest.raises(TransportError):
            await retrying
        return made, asyncio.get_running_loop().time() - started

    made, took = run(scenario())
    assert made == 1
    assert took < 5
