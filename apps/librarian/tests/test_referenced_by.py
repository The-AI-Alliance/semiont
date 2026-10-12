"""What refers to a resource: the reply to `gather:referenced-by-requested`.

The rule is `docs/protocol/LIBRARIAN.md`'s (§ What refers to a resource).
The graph, the views and the people projection are the rig's fakes: each
answers what a test states and keeps what it was asked.
"""

import logging

import pytest
from aio import run
from rig import ADA, RECORDED, FakeGraph, FakePeople, FakeViews, described, link, reference, view
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import GatherReferencedByRequest, GatherReferencedByResult, PeopleProjectionPeopleValue, ResourceView
from spec import JsonObject, text

from semiont_librarian.reads import PeopleUnread
from semiont_librarian.referenced_by import answer

CITED = ResourceId("res-cited")
"""The resource a request asks about."""
R1 = ResourceId("res-a")
R2 = ResourceId("res-b")
"""Two resources with annotations that refer to it."""

ADA_ID = text(ADA["@id"], "Ada's id")
LOVELACE = {ADA_ID: PeopleProjectionPeopleValue(name="Ada Lovelace", since=RECORDED)}


@pytest.fixture
def graph() -> FakeGraph:
    """A graph that holds the two citing resources, and is told of no annotation yet."""
    held = FakeGraph()
    held.resources[R1] = described(R1, name="Black Hawk")
    held.resources[R2] = described(R2, name="Keokuk")
    return held


def reply_to(
    request: GatherReferencedByRequest, graph: FakeGraph, *views: ResourceView, people: FakePeople | None = None
) -> GatherReferencedByResult:
    """The reply to a request, answered from the graph, these views, and a projection in which Ada has a profile."""
    return run(answer(request, graph=graph, views=FakeViews(*views), people=FakePeople(LOVELACE) if people is None else people))


def entries(reply: GatherReferencedByResult) -> list[JsonObject]:
    """A reply's entries, as the wire carries them."""
    return [written(entry) for entry in reply.response.referenced_by]


def lines(caplog: pytest.LogCaptureFixture, level: int) -> list[dict[str, object]]:
    """What the Librarian logged at one level, each line with its facts."""
    return [dict(vars(record)) for record in caplog.records if record.name == "semiont_librarian" and record.levelno == level]


def test_the_answer_has_one_entry_for_each_annotation_in_the_graph_s_order(graph: FakeGraph) -> None:
    graph.referenced_by[CITED] = [
        reference("ann-2", R2, link(CITED)),
        reference("ann-1", R1, link(CITED)),
        reference("ann-3", R2, link(CITED)),
    ]
    reply = reply_to(GatherReferencedByRequest(resource_id=CITED), graph)
    assert entries(reply) == [
        {"id": "ann-2", "resourceName": "Keokuk", "target": {"source": R2, "selector": {"exact": "some words"}}},
        {"id": "ann-1", "resourceName": "Black Hawk", "target": {"source": R1, "selector": {"exact": "some words"}}},
        {"id": "ann-3", "resourceName": "Keokuk", "target": {"source": R2, "selector": {"exact": "some words"}}},
    ]


def test_each_resource_the_annotations_are_on_is_read_once(graph: FakeGraph) -> None:
    graph.referenced_by[CITED] = [
        reference("ann-2", R2, link(CITED)),
        reference("ann-1", R1, link(CITED)),
        reference("ann-3", R2, link(CITED)),
    ]
    views = FakeViews()
    run(answer(GatherReferencedByRequest(resource_id=CITED), graph=graph, views=views, people=FakePeople()))
    assert sorted(graph.asked_of("get_resource"), key=str) == [R1, R2]
    # The graph holds both, so no view is read.
    assert views.asked == []


def test_the_graph_is_asked_for_every_annotation_where_the_request_names_no_motivation_or_an_empty_one(graph: FakeGraph) -> None:
    reply_to(GatherReferencedByRequest(resource_id=CITED), graph)
    reply_to(GatherReferencedByRequest(resource_id=CITED, motivation=""), graph)
    assert graph.asked_of("get_resource_referenced_by") == [(CITED, None), (CITED, None)]


def test_the_graph_is_asked_for_the_annotations_of_the_motivation_the_request_names(graph: FakeGraph) -> None:
    reply_to(GatherReferencedByRequest(resource_id=CITED, motivation="linking"), graph)
    assert graph.asked_of("get_resource_referenced_by") == [(CITED, "linking")]


def test_a_motivation_no_annotation_can_have_is_answered_with_no_entry_and_the_graph_is_not_asked(graph: FakeGraph) -> None:
    graph.referenced_by[CITED] = [reference("ann-1", R1, link(CITED))]
    reply = reply_to(GatherReferencedByRequest(resource_id=CITED, motivation="no such motivation"), graph)
    assert entries(reply) == []
    assert graph.asked == []


def test_the_words_are_those_of_the_quote_selector_and_the_empty_string_where_the_target_has_none(graph: FakeGraph) -> None:
    quoted: JsonObject = {
        "source": R1,
        "selector": [
            {"type": "TextPositionSelector", "start": 4, "end": 9},
            {"type": "TextQuoteSelector", "exact": "quick", "prefix": "The ", "suffix": " brown"},
        ],
    }
    at_a_position: JsonObject = {"source": R1, "selector": {"type": "TextPositionSelector", "start": 4, "end": 9}}
    graph.referenced_by[CITED] = [
        reference("ann-1", R1, link(CITED), target=quoted),
        reference("ann-2", R1, link(CITED), target=at_a_position),
        reference("ann-3", R1, link(CITED), target={"source": R1}),
        reference("ann-4", R1, link(CITED), target=R1),
    ]
    reply = reply_to(GatherReferencedByRequest(resource_id=CITED), graph)
    assert [(entry.id, entry.target.source, entry.target.selector.exact) for entry in reply.response.referenced_by] == [
        ("ann-1", R1, "quick"),
        ("ann-2", R1, ""),
        ("ann-3", R1, ""),
        ("ann-4", R1, ""),
    ]


def test_a_resource_the_graph_does_not_hold_is_named_by_its_view_and_that_is_logged(
    graph: FakeGraph, caplog: pytest.LogCaptureFixture
) -> None:
    graph.resources[R1] = None
    graph.referenced_by[CITED] = [reference("ann-1", R1, link(CITED)), reference("ann-2", R2, link(CITED))]
    with caplog.at_level(logging.INFO, logger="semiont_librarian"):
        reply = reply_to(GatherReferencedByRequest(resource_id=CITED), graph, view(described(R1, name="As the view holds it")))
    assert [entry.resource_name for entry in reply.response.referenced_by] == ["As the view holds it", "Keokuk"]
    (said,) = lines(caplog, logging.INFO)
    assert said["resourceId"] == R1
    assert lines(caplog, logging.WARNING) == []


def test_a_graph_that_fails_to_read_a_resource_is_read_past_and_its_view_names_it(graph: FakeGraph) -> None:
    graph.failing["get_resource"] = RuntimeError("the graph is away")
    graph.referenced_by[CITED] = [reference("ann-1", R1, link(CITED))]
    reply = reply_to(GatherReferencedByRequest(resource_id=CITED), graph, view(described(R1, name="As the view holds it")))
    assert [entry.resource_name for entry in reply.response.referenced_by] == ["As the view holds it"]


def test_a_resource_nobody_holds_is_logged_as_a_warning_and_its_annotation_is_still_an_entry(
    graph: FakeGraph, caplog: pytest.LogCaptureFixture
) -> None:
    graph.resources[R1] = None
    graph.referenced_by[CITED] = [reference("ann-1", R1, link(CITED))]
    with caplog.at_level(logging.INFO, logger="semiont_librarian"):
        reply = reply_to(GatherReferencedByRequest(resource_id=CITED), graph)
    assert [(entry.id, entry.target.source) for entry in reply.response.referenced_by] == [("ann-1", R1)]
    (said,) = lines(caplog, logging.WARNING)
    assert said["resourceId"] == R1
    assert lines(caplog, logging.INFO) == []


def test_a_graph_that_fails_to_answer_fails_the_request_and_nothing_else_is_read(graph: FakeGraph) -> None:
    graph.failing["get_resource_referenced_by"] = RuntimeError("the graph is away")
    people = FakePeople(LOVELACE)
    with pytest.raises(RuntimeError, match=r"the graph is away"):
        reply_to(GatherReferencedByRequest(resource_id=CITED), graph, people=people)
    assert graph.asked_of("get_resource") == []
    assert people.reads == 0


def test_a_view_that_fails_fails_the_request(graph: FakeGraph) -> None:
    graph.resources[R1] = None
    graph.referenced_by[CITED] = [reference("ann-1", R1, link(CITED))]
    views = FakeViews()
    views.failing = RuntimeError("the state volume is away")
    with pytest.raises(RuntimeError, match=r"the state volume is away"):
        run(answer(GatherReferencedByRequest(resource_id=CITED), graph=graph, views=views, people=FakePeople()))


def test_the_projection_is_read_once_for_the_reply_and_a_reply_is_sent_where_it_cannot_be_read(
    graph: FakeGraph, caplog: pytest.LogCaptureFixture
) -> None:
    graph.referenced_by[CITED] = [reference("ann-1", R1, link(CITED)), reference("ann-2", R2, link(CITED))]
    people = FakePeople(LOVELACE)
    named = reply_to(GatherReferencedByRequest(resource_id=CITED), graph, people=people)
    assert people.reads == 1

    people.failing = PeopleUnread("people.json is not a people projection that can be read")
    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        unnamed = reply_to(GatherReferencedByRequest(resource_id=CITED), graph, people=people)
    assert entries(unnamed) == entries(named)
    assert people.reads == 2
    assert len(lines(caplog, logging.WARNING)) == 1


def test_what_is_looked_for_is_logged_for_whoever_reads_the_log_closely(graph: FakeGraph, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG, logger="semiont_librarian"):
        reply_to(GatherReferencedByRequest(resource_id=CITED), graph)
        reply_to(GatherReferencedByRequest(resource_id=CITED, motivation="linking"), graph)
    looked_for = [line for line in lines(caplog, logging.DEBUG) if line["msg"] == "Looking for annotations referencing resource"]
    assert [(line["resourceId"], line["motivation"]) for line in looked_for] == [(CITED, "all"), (CITED, "linking")]
