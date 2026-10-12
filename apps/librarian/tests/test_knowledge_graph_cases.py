"""The knowledge graph built for one resource, held to `specs/src/librarian/knowledge-graph-cases.json`.

It is the table every Librarian runs, so that what the graph store and the
views answer gives one graph, or one failure, in any language. A case is run
through `build_knowledge_graph`.

The graph store is a double of this file's own that answers what a case
states: each time it is asked for the resource it gives the next answer of
the case's list, and it fails when asked once more than the list is long.
Of a resource further out it answers what the case states under `further`,
and fails for one the case states nothing of. A case fails too where a
resource it states under `further` was not asked for what it links to and
for what cites it, once each. The views are the rig's. The applied signal is real: the wait is a
`WeaveProgress`, which is told of the signal before the build where a case
states that it has arrived, and is left to run out where a case does not.

Time is the loop's clock, which the runner moves. Before each move the build
is given its turns, so it is either done or waiting. Then the clock is moved
by the next wait the page states, and by no more. `waited` is how far the
clock was moved by the time the build was done, so a build that waits longer
or shorter than a case states is done after another move than the case's,
and fails. The moment a machine takes to run a turn is real and is not
counted. A machine that stalls for 25 milliseconds between two moves lets a
pause end early, and the case then fails on `waited`.

What is built is written as the wire carries it, without what was never
said, and compared whole with the case's graph: every node and every edge,
in order. A member of a case that has no place here fails.

After the table's cases comes what no case of it states: a wait that fails,
what is asked of the stores, what a graph that stays behind leaves in the
log and the count, a depth out of bounds, and the ceiling on a graph's
resources, over a graph that is made here because 200 resources written out
are more than a table's reader can check.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Final, Literal, final, override

import pytest
from aio import SteppedLoop, hurried, pass_time, run
from pydantic import JsonValue
from rig import FakeDegraded, FakeGraph, FakeViews, FakeWeave, described, view
from semiont.identifiers import ResourceId
from semiont.model import WireModel
from semiont.types import Annotation, GraphResourceNode, KnowledgeGraph, Motivation, ResourceDescriptor, ResourceView
from semiont_graph.interface import EntityTypeCount, GraphConnection, ResourceListing, ResourceQuery
from spec import SPEC, JsonObject, objects, read, text, thing, whole

from semiont_librarian.knowledge_graph import (
    GRAPH_WAIT_BUDGET,
    LARGEST_DEPTH,
    LEAST_DEPTH,
    RESOURCE_CEILING,
    DepthRefused,
    GraphBehind,
    ResourceUnknown,
    build_knowledge_graph,
)
from semiont_librarian.progress import WeaveProgress
from semiont_librarian.reads import GraphReads

type Failure = Literal["unknown", "behind"]

PLACES: Final = frozenset({"why", "resource", "depth", "graph", "views", "applied", "knowledgeGraph", "fails", "waited"})
"""The members a case may have."""

STORE_PLACES: Final = frozenset({"resource", "connections", "referencedBy", "annotations"})
"""The members what the graph store answers always has."""

FURTHER: Final = "further"
"""The member what the graph store answers has where a case states what it answers of resources further out."""

FURTHER_PLACES: Final = frozenset({"connections", "referencedBy"})
"""The members what the graph store answers of a resource further out has."""

CONNECTION_PLACES: Final = frozenset({"resource", "bidirectional"})
"""The members a connection may have."""

SIGNAL_WAIT: Final = 0.5
"""How long the applied signal is waited for, in seconds, as the page states it."""

PAUSES: Final = (0.025, 0.05, 0.1, 0.2)
"""The pause before each later ask of the store, in seconds, as the page states them."""

TURNS: Final = 50
"""More turns than a build takes between two waits."""

MAIN: Final = ResourceId("res-main")


@final
@dataclass(frozen=True, slots=True)
class StatedConnection:
    """A connection as a case states it."""

    resource: ResourceDescriptor
    bidirectional: bool


@final
@dataclass(frozen=True, slots=True)
class Further:
    """What the store answers of one resource further out, as a case states it."""

    resource: ResourceId
    connections: tuple[StatedConnection, ...]
    referenced_by: tuple[Annotation, ...]


@final
@dataclass(frozen=True, slots=True)
class Case:
    """One case of the table."""

    why: str
    resource: ResourceId
    depth: int
    """How many links out the graph is built, which is 1 where the case states none."""
    answers: tuple[ResourceDescriptor | None, ...]
    """What the store answers each time it is asked for the resource, in order."""
    connections: tuple[StatedConnection, ...]
    referenced_by: tuple[Annotation, ...]
    annotations: tuple[Annotation, ...]
    further: tuple[Further, ...]
    """What the store answers of each resource further out. A resource that is not here is one the build must not ask of."""
    views: tuple[ResourceView, ...]
    applied: bool
    knowledge_graph: JsonObject | None
    """The graph built, as the table words it, where the case states one."""
    fails: Failure | None
    waited: int
    """The milliseconds that pass in waiting."""


def failure_of(stated: JsonValue, why: str) -> Failure | None:
    """How a case fails, where it states that it does."""
    if stated is None:
        return None
    if stated == "unknown":
        return "unknown"
    if stated == "behind":
        return "behind"
    raise AssertionError(f"{why}: fails is neither unknown nor behind")


def connection_of(stated: JsonObject, why: str) -> StatedConnection:
    assert set(stated) <= CONNECTION_PLACES, f"{why}: {sorted(set(stated) - CONNECTION_PLACES)} has no place in a connection"
    bidirectional = stated["bidirectional"]
    assert isinstance(bidirectional, bool), f"{why}: a connection's bidirectional is not a flag"
    return StatedConnection(
        resource=ResourceDescriptor.model_validate(stated["resource"]),
        bidirectional=bidirectional,
    )


def further_of(resource: str, stated: JsonObject, why: str) -> Further:
    assert set(stated) == FURTHER_PLACES, f"{why}: of {resource}, further out, the graph store answers {sorted(stated)}"
    return Further(
        resource=ResourceId(resource),
        connections=tuple(connection_of(each, why) for each in objects(stated["connections"], f"{why}: connections of {resource}")),
        referenced_by=tuple(
            Annotation.model_validate(each) for each in objects(stated["referencedBy"], f"{why}: referencedBy of {resource}")
        ),
    )


def case_of(stated: JsonObject) -> Case:
    """A case, from what the table states of it. Each object of it is decoded as the SDK's type, so one the spec refuses fails."""
    why = text(stated["why"], "a case's why")
    assert set(stated) <= PLACES, f"{why}: {sorted(set(stated) - PLACES)} has no place in a case"
    store = thing(stated["graph"], f"{why}: graph")
    assert STORE_PLACES <= set(store) <= STORE_PLACES | {FURTHER}, f"{why}: the graph store answers {sorted(store)}"
    beyond: JsonObject = thing(store[FURTHER], f"{why}: further") if FURTHER in store else {}
    asked_for = text(stated["resource"], f"{why}: resource")
    assert asked_for not in beyond, f"{why}: further states the resource asked for, which is stated beside it"
    answers = store["resource"]
    assert isinstance(answers, list), f"{why}: the store's answers for the resource are not a list"
    views: list[ResourceView] = []
    for held_for, held in thing(stated["views"], f"{why}: views").items():
        a_view = ResourceView.model_validate(held)
        assert a_view.resource.id == held_for, f"{why}: the view under {held_for} is of {a_view.resource.id}"
        views.append(a_view)
    applied = stated["applied"]
    assert isinstance(applied, bool), f"{why}: applied is not a flag"
    built = stated.get("knowledgeGraph")
    if built is not None:
        # A graph the spec refuses cannot be read.
        KnowledgeGraph.model_validate(built)
    return Case(
        why=why,
        resource=ResourceId(asked_for),
        depth=whole(stated["depth"], f"{why}: depth") if "depth" in stated else LEAST_DEPTH,
        further=tuple(further_of(resource, thing(of_it, f"{why}: further of {resource}"), why) for resource, of_it in beyond.items()),
        answers=tuple(None if answer is None else ResourceDescriptor.model_validate(answer) for answer in answers),
        connections=tuple(connection_of(each, why) for each in objects(store["connections"], f"{why}: connections")),
        referenced_by=tuple(Annotation.model_validate(each) for each in objects(store["referencedBy"], f"{why}: referencedBy")),
        annotations=tuple(Annotation.model_validate(each) for each in objects(store["annotations"], f"{why}: annotations")),
        views=tuple(views),
        applied=applied,
        knowledge_graph=None if built is None else thing(built, f"{why}: knowledgeGraph"),
        fails=failure_of(stated.get("fails"), why),
        waited=whole(stated["waited"], f"{why}: waited"),
    )


CASES: Final = [case_of(stated) for stated in objects(read(SPEC / "librarian/knowledge-graph-cases.json")["cases"], "cases")]


def wire(model: WireModel) -> JsonObject:
    """A shape as the wire carries it, all the way down, without what was never said."""
    said: JsonObject = model.model_dump(mode="json", exclude_unset=True)
    return said


# ── The graph store of a case ─────────────────────────────────────────


@final
class StatedGraph(GraphReads):
    """The graph store, answering what a case states. `asked` is how many times it was asked for the resource.

    The rig's graph answers one thing for a resource however often it is
    asked. A case states an answer for each ask, so this is a double of its
    own. The build asks it four of the six reads, and the other two fail.

    `asked_further` is each read of a resource further out, in order: the
    read's name and the resource. A resource the case states nothing of
    fails the read, and so does asking for a further resource's description
    or for the annotations on it.
    """

    def __init__(self, case: Case) -> None:
        self._case: Final = case
        self._further: Final = {each.resource: each for each in case.further}
        self.asked = 0
        self.asked_further: Final[list[tuple[str, ResourceId]]] = []

    def _further_out(self, read: str, resource_id: ResourceId) -> Further:
        """What the case states of a resource further out, noted as asked."""
        assert resource_id in self._further, f"{read} was asked of {resource_id}, which the case states nothing of"
        self.asked_further.append((read, resource_id))
        return self._further[resource_id]

    @override
    async def get_resource(self, resource_id: ResourceId) -> ResourceDescriptor | None:
        assert resource_id == self._case.resource
        answers = self._case.answers
        assert self.asked < len(answers), f"asked for the resource more than the {len(answers)} times the case states an answer for"
        answer = answers[self.asked]
        self.asked += 1
        await asyncio.sleep(0)
        return answer

    @override
    async def list_resources(self, query: ResourceQuery) -> ResourceListing:
        raise AssertionError("a build lists no resources")

    @override
    async def get_resource_annotations(self, resource_id: ResourceId) -> list[Annotation]:
        assert resource_id == self._case.resource
        await asyncio.sleep(0)
        return [*self._case.annotations]

    @override
    async def get_resource_referenced_by(self, resource_id: ResourceId, motivation: Motivation | None) -> list[Annotation]:
        assert motivation is None, "a build asks for what refers to a resource, of every motivation"
        await asyncio.sleep(0)
        if resource_id == self._case.resource:
            return [*self._case.referenced_by]
        return [*self._further_out("get_resource_referenced_by", resource_id).referenced_by]

    @override
    async def get_resource_connections(self, resource_id: ResourceId) -> list[GraphConnection]:
        await asyncio.sleep(0)
        connections = (
            self._case.connections
            if resource_id == self._case.resource
            else self._further_out("get_resource_connections", resource_id).connections
        )
        # A connection, as the graph package answers one, names no relationship type: what a case states of one has
        # nowhere to go here.
        return [
            GraphConnection(target_resource=stated.resource, annotations=[], bidirectional=stated.bidirectional) for stated in connections
        ]

    @override
    async def get_entity_type_stats(self) -> list[EntityTypeCount]:
        raise AssertionError("a build counts no entity types")


# ── A case, run ───────────────────────────────────────────────────────


@final
@dataclass(frozen=True, slots=True)
class Outcome:
    """What a build came to."""

    built: KnowledgeGraph | None
    failure: BaseException | None
    waited: int
    """How far the clock was moved before the build was done, in milliseconds."""
    asked: int
    """How many times the store was asked for the resource."""
    asked_further: tuple[tuple[str, ResourceId], ...]
    """Each read the store was asked of a resource further out, in order: the read's name and the resource."""
    counted: tuple[str, ...]
    """Each gather counted as one that went without something."""


async def outcome_of(case: Case) -> Outcome:
    """Run a case's build, moving the clock by each wait the page states until the build is done."""
    loop = asyncio.get_running_loop()
    assert isinstance(loop, SteppedLoop), "the scenario is not run by `run`"
    store = StatedGraph(case)
    degraded = FakeDegraded()
    weave = WeaveProgress(loop.time)
    if case.applied:
        (of_it,) = [held for held in case.views if held.resource.id == case.resource]
        weave.noted(case.resource, of_it.last_sequence)

    began = loop.ahead
    building = asyncio.ensure_future(
        build_knowledge_graph(case.resource, graph=store, views=FakeViews(*case.views), weave=weave, degraded=degraded, depth=case.depth)
    )
    try:
        for wait in (0.0, *PAUSES) if case.applied else (0.0, SIGNAL_WAIT, *PAUSES):
            if wait > 0:
                await pass_time(wait, step=wait)
            for _ in range(TURNS):
                await asyncio.sleep(0)
            if building.done():
                break
        assert building.done(), "the build is not done after every wait the page states"
    finally:
        building.cancel()
        await asyncio.gather(building, return_exceptions=True)
        await weave.aclose()

    failure = building.exception()
    return Outcome(
        built=building.result() if failure is None else None,
        failure=failure,
        waited=round((loop.ahead - began) * 1000),
        asked=store.asked,
        asked_further=tuple(store.asked_further),
        counted=tuple(degraded.noted),
    )


def test_the_runner_found_the_table_s_cases() -> None:
    assert len(CASES) >= 40


def test_each_case_is_told_from_the_others_by_its_why() -> None:
    whys = [case.why for case in CASES]
    assert len(set(whys)) == len(whys)


def test_each_case_states_a_graph_or_a_failure_and_never_both() -> None:
    for case in CASES:
        assert (case.knowledge_graph is None) != (case.fails is None), case.why
    assert any(case.fails == "unknown" for case in CASES)
    assert any(case.fails == "behind" for case in CASES)
    assert any(case.applied for case in CASES)
    assert any(case.waited > 0 and not case.applied for case in CASES)


def test_each_case_s_depth_is_in_bounds_and_only_a_graph_built_further_than_one_link_out_states_what_is_further() -> None:
    for case in CASES:
        assert LEAST_DEPTH <= case.depth <= LARGEST_DEPTH, case.why
        if case.depth == LEAST_DEPTH or case.fails is not None:
            # Nothing further out is asked of, so nothing of it may be stated.
            assert case.further == (), case.why
    assert {case.depth for case in CASES} == set(range(LEAST_DEPTH, LARGEST_DEPTH + 1))
    assert any(case.further for case in CASES)


def test_a_case_whose_signal_has_arrived_has_a_view_of_its_resource() -> None:
    # The signal is at the sequence number the view states.
    for case in CASES:
        if case.applied:
            assert [held.resource.id for held in case.views].count(case.resource) == 1, case.why


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.why)
def test_a_build_gives_the_graph_or_the_failure_the_table_states_after_the_wait_it_states(case: Case) -> None:
    outcome = run(outcome_of(case))

    if case.fails is None:
        if outcome.failure is not None:
            raise outcome.failure
        assert outcome.built is not None
        assert wire(outcome.built) == case.knowledge_graph, case.why
        assert outcome.counted == (), case.why
    elif case.fails == "unknown":
        assert isinstance(outcome.failure, ResourceUnknown), f"{case.why}: {outcome.failure!r}"
        assert "not found" in str(outcome.failure)
        assert outcome.counted == (), case.why
    else:
        assert isinstance(outcome.failure, GraphBehind), f"{case.why}: {outcome.failure!r}"
        assert "behind the views" in str(outcome.failure)
        assert "not missing" in str(outcome.failure)
        assert "not found" not in str(outcome.failure)
        assert outcome.counted == ("graph",), case.why
    assert outcome.waited == case.waited, case.why
    assert outcome.asked == len(case.answers), case.why
    # Each resource the case states further out was asked both reads, once each, and no other resource was asked either.
    stated_further = sorted(each.resource for each in case.further)
    for read in ("get_resource_connections", "get_resource_referenced_by"):
        asked_of = sorted(resource for name, resource in outcome.asked_further if name == read)
        assert asked_of == stated_further, f"{case.why}: {read} was asked of {asked_of}, and the case states {stated_further}"


# ── What no case of the table states ──────────────────────────────────


def absent_from_the_graph() -> FakeGraph:
    """A graph that does not hold the main resource, and answers nothing else of it."""
    graph = FakeGraph()
    graph.resources[MAIN] = None
    return graph


def test_the_longest_wait_is_the_875_milliseconds_the_page_states() -> None:
    assert pytest.approx(SIGNAL_WAIT + sum(PAUSES)) == GRAPH_WAIT_BUDGET
    assert round(GRAPH_WAIT_BUDGET * 1000) == 875


def test_a_wait_that_fails_in_any_way_but_running_out_fails_the_build_and_the_store_is_not_asked_again() -> None:
    async def scenario() -> None:
        graph, degraded, weave = absent_from_the_graph(), FakeDegraded(), FakeWeave()
        weave.failing = RuntimeError("the fold is wedged")
        views = FakeViews(view(described(MAIN), last_sequence=7))

        with pytest.raises(RuntimeError, match=r"the fold is wedged"):
            await build_knowledge_graph(MAIN, graph=graph, views=views, weave=weave, degraded=degraded, depth=1)

        assert graph.asked_of("get_resource") == [MAIN]
        assert weave.asked == [(MAIN, 7, SIGNAL_WAIT)]
        assert degraded.noted == []

    run(scenario())


def test_the_signal_is_waited_for_at_the_sequence_number_the_view_states_and_the_stores_are_asked_of_the_resource() -> None:
    async def scenario() -> None:
        graph, degraded, weave = FakeGraph(), FakeDegraded(), FakeWeave()
        held = described(MAIN, name="Main")
        graph.connections[MAIN] = []
        graph.referenced_by[MAIN] = []
        graph.annotations[MAIN] = []
        weave.applied[MAIN] = 4
        # The store comes to hold the resource while the signal is waited for.
        graph.resources[MAIN] = None
        weave.then = lambda: graph.resources.update({MAIN: held})
        views = FakeViews(view(held, last_sequence=4))

        built = await build_knowledge_graph(MAIN, graph=graph, views=views, weave=weave, degraded=degraded, depth=1)

        assert wire(built) == {"nodes": [{"id": MAIN, "type": "resource", "label": "Main", "entityTypes": []}], "edges": []}
        assert weave.asked == [(MAIN, 4, SIGNAL_WAIT)]
        assert [read for read, _ in graph.asked] == [
            "get_resource",
            "get_resource",
            "get_resource_connections",
            "get_resource_referenced_by",
            "get_resource_annotations",
        ]
        assert graph.asked_of("get_resource_referenced_by") == [(MAIN, None)]
        assert degraded.noted == []

    run(scenario())


def test_a_graph_that_stays_behind_is_counted_once_and_logged_once_as_a_warning(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        graph, degraded, weave = absent_from_the_graph(), FakeDegraded(), FakeWeave()
        views = FakeViews(view(described(MAIN), last_sequence=3))

        with pytest.raises(GraphBehind, match=r"behind the views.*not missing"):
            await hurried(build_knowledge_graph(MAIN, graph=graph, views=views, weave=weave, degraded=degraded, depth=1))

        assert len(graph.asked_of("get_resource")) == 1 + len(PAUSES)
        assert degraded.noted == ["graph"]

    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        run(scenario())
    (said,) = [vars(record) for record in caplog.records if record.name == "semiont_librarian" and record.levelno == logging.WARNING]
    assert said["resourceId"] == MAIN
    assert said["lastSequence"] == 3


def test_a_resource_no_one_holds_is_logged_and_counted_as_nothing(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        graph, degraded, weave = absent_from_the_graph(), FakeDegraded(), FakeWeave()

        with pytest.raises(ResourceUnknown, match=r"not found"):
            await build_knowledge_graph(MAIN, graph=graph, views=FakeViews(), weave=weave, degraded=degraded, depth=1)

        assert weave.asked == []
        assert degraded.noted == []

    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        run(scenario())
    assert [record for record in caplog.records if record.name == "semiont_librarian"] == []


# ── Depth, and the ceiling ────────────────────────────────────────────


def test_the_depths_a_graph_is_built_to_are_1_to_3_and_its_ceiling_is_200_resources() -> None:
    assert (LEAST_DEPTH, LARGEST_DEPTH, RESOURCE_CEILING) == (1, 3, 200)


@pytest.mark.parametrize("depth", [-1, 0, 4, 200])
def test_a_depth_less_than_1_or_more_than_3_is_refused_and_nothing_is_read(depth: int) -> None:
    async def scenario() -> None:
        graph, degraded, weave, views = FakeGraph(), FakeDegraded(), FakeWeave(), FakeViews()

        with pytest.raises(DepthRefused, match=r"depth must be between 1 and 3"):
            await build_knowledge_graph(MAIN, graph=graph, views=views, weave=weave, degraded=degraded, depth=depth)

        assert graph.asked == []
        assert views.asked == []
        assert weave.asked == []

    run(scenario())


def numbered(kind: str, count: int) -> list[ResourceId]:
    """As many resource ids of one kind, in order."""
    return [ResourceId(f"res-{kind}-{number:03d}") for number in range(count)]


def linking(graph: FakeGraph, source: ResourceId, targets: list[ResourceId]) -> None:
    """Make the graph answer that a resource links to each of `targets`, one way, in order, and that nothing cites it."""
    graph.connections[source] = [GraphConnection(target_resource=described(to), annotations=[], bidirectional=False) for to in targets]
    graph.referenced_by[source] = []


def a_graph_of(near: list[ResourceId], far: dict[ResourceId, list[ResourceId]]) -> FakeGraph:
    """A graph whose main resource links to each of `near`, and in which each resource of `far` links to what is stated for it.

    Nothing cites anything, there is no annotation on the main resource, and
    a resource nothing is stated for links to nothing.
    """
    graph = FakeGraph()
    graph.resources[MAIN] = described(MAIN, name="Main")
    graph.annotations[MAIN] = []
    linking(graph, MAIN, near)
    for source in near:
        linking(graph, source, far.get(source, []))
    for targets in far.values():
        for target in targets:
            linking(graph, target, [])
    return graph


async def built_from(graph: FakeGraph, depth: int) -> KnowledgeGraph:
    """The graph built around the main resource, to a depth."""
    return await build_knowledge_graph(MAIN, graph=graph, views=FakeViews(), weave=FakeWeave(), degraded=FakeDegraded(), depth=depth)


def resources_of(built: KnowledgeGraph) -> list[str]:
    """The ids of a graph's resource nodes, in order."""
    return [node.id for node in built.nodes if isinstance(node, GraphResourceNode)]


def test_a_graph_stops_taking_resources_at_its_ceiling_nearest_first_and_says_that_it_stopped() -> None:
    async def scenario() -> None:
        # Two resources one link out. The first links to 150 more and the second to 150 others: 303 in all, with the main one.
        first, second = numbered("near", 2)
        of_first, of_second = numbered("far-a", 150), numbered("far-b", 150)
        graph = a_graph_of([first, second], {first: of_first, second: of_second})

        built = await built_from(graph, 2)

        # The nearest are kept: the main resource, the two, all the first links to, and the first 47 the second links to.
        kept = RESOURCE_CEILING - 3 - len(of_first)
        assert resources_of(built) == [MAIN, first, second, *of_first, *of_second[:kept]]
        assert len(resources_of(built)) == RESOURCE_CEILING
        assert wire(built)["truncated"] is True
        # A resource that was kept out has no edge to it either.
        held = set(resources_of(built))
        assert all(edge.source in held and edge.target in held for edge in built.edges)
        assert len(built.edges) == RESOURCE_CEILING - 1
        # Each resource one link out was asked of once, and none further out was: the depth is 2.
        assert graph.asked_of("get_resource_connections") == [MAIN, first, second]
        assert graph.asked_of("get_resource_referenced_by") == [(MAIN, None), (first, None), (second, None)]

    run(scenario())


def test_a_graph_of_exactly_as_many_resources_as_its_ceiling_is_whole_and_does_not_say_that_it_stopped() -> None:
    async def scenario() -> None:
        (near,) = numbered("near", 1)
        far = numbered("far", RESOURCE_CEILING - 2)
        graph = a_graph_of([near], {near: far})

        built = await built_from(graph, 2)

        assert resources_of(built) == [MAIN, near, *far]
        assert len(resources_of(built)) == RESOURCE_CEILING
        assert "truncated" not in wire(built)

    run(scenario())


def test_a_resource_the_ceiling_kept_out_is_not_asked_of_and_a_link_among_the_resources_kept_is_still_an_edge() -> None:
    async def scenario() -> None:
        # One resource one link out links to 198 more, which fills the graph, and then to one too many.
        (near,) = numbered("near", 1)
        far = numbered("far", RESOURCE_CEILING - 2)
        (beyond,) = numbered("beyond", 1)
        graph = a_graph_of([near], {near: [*far, beyond]})
        # The first resource two links out links back to the main one, and on to a resource that is kept out.
        linking(graph, far[0], [MAIN, beyond])

        built = await built_from(graph, 3)

        assert resources_of(built) == [MAIN, near, *far]
        assert wire(built)["truncated"] is True
        assert objects(wire(built)["edges"], "edges")[-1] == {"source": far[0], "target": MAIN, "type": "link", "bidirectional": False}
        assert beyond not in graph.asked_of("get_resource_connections")
        assert graph.asked_of("get_resource_connections") == [MAIN, near, *far]

    run(scenario())


def test_one_link_out_is_not_cut_at_the_ceiling() -> None:
    async def scenario() -> None:
        near = numbered("near", RESOURCE_CEILING + 5)
        graph = a_graph_of(near, {})

        built = await built_from(graph, 1)

        assert resources_of(built) == [MAIN, *near]
        assert "truncated" not in wire(built)

    run(scenario())
