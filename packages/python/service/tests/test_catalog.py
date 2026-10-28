"""The catalog, read whole: a page at a time, and a page asked for again while the Archivist is not there."""

import asyncio
from collections.abc import Mapping
from typing import Final, final

import pytest
from aio import pass_time, run, under_way
from pydantic import JsonValue
from semiont.bus import Bus
from semiont.errors import BusRequestError
from semiont.testing import FaultyTransport

from semiont_service import catalog

_OPERATION: Final = "browse:resources-requested"


def described(resource: str) -> JsonValue:
    """A resource as the catalog answers it, with no more said of it than a description must."""
    return {"@context": "https://schema.org", "@id": resource, "name": f"Name of {resource}", "representations": []}


@final
class Archivist:
    """What answers for the catalog: `held` resources, a page at a time, and nothing while it is `away`."""

    def __init__(self, held: int) -> None:
        self.resources: Final[list[JsonValue]] = [described(f"res-{number}") for number in range(held)]
        self.away = False
        self.failing: Mapping[str, JsonValue] | None = None
        """The failure it answers every request with, when it answers with one that is not its being away."""
        self.asked: Final[list[Mapping[str, JsonValue]]] = []
        self.transport: Final = FaultyTransport(make_response=self._answer)
        self.transport.refuse_when(self._refuse)
        self.bus: Final = Bus(self.transport)

    def _refuse(self, operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        assert operation == _OPERATION
        self.asked.append(payload)
        if self.away:
            return {"code": "peer-unavailable", "message": "nothing answers"}
        return self.failing

    def _answer(self, operation: str, payload: Mapping[str, JsonValue]) -> JsonValue | None:
        assert operation == _OPERATION
        offset, limit = payload["offset"], payload["limit"]
        assert isinstance(offset, int)
        assert isinstance(limit, int)
        return {"resources": self.resources[offset : offset + limit], "total": len(self.resources), "offset": offset, "limit": limit}


def test_the_catalog_is_asked_for_two_hundred_at_a_time_until_every_resource_is_read() -> None:
    async def scenario() -> None:
        archivist = Archivist(held=450)
        read = await catalog.resources(archivist.bus, asyncio.Event(), archived=None)
        assert [resource.id for resource in read] == [f"res-{number}" for number in range(450)]
        assert [(asked["offset"], asked["limit"]) for asked in archivist.asked] == [(0, 200), (200, 200), (400, 200)]
        await archivist.transport.close()

    run(scenario())


def test_a_catalog_of_nothing_is_one_page_of_nothing() -> None:
    async def scenario() -> None:
        archivist = Archivist(held=0)
        assert await catalog.resources(archivist.bus, asyncio.Event(), archived=None) == []
        assert len(archivist.asked) == 1
        await archivist.transport.close()

    run(scenario())


def test_a_page_of_nothing_ends_the_read_whatever_total_the_archivist_states() -> None:
    async def scenario() -> None:
        # A total that no page ever reaches would otherwise be asked after for ever.
        def nothing_of_seven(operation: str, payload: Mapping[str, JsonValue]) -> JsonValue:
            return {"resources": [], "total": 7, "offset": 0, "limit": 200}

        transport = FaultyTransport(make_response=nothing_of_seven)
        assert await catalog.resources(Bus(transport), asyncio.Event(), archived=None) == []
        assert len(transport.request_log) == 1
        await transport.close()

    run(scenario())


@pytest.mark.parametrize(("archived", "stated"), [(False, {"archived": False}), (True, {"archived": True}), (None, {})])
def test_which_resources_are_asked_for_is_stated_in_each_request_and_nothing_is_stated_for_every_one(
    archived: bool | None, stated: Mapping[str, JsonValue]
) -> None:
    async def scenario() -> None:
        archivist = Archivist(held=201)
        await catalog.resources(archivist.bus, asyncio.Event(), archived=archived)
        assert archivist.asked == [{**stated, "offset": 0, "limit": 200}, {**stated, "offset": 200, "limit": 200}]
        await archivist.transport.close()

    run(scenario())


def test_a_page_nobody_answers_is_asked_for_again_and_the_pages_before_it_are_not() -> None:
    async def scenario() -> None:
        archivist = Archivist(held=250)
        archivist.away = True
        reading = await under_way(catalog.resources(archivist.bus, asyncio.Event(), archived=None))
        # The second wait is at most two seconds: by then the first page has been asked for three times.
        await pass_time(3, step=0.5)
        assert not reading.done()
        assert [asked["offset"] for asked in archivist.asked] == [0, 0, 0]

        archivist.away = False
        await pass_time(4, step=0.5)
        assert len(await reading) == 250
        assert [asked["offset"] for asked in archivist.asked] == [0, 0, 0, 0, 200]
        await archivist.transport.close()

    run(scenario())


def test_a_page_that_fails_another_way_is_not_asked_for_again() -> None:
    async def scenario() -> None:
        archivist = Archivist(held=3)
        archivist.failing = {"code": "internal", "message": "the view could not be read"}
        with pytest.raises(BusRequestError, match="the view could not be read"):
            await catalog.resources(archivist.bus, asyncio.Event(), archived=None)
        assert len(archivist.asked) == 1
        await archivist.transport.close()

    run(scenario())


def test_once_the_service_is_stopping_a_page_nobody_answers_is_not_asked_for_again() -> None:
    async def scenario() -> None:
        archivist = Archivist(held=3)
        archivist.away = True
        stopping = asyncio.Event()
        reading = await under_way(catalog.resources(archivist.bus, stopping, archived=None))
        assert len(archivist.asked) == 1

        stopping.set()
        with pytest.raises(BusRequestError) as refused:
            await reading
        assert refused.value.code == "bus.peer-unavailable"
        assert len(archivist.asked) == 1
        await archivist.transport.close()

    run(scenario())
