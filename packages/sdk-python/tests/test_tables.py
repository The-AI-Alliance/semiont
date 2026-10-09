"""The tables a client keeps to, as generated: each says what its table says."""

from typing import get_args

from spec import SPEC, objects, read, text

from semiont import error_codes, refresh, timing
from semiont.retry import RetryPolicy

CODES = read(SPEC / "errors/codes.json")


def stated(vocabulary: str) -> list[str]:
    """The codes a vocabulary of the error table lists."""
    table = CODES[vocabulary]
    assert isinstance(table, dict)
    return [text(entry["code"], "a code") for entry in objects(table["codes"], f"{vocabulary}'s codes")]


def test_each_vocabulary_is_its_table_s_codes_as_a_type_and_as_a_tuple() -> None:
    vocabularies = {
        "busRequest": (error_codes.BusRequestErrorCode, error_codes.BUS_REQUEST_ERROR_CODES),
        "transport": (error_codes.TransportErrorCode, error_codes.TRANSPORT_ERROR_CODES),
        "job": (error_codes.JobErrorCode, error_codes.JOB_ERROR_CODES),
        "session": (error_codes.SemiontSessionErrorCode, error_codes.SEMIONT_SESSION_ERROR_CODES),
        "signIn": (error_codes.SignInErrorCode, error_codes.SIGN_IN_ERROR_CODES),
        "kbIdentity": (error_codes.IdentityUnverifiableReason, error_codes.IDENTITY_UNVERIFIABLE_REASONS),
        "spanRefusal": (error_codes.SpanRefusal, error_codes.SPAN_REFUSALS),
    }
    assert set(vocabularies) == {name for name in CODES if name != "$comment"}
    for name, (union, listed) in vocabularies.items():
        assert list(get_args(union.__value__)) == stated(name)
        assert list(listed) == stated(name)


def test_a_wire_code_becomes_the_bus_code_that_restates_it() -> None:
    bus = CODES["busRequest"]
    assert isinstance(bus, dict)
    restated = {
        text(entry["wire"], "a wire code"): text(entry["code"], "a code") for entry in objects(bus["codes"], "codes") if "wire" in entry
    }
    assert dict(error_codes.BUS_REQUEST_CODE_BY_WIRE_CODE) == restated
    assert bus["unrecognizedFailure"] == error_codes.UNRECOGNIZED_FAILURE_CODE


def test_a_status_becomes_the_transport_code_the_table_gives_it() -> None:
    transport = CODES["transport"]
    assert isinstance(transport, dict)
    for entry in objects(transport["codes"], "codes"):
        code = text(entry["code"], "a code")
        status = entry.get("status")
        if isinstance(status, int):
            assert error_codes.transport_error_code_for_status(status) == code
        opens = entry.get("statusFrom")
        if isinstance(opens, int):
            assert error_codes.transport_error_code_for_status(opens) == code
            assert error_codes.transport_error_code_for_status(opens + 99) == code
    assert error_codes.transport_error_code_for_status(418) == transport["unclassified"]


def constant(name: str) -> str:
    """`emitRetry` → `EMIT_RETRY`."""
    return "".join(f"_{letter}" if letter.isupper() else letter for letter in name).upper()


def test_each_timing_entry_is_a_constant_of_its_value() -> None:
    entries = objects(read(SPEC / "client/timing.json")["timing"], "timing")
    assert [text(entry["name"], "a name") for entry in entries] == list(timing.TIMING_NAMES)
    for entry in entries:
        value = entry["value"]
        held = getattr(timing, constant(text(entry["name"], "a name")))
        if isinstance(value, dict):
            assert held == RetryPolicy(
                attempts=whole(value["attempts"]), initial_delay_ms=whole(value["initialDelayMs"]), max_delay_ms=whole(value["maxDelayMs"])
            )
        else:
            assert held == value


def whole(value: object) -> int:
    """`value`, which is a whole number."""
    assert isinstance(value, int)
    return value


def test_the_refresh_table_names_every_query_and_every_trigger() -> None:
    table = read(SPEC / "client/refresh.json")
    queries = [text(query["name"], "a query's name") for query in objects(table["queries"], "queries")]
    assert list(refresh.CACHE_QUERIES) == queries
    assert list(get_args(refresh.CacheQuery.__value__)) == queries

    rows = objects(table["refresh"], "refresh")
    triggers = list(dict.fromkeys(text(row["on"], "a trigger") for row in rows))
    assert list(refresh.CACHE_REFRESH) == triggers
    assert list(get_args(refresh.CacheRefreshTrigger.__value__)) == triggers
    assert sum(len(held) for held in refresh.CACHE_REFRESH.values()) == len(rows)
    by_trigger = {str(trigger): held for trigger, held in refresh.CACHE_REFRESH.items()}
    for row in rows:
        assert any(
            held.reach == row.get("reach", "subject")
            and held.when == row.get("when")
            and list(held.refetches) == row.get("refetches", [])
            and list(held.writes) == row.get("writes", [])
            and list(held.removes) == row.get("removes", [])
            for held in by_trigger[text(row["on"], "a trigger")]
        )
