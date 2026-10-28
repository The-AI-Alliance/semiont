"""What refers to a resource: the reply to `gather:referenced-by-requested`.

The rule is `docs/protocol/LIBRARIAN.md`'s (§ What refers to a resource).
The graph and the record are the rig's fakes: each answers what a test
states and keeps what it was asked. Its reply names no person, so no one is
asked after for it.
"""

import logging

import pytest
from aio import run
from pydantic import ValidationError
from rig import FakeGraph, FakeRecord, described, link, reference, view
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import GatherReferencedByRequest, GatherReferencedByResult, ResourceView
from spec import JsonObject

from semiont_librarian.annotation_gather import Ungathered
from semiont_librarian.referenced_by import answer

CITED = ResourceId("res-cited")
"""The resource a request asks about."""
R1 = ResourceId("res-a")
R2 = ResourceId("res-b")
"""Two resources with annotations that refer to it."""


@pytest.fixture
def graph() -> FakeGraph:
    """A graph that holds the two citing resources, and is told of no annotation yet."""
    held = FakeGraph()
    held.resources[R1] = described(R1, name="Black Hawk")
    held.resources[R2] = described(R2, name="Keokuk")
    return held


def reply_to(request: GatherReferencedByRequest, graph: FakeGraph, *held: ResourceView) -> GatherReferencedByResult:
    """The reply to a request, answered from the graph, and from a record that holds the cited resource and these."""
    return run(answer(request, graph=graph, record=FakeRecord(view(described(CITED)), *held)))


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
    record = FakeRecord(view(described(CITED)))
    run(answer(GatherReferencedByRequest(resource_id=CITED), graph=graph, record=record))
    assert sorted(graph.asked_of("get_resource"), key=str) == [R1, R2]
    # The graph holds both, so the record is asked of nothing but the cited resource.
    assert record.asked == [CITED]


def test_a_resource_nobody_made_fails_the_request_and_the_graph_is_not_asked(graph: FakeGraph) -> None:
    graph.referenced_by[CITED] = [reference("ann-1", R1, link(CITED))]
    with pytest.raises(Ungathered, match=r"^Resource not found$"):
        run(answer(GatherReferencedByRequest(resource_id=CITED), graph=graph, record=FakeRecord()))
    assert graph.asked == []


def test_the_graph_is_asked_for_every_annotation_where_the_request_names_no_motivation(graph: FakeGraph) -> None:
    reply_to(GatherReferencedByRequest(resource_id=CITED), graph)
    assert graph.asked_of("get_resource_referenced_by") == [(CITED, None)]


def test_the_graph_is_asked_for_the_annotations_of_the_motivation_the_request_names(graph: FakeGraph) -> None:
    reply_to(GatherReferencedByRequest(resource_id=CITED, motivation="linking"), graph)
    assert graph.asked_of("get_resource_referenced_by") == [(CITED, "linking")]


@pytest.mark.parametrize("motivation", ["no such motivation", ""], ids=["a word that is none", "the empty text"])
def test_a_motivation_no_annotation_can_have_is_no_request_the_channel_carries(motivation: str) -> None:
    with pytest.raises(ValidationError):
        GatherReferencedByRequest.model_validate({"resourceId": CITED, "motivation": motivation})


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
    # No name is made up for it: the entry states none.
    assert entries(reply) == [{"id": "ann-1", "target": {"source": R1, "selector": {"exact": "some words"}}}]
    (said,) = lines(caplog, logging.WARNING)
    assert said["resourceId"] == R1
    assert lines(caplog, logging.INFO) == []


def test_a_graph_that_fails_to_answer_fails_the_request_and_nothing_else_is_read(graph: FakeGraph) -> None:
    graph.failing["get_resource_referenced_by"] = RuntimeError("the graph is away")
    with pytest.raises(RuntimeError, match=r"the graph is away"):
        reply_to(GatherReferencedByRequest(resource_id=CITED), graph)
    assert graph.asked_of("get_resource") == []


def test_a_view_that_cannot_be_read_leaves_its_resource_unnamed_and_the_request_is_answered(
    graph: FakeGraph, caplog: pytest.LogCaptureFixture
) -> None:
    graph.resources[R1] = None
    graph.referenced_by[CITED] = [reference("ann-1", R1, link(CITED)), reference("ann-2", R2, link(CITED))]
    record = FakeRecord(view(described(CITED)), view(described(R1, name="As the view holds it")))
    record.unread.add(R1)
    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        reply = run(answer(GatherReferencedByRequest(resource_id=CITED), graph=graph, record=record))
    assert [entry.resource_name for entry in reply.response.referenced_by] == [None, "Keokuk"]
    # One warning says the view could not be read, and one that nobody holds the resource.
    assert [said["resourceId"] for said in lines(caplog, logging.WARNING)] == [R1, R1]


def test_what_is_looked_for_is_logged_for_whoever_reads_the_log_closely(graph: FakeGraph, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG, logger="semiont_librarian"):
        reply_to(GatherReferencedByRequest(resource_id=CITED), graph)
        reply_to(GatherReferencedByRequest(resource_id=CITED, motivation="linking"), graph)
    looked_for = [line for line in lines(caplog, logging.DEBUG) if line["msg"] == "Looking for annotations referencing resource"]
    assert [(line["resourceId"], line["motivation"]) for line in looked_for] == [(CITED, "all"), (CITED, "linking")]
