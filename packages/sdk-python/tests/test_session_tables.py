"""How a token is held, as every SDK must compute it (`specs/src/session/cases.json`).

`refreshSchedule`: how long to wait before renewing a token, from its own
claims. `tokenExpiry`: reading `exp` out of one. The session's own conduct,
`startup` and `refusal`, is `test_session.py`'s.
"""

import pytest
from spec import SPEC, JsonObject, objects, read, text
from tokens import jwt

from semiont.session import refresh_delay, token_expiry

TABLE = read(SPEC / "session/cases.json")
SCHEDULE = objects(TABLE["refreshSchedule"], "refreshSchedule")
EXPIRY = objects(TABLE["tokenExpiry"], "tokenExpiry")


def number(row: JsonObject, name: str) -> float | None:
    value = row.get(name)
    assert value is None or (isinstance(value, int | float) and not isinstance(value, bool)), f"{name} is not a number"
    return value


def why(row: JsonObject) -> str:
    return text(row["why"], "why")


@pytest.mark.parametrize("row", SCHEDULE, ids=why)
def test_a_token_is_renewed_when_the_table_says(row: JsonObject) -> None:
    token = text(row["token"], "token") if "token" in row else jwt(row["claims"])
    now = number(row, "now")
    assert now is not None
    assert refresh_delay(token, now=now) == number(row, "delay")


@pytest.mark.parametrize("row", EXPIRY, ids=why)
def test_a_token_expires_when_the_table_says(row: JsonObject) -> None:
    assert token_expiry(text(row["token"], "token")) == number(row, "exp")


def test_the_table_was_read() -> None:
    assert len(SCHEDULE) >= 12
    assert len(EXPIRY) >= 7
