"""A resource read by its id: from the graph, and from its view where the graph has none or its read fails.

The rule is `docs/protocol/LIBRARIAN.md`'s, of a reference search, a text
search and what refers to a resource: each reads a resource back from the
graph, and from the views when the graph has none or its read fails, and one
neither holds is left out. A view that cannot be read is one the resource is
not read from, and a warning says so. Nothing here waits.
"""

import logging
from typing import Final

import pytest
from aio import run
from rig import FakeGraph, FakeViews, described, view
from semiont.identifiers import ResourceId

from semiont_librarian.grace import Graced, resource_with_view_grace, view_if_readable

R1: Final = ResourceId("res-1")

FROM_GRAPH: Final = described(R1, name="From Graph")
FROM_VIEW: Final = described(R1, name="From View")


def test_a_resource_the_graph_holds_is_the_graph_s_and_its_view_is_not_read() -> None:
    async def scenario() -> None:
        graph, views = FakeGraph(), FakeViews(view(FROM_VIEW))
        graph.resources[R1] = FROM_GRAPH

        assert await resource_with_view_grace(graph, views, R1) == Graced(resource=FROM_GRAPH, lagged_behind_view=False)
        assert graph.asked_of("get_resource") == [R1]
        assert views.asked == []

    run(scenario())


def test_a_resource_the_graph_does_not_hold_yet_is_its_view_s_and_is_said_to_be_behind() -> None:
    async def scenario() -> None:
        graph, views = FakeGraph(), FakeViews(view(FROM_VIEW))
        graph.resources[R1] = None

        assert await resource_with_view_grace(graph, views, R1) == Graced(resource=FROM_VIEW, lagged_behind_view=True)
        assert graph.asked_of("get_resource") == [R1]
        assert views.asked == [R1]

    run(scenario())


def test_a_resource_neither_holds_is_none_and_is_not_said_to_be_behind() -> None:
    async def scenario() -> None:
        graph, views = FakeGraph(), FakeViews()
        graph.resources[R1] = None

        assert await resource_with_view_grace(graph, views, R1) == Graced(resource=None, lagged_behind_view=False)
        assert views.asked == [R1]

    run(scenario())


def test_a_graph_read_that_fails_is_a_graph_that_has_none() -> None:
    async def scenario() -> None:
        graph, views = FakeGraph(), FakeViews(view(FROM_VIEW))
        graph.resources[R1] = FROM_GRAPH
        graph.failing["get_resource"] = RuntimeError("the graph database did not answer")

        assert await resource_with_view_grace(graph, views, R1) == Graced(resource=FROM_VIEW, lagged_behind_view=True)

        # With no view either, the resource is one neither holds.
        assert await resource_with_view_grace(graph, FakeViews(), R1) == Graced(resource=None, lagged_behind_view=False)

    run(scenario())


def unread_views(caplog: pytest.LogCaptureFixture) -> list[tuple[object, object]]:
    """Each warning of a view that could not be read: the resource it names, and what it says failed."""
    return [
        (vars(record)["resourceId"], vars(record)["error"])
        for record in caplog.records
        if record.name == "semiont_librarian" and record.levelno == logging.WARNING and "view could not be read" in record.getMessage()
    ]


def test_a_view_that_cannot_be_read_is_a_resource_that_is_not_read_and_a_warning_names_it(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        graph, views = FakeGraph(), FakeViews(view(FROM_VIEW))
        graph.resources[R1] = None
        views.failing = OSError("the state volume is not there")

        assert await resource_with_view_grace(graph, views, R1) == Graced(resource=None, lagged_behind_view=False)

    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        run(scenario())

    assert unread_views(caplog) == [(R1, "the state volume is not there")]


def test_a_view_that_only_adds_to_an_answer_is_read_or_is_none_and_one_that_is_not_there_warns_of_nothing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        held = view(FROM_VIEW)
        assert await view_if_readable(FakeViews(held), R1) == held
        assert await view_if_readable(FakeViews(), R1) is None
        assert unread_views(caplog) == []

        unread = FakeViews(held)
        unread.unread.add(R1)
        assert await view_if_readable(unread, R1) is None

    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        run(scenario())

    assert unread_views(caplog) == [(R1, f"the view of {R1} cannot be read")]
