"""The session's signals: what their cases in `specs/src/client/state-units.json` cannot state.

Their behaviour is the table's, run by `tests/test_state_cases.py`. Here are the
axioms, and that a notice raised again is told again, which the table cannot
count.
"""

from collections.abc import AsyncIterable, Callable, Sequence
from typing import final, override

from aio import run, soon

from semiont.session_signals import KbIdentityConflict, PermissionDenied, SessionEnded, SessionSignals
from semiont.testing.axioms import AxiomSubject, Fresh, assert_state_unit_axioms


def test_a_second_occurrence_is_told_even_when_it_says_the_same() -> None:
    async def scenario() -> None:
        async with SessionSignals() as signals:
            ended, denied = aiter(signals.session_ended), aiter(signals.permission_denied)
            assert (await anext(ended), await anext(denied)) == (None, None)

            for _ in range(2):
                signals.notify_session_ended("expired")
                signals.notify_permission_denied(None)
                assert await soon(anext(ended)) == SessionEnded(reason="expired")
                assert await soon(anext(denied)) == PermissionDenied(detail=None)

    run(scenario())


@final
class Signals(AxiomSubject[SessionSignals]):
    """How the axioms reach the session's signals: three notices, raised and acknowledged."""

    @override
    def setup(self) -> Fresh[SessionSignals]:
        return Fresh(SessionSignals())

    @override
    def surfaces(self, unit: SessionSignals) -> Sequence[AsyncIterable[object]]:
        return (unit.session_ended, unit.permission_denied, unit.kb_identity_conflict)

    @override
    def invocations(self, unit: SessionSignals) -> Sequence[Callable[[], object]]:
        conflict = KbIdentityConflict(expected_did="did:web:kb.example.org", observed_did="did:web:other.example.org")
        return (
            lambda: unit.notify_session_ended("refused"),
            lambda: unit.notify_permission_denied("no"),
            lambda: unit.notify_kb_identity_conflict(conflict),
            unit.acknowledge_session_ended,
            unit.acknowledge_permission_denied,
            unit.acknowledge_kb_identity_conflict,
        )


def test_the_session_signals_keep_the_state_unit_axioms() -> None:
    assert_state_unit_axioms(Signals())
