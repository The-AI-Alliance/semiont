"""A service's knowledge base, confirmed: asked which it is, asked again while nobody answers, refused where it is another or fails."""

import asyncio
import re
from collections.abc import Mapping
from typing import Final, final

import pytest
from aio import pass_time, run, under_way
from pydantic import JsonValue
from semiont.bus import Bus
from semiont.testing import FaultyTransport

from semiont_service.config import Refused
from semiont_service.knowledge_base import CONFIRMING_CHANNELS, Unanswered, confirmed

_OPERATION: Final = "browse:kb-requested"

NAMED: Final = "example.github.io:plain-kb"
"""The domain of the knowledge base a service's document names."""


@final
class Archivist:
    """What answers which knowledge base it is: as `domain`, and nothing while it is `away`."""

    def __init__(self, domain: str) -> None:
        self.domain = domain
        self.away = False
        self.failing: Mapping[str, JsonValue] | None = None
        """The failure it answers with, when it answers with one that is not its being away."""
        self.asked = 0
        self.transport: Final = FaultyTransport(make_response=self._answer)
        self.transport.refuse_when(self._refuse)
        self.bus: Final = Bus(self.transport)

    def _refuse(self, operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        assert operation == _OPERATION
        self.asked += 1
        if self.away:
            return {"code": "peer-unavailable", "message": "nothing answers"}
        return self.failing

    def _answer(self, operation: str, payload: Mapping[str, JsonValue]) -> JsonValue:
        assert operation == _OPERATION
        assert payload == {}
        return {"name": "Whatever it is called", "domain": self.domain}


def test_the_stream_a_service_confirms_on_names_the_answer_and_nothing_it_answers() -> None:
    assert CONFIRMING_CHANNELS == ("browse:kb-result", "browse:kb-failed")


def test_a_knowledge_base_that_answers_as_the_one_the_document_names_is_confirmed_once_asked() -> None:
    async def scenario() -> None:
        archivist = Archivist(NAMED)
        assert await confirmed(archivist.bus, NAMED, asyncio.Event())
        assert archivist.asked == 1
        await archivist.transport.close()

    run(scenario())


def test_a_knowledge_base_that_answers_as_another_is_refused_naming_both() -> None:
    async def scenario() -> None:
        archivist = Archivist("example.github.io:other-kb")
        with pytest.raises(Refused) as refused:
            await confirmed(archivist.bus, NAMED, asyncio.Event())
        assert type(refused.value) is Refused
        assert str(refused.value) == (
            "The knowledge base at the gateway is did:web:example.github.io:other-kb,"
            " and the document names did:web:example.github.io:plain-kb"
        )
        await archivist.transport.close()

    run(scenario())


def test_a_knowledge_base_nobody_answers_for_yet_is_asked_again_until_it_answers() -> None:
    async def scenario() -> None:
        archivist = Archivist(NAMED)
        archivist.away = True
        confirming = await under_way(confirmed(archivist.bus, NAMED, asyncio.Event()))
        # The second wait is at most two seconds: by then it has been asked three times.
        await pass_time(3, step=0.5)
        assert not confirming.done()
        assert archivist.asked == 3

        archivist.away = False
        await pass_time(4, step=0.5)
        assert await confirming
        assert archivist.asked == 4
        await archivist.transport.close()

    run(scenario())


def test_a_knowledge_base_that_answers_with_a_failure_is_refused_once_asked_saying_why() -> None:
    async def scenario() -> None:
        archivist = Archivist(NAMED)
        archivist.failing = {"message": "It commits no .semiont/config.yaml"}
        with pytest.raises(Refused) as refused:
            await confirmed(archivist.bus, NAMED, asyncio.Event())
        assert type(refused.value) is Refused
        assert str(refused.value) == (
            "The knowledge base answered which it is with a failure (browse:kb-failed): It commits no .semiont/config.yaml"
        )
        assert archivist.asked == 1
        await archivist.transport.close()

    run(scenario())


def test_a_knowledge_base_nobody_answers_for_however_long_it_is_asked_again_is_unanswered() -> None:
    async def scenario() -> None:
        archivist = Archivist(NAMED)
        archivist.away = True
        confirming = await under_way(confirmed(archivist.bus, NAMED, asyncio.Event()))
        # Seventeen askings, the waits between them doubling from a second to half a minute: about five and a half minutes.
        await pass_time(400, step=5)
        with pytest.raises(Unanswered, match=r"^The knowledge base did not answer which it is \(browse:kb-requested\): nothing answers$"):
            await confirming
        assert archivist.asked == 17
        await archivist.transport.close()

    run(scenario())


def test_a_knowledge_base_that_does_not_answer_within_the_request_s_deadline_is_unanswered_once_it_has_passed() -> None:
    async def scenario() -> None:
        archivist = Archivist(NAMED)
        # A stream that never opens: the question waits out its deadline, and is not asked again.
        archivist.transport.set_state("reconnecting")
        confirming = await under_way(confirmed(archivist.bus, NAMED, asyncio.Event()))
        await pass_time(29, step=1)
        assert not confirming.done()
        await pass_time(2, step=1)
        said = (
            "The knowledge base did not answer which it is (browse:kb-requested): Bus request timed out after 30000ms on browse:kb-result"
        )
        with pytest.raises(Unanswered, match=rf"^{re.escape(said)}$"):
            await confirming
        await archivist.transport.close()

    run(scenario())


def test_once_the_service_is_stopping_a_knowledge_base_nobody_answers_for_is_not_asked_again_and_nothing_is_refused() -> None:
    async def scenario() -> None:
        archivist = Archivist(NAMED)
        archivist.away = True
        stopping = asyncio.Event()
        confirming = await under_way(confirmed(archivist.bus, NAMED, stopping))
        assert archivist.asked == 1

        stopping.set()
        await pass_time(1, step=0.5)
        assert await confirming is False
        assert archivist.asked == 1
        await archivist.transport.close()

    run(scenario())
