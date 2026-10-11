"""The Weaver's fold, held to `specs/src/weaver/fold-cases.json`.

The table is the one every implementation of the Weaver runs: a case is a
history of recorded events and the graph it must leave, so the rule of each
event is stated once and not once for each language.

Every event of the table is first shown to be one the bus could carry: a
stored event, with the payload the bus registry names for its type. A fixture
that is no recorded event shows nothing of what the fold does with one.
"""

import asyncio

import pytest
from aio import run
from pydantic import JsonValue
from rig import Rig
from semiont.model import written
from semiont.types import Annotation, ResourceDescriptor, StoredEventResponse
from semiont_graph.interface import GraphDatabase, ResourceQuery
from semiont_graph.memory import MemoryGraphDatabase
from spec import SPEC, JsonObject, objects, read, strings, text, thing, whole

from semiont_weaver.recorded import ENRICHED, PLAIN

CASES = objects(read(SPEC / "weaver/fold-cases.json")["cases"], "cases")
READ = {channel.name: channel for channel in (*PLAIN, *ENRICHED)}
"""The channel of each event a Weaver follows, which reads the event's own payload."""


def by_id(things: list[JsonObject], name: str) -> list[JsonValue]:
    in_order: list[JsonObject] = sorted(things, key=lambda thing: text(thing[name], name))
    return [*in_order]


def ordered(graph: JsonObject) -> JsonObject:
    """A graph with every set in one order, so that two that hold the same things are equal."""
    resources: list[JsonObject] = []
    for resource in objects(graph["resources"], "resources"):
        entity_types: list[JsonValue] = [*sorted(strings(resource["entityTypes"], "entityTypes"))]
        resources.append({**resource, "entityTypes": entity_types})
    added: list[JsonValue] = [*sorted(strings(graph["entityTypesAdded"], "entityTypesAdded"))]
    return {
        "resources": by_id(resources, "@id"),
        "annotations": by_id(objects(graph["annotations"], "annotations"), "id"),
        "entityTypesAdded": added,
    }


async def held(graph: GraphDatabase) -> JsonObject:
    """What a graph holds, as the table states one."""
    resources = (await graph.list_resources(ResourceQuery(limit=1_000))).resources
    annotations: list[JsonValue] = []
    for resource in resources:
        annotations.extend(written(annotation) for annotation in await graph.get_resource_annotations(resource.id))
    # What every knowledge base starts with is what a graph nothing was added to has.
    starts_with = await MemoryGraphDatabase().get_entity_types()
    added: list[JsonValue] = [name for name in await graph.get_entity_types() if name not in starts_with]
    described: list[JsonValue] = [written(resource) for resource in resources]
    return ordered({"resources": described, "annotations": annotations, "entityTypesAdded": added})


def test_every_event_of_the_table_is_one_the_bus_could_carry_and_every_graph_one_the_spec_allows() -> None:
    for case in CASES:
        for event in objects(case["history"], "history"):
            stored = StoredEventResponse.model_validate(event)
            assert written(READ[stored.type].event(stored)) == stored.payload, f"{stored.type} {stored.id}"
        graph = thing(case["graph"], "graph")
        for resource in objects(graph["resources"], "resources"):
            assert written(ResourceDescriptor.model_validate(resource)) == resource
        for annotation in objects(graph["annotations"], "annotations"):
            assert written(Annotation.model_validate(annotation)) == annotation


@pytest.mark.parametrize("case", [pytest.param(case, id=text(case["why"], "why")) for case in CASES])
def test_a_history_leaves_the_graph_the_table_states(case: JsonObject) -> None:
    async def scenario() -> None:
        expected = ordered(thing(case["graph"], "graph"))
        applied = {resource: whole(sequence, "applied") for resource, sequence in thing(case["applied"], "applied").items()}
        refused = whole(case.get("refused", 0), "refused")

        async with Rig() as rig:
            for event in objects(case["history"], "history"):
                rig.deliver(event)
            await rig.settled()

            async def as_stated() -> None:
                assert rig.weaver.applied() == applied
                assert rig.weaver.apply_failures == refused
                assert await held(rig.graph) == expected
                signalled = rig.signalled()
                assert {resource: max(marks) for resource, marks in signalled.items()} == applied
                # The mark only rises, and is signalled each time it does.
                assert all(marks == sorted(set(marks)) for marks in signalled.values())

            await as_stated()
            # And it stays so: a mark that passes a refused event, or an event applied a second time, would show
            # only after the graph first matched.
            await asyncio.sleep(0.05)
            await rig.settled()
            await as_stated()

    run(scenario())
