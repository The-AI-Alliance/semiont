"""The Weaver's rules, held over histories nobody wrote.

`test_fold_cases.py` holds each rule of the fold to a history someone thought
to write. These hold what is to be so of every history, and of every way the
bus can deliver one: Hypothesis makes the histories, and shrinks one that
fails to the least that still does.

A history here is well formed, as a record is: a resource's first event is
its `yield:created`, its sequence numbers rise by one, and an annotation is
on one resource for good. A delivery of it keeps each resource's events in
their order and mixes the resources' in any, and delivers some events a
second time, at once or after later ones, as a stream that is resumed does.

The graph is held to two things. The first is the record's views, which the
rig folds from the record in the order it was recorded: a delivery in another
order, with events delivered twice, must leave the same graph. The second is
a fold written here, which shares nothing with the Weaver's and reads less of
each event: which resources there are, whether each is archived, its entity
types, and which annotations are on it. A fold that agrees with itself and is
wrong is caught by the second.
"""

import itertools
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Final, Literal, final

from aio import run
from hypothesis import given, settings
from hypothesis import strategies as st
from pydantic import JsonValue
from rig import Rig, added, archived, body_updated, created, event, link, removed, tag, tagged
from semiont_graph.interface import GraphDatabase, ResourceQuery
from spec import JsonObject

RESOURCES: Final = ("res-a", "res-b", "res-c")
ENTITY_TYPES: Final = ("Place", "County", "River")

type Kind = Literal["created", "archived", "unarchived", "tagged", "untagged", "added", "removed", "body-updated"]

_OF_A_NEW_RESOURCE: Final[tuple[Kind, ...]] = ("archived", "unarchived", "tagged", "untagged", "added")
_OF_AN_ANNOTATED_RESOURCE: Final[tuple[Kind, ...]] = (*_OF_A_NEW_RESOURCE, "removed", "body-updated")

# Every example runs a Weaver to rest several times over, so none is held to a time; and nothing is kept between
# runs, so a run reads no file a run before it wrote.
PROPERTY: Final = settings(max_examples=50, deadline=None, database=None)


@final
@dataclass(frozen=True, slots=True)
class Step:
    """One recorded event, and what the reference fold reads of it."""

    kind: Kind
    resource: str
    """The resource it is of."""
    sequence: int
    subject: str
    """The entity type or the annotation it names. Empty where it names neither."""
    starts_with: tuple[str, ...]
    """The entity types a created resource has from its first event."""
    recorded: JsonObject
    """The event, as the record holds it and the bus carries it."""


@final
@dataclass(frozen=True, slots=True)
class History:
    recorded: tuple[Step, ...]
    """Every event, with each resource's in the order they were recorded."""
    delivered: tuple[Step, ...]
    """What the bus delivers of them: each resource's in their order, the resources' mixed, and some delivered again."""

    def last(self) -> dict[str, int]:
        """The sequence number of each resource's last event."""
        return {step.resource: step.sequence for step in self.recorded}

    def as_recorded(self) -> Iterator[JsonObject]:
        return (step.recorded for step in self.recorded)

    def as_delivered(self) -> Iterator[JsonObject]:
        return (step.recorded for step in self.delivered)


def _operation(drawn: tuple[str, JsonObject]) -> JsonObject:
    op, item = drawn
    return {"op": op, "item": item}


_ITEMS: Final = st.one_of(st.sampled_from(ENTITY_TYPES).map(tag), st.sampled_from(RESOURCES).map(link))
_OPERATIONS: Final = st.tuples(st.sampled_from(("add", "remove")), _ITEMS).map(_operation)


def _step(draw: st.DrawFn, kind: Kind, resource: str, sequence: int, made: list[str], minted: Iterator[int]) -> Step:
    """One event of `kind` for a resource. `made` is every annotation added to the resource so far, and is added to."""

    def of(subject: str, recorded: JsonObject) -> Step:
        return Step(kind=kind, resource=resource, sequence=sequence, subject=subject, starts_with=(), recorded=recorded)

    match kind:
        case "archived":
            return of("", archived(resource, sequence))
        case "unarchived":
            return of("", event("mark:unarchived", resource, sequence, {}))
        case "tagged":
            entity_type = draw(st.sampled_from(ENTITY_TYPES))
            return of(entity_type, tagged(resource, sequence, entity_type))
        case "untagged":
            entity_type = draw(st.sampled_from(ENTITY_TYPES))
            return of(entity_type, event("mark:entity-tag-removed", resource, sequence, {"entityType": entity_type}))
        case "added":
            # One made before, which is added again, or a new one. An annotation is on one resource for good.
            again = draw(st.booleans()) if made else False
            annotation = draw(st.sampled_from(made)) if again else f"ann-{next(minted)}"
            if annotation not in made:
                made.append(annotation)
            tags = draw(st.lists(st.sampled_from(ENTITY_TYPES), unique=True, max_size=2))
            links = draw(st.lists(st.sampled_from(RESOURCES), max_size=1))
            return of(annotation, added(resource, sequence, annotation, *(tag(value) for value in tags), *(link(to) for to in links)))
        case "removed":
            annotation = draw(st.sampled_from(made))
            return of(annotation, removed(resource, sequence, annotation))
        case "body-updated":
            annotation = draw(st.sampled_from(made))
            operations = draw(st.lists(_OPERATIONS, min_size=1, max_size=3))
            return of(annotation, body_updated(resource, sequence, annotation, *operations, at=f"2020-03-05T00:00:{sequence:02d}.000Z"))
        case "created":
            raise AssertionError(f"{kind} is not an event of a resource that has been created")


@st.composite
def histories(draw: st.DrawFn) -> History:
    streams: list[list[Step]] = []
    minted = itertools.count(1)
    for resource in draw(st.lists(st.sampled_from(RESOURCES), min_size=1, max_size=len(RESOURCES), unique=True)):
        starts_with = tuple(draw(st.lists(st.sampled_from(ENTITY_TYPES), unique=True, max_size=len(ENTITY_TYPES))))
        entity_types: list[JsonValue] = [*starts_with]
        stream = [
            Step(
                kind="created",
                resource=resource,
                sequence=1,
                subject="",
                starts_with=starts_with,
                recorded=created(resource, entityTypes=entity_types),
            )
        ]
        made: list[str] = []
        for sequence in range(2, 2 + draw(st.integers(min_value=0, max_value=8))):
            kind = draw(st.sampled_from(_OF_AN_ANNOTATED_RESOURCE if made else _OF_A_NEW_RESOURCE))
            stream.append(_step(draw, kind, resource, sequence, made, minted))
        streams.append(stream)

    # Which stream each delivery is taken from: every stream's events in their order, and the streams' in any.
    turns = draw(st.permutations([index for index, stream in enumerate(streams) for _ in stream]))
    waiting = [iter(stream) for stream in streams]
    delivered = [next(waiting[index]) for index in turns]
    for _ in range(draw(st.integers(min_value=0, max_value=4))):
        # An event already delivered is delivered again: next, or after any number of later ones.
        again = draw(st.integers(min_value=0, max_value=len(delivered) - 1))
        delivered.insert(draw(st.integers(min_value=again + 1, max_value=len(delivered))), delivered[again])
    return History(recorded=tuple(step for stream in streams for step in stream), delivered=tuple(delivered))


type Held = dict[str, tuple[bool, list[str], list[str]]]
"""What a graph holds, as far as the reference reads it: for each resource whether it is archived, its entity types and
the annotations on it."""


def folded(steps: Sequence[Step]) -> Held:
    """What a graph is to hold after these events. It shares nothing with the Weaver's fold."""
    is_archived: dict[str, bool] = {}
    entity_types: dict[str, set[str]] = {}
    annotations: dict[str, set[str]] = {}
    for step in steps:
        resource = step.resource
        match step.kind:
            case "created":
                is_archived[resource] = False
                entity_types[resource] = set(step.starts_with)
                annotations[resource] = set()
            case "archived":
                is_archived[resource] = True
            case "unarchived":
                is_archived[resource] = False
            case "tagged":
                entity_types[resource].add(step.subject)
            case "untagged":
                entity_types[resource].discard(step.subject)
            case "added":
                annotations[resource].add(step.subject)
            case "removed":
                annotations[resource].discard(step.subject)
            case "body-updated":
                pass
    return {name: (is_archived[name], sorted(entity_types[name]), sorted(annotations[name])) for name in is_archived}


async def held(graph: GraphDatabase) -> Held:
    """What a graph holds, read as the reference states it."""
    resources: dict[str, tuple[bool, list[str], list[str]]] = {}
    for resource in (await graph.list_resources(ResourceQuery(limit=1_000))).resources:
        on_it = sorted(str(annotation.id) for annotation in await graph.get_resource_annotations(resource.id))
        resources[str(resource.id)] = (resource.archived is True, sorted(resource.entity_types or ()), on_it)
    return resources


async def as_the_record_says(rig: Rig, history: History) -> None:
    """The Weaver applied every event, to the last of each resource; and its graph is the views' and the reference's."""
    assert rig.weaver.apply_failures == 0
    assert rig.weaver.applied() == history.last()
    await rig.same_as_the_views()
    assert await held(rig.graph) == folded(history.recorded)


@PROPERTY
@given(histories())
def test_however_a_history_is_delivered_the_graph_is_what_the_record_says(history: History) -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.recorded(*history.as_recorded())
            rig.deliver(*history.as_delivered())
            await rig.settled()

            await as_the_record_says(rig, history)
            # Each resource's mark was signalled as it rose, to its last event and never back.
            signalled = rig.signalled()
            assert {resource: max(marks) for resource, marks in signalled.items()} == history.last()
            assert all(marks == sorted(set(marks)) for marks in signalled.values())
            # And the Weaver's own check of the graph against the record finds nothing to repair in it.
            assert (await rig.weaver.reconcile()).divergent == 0

    run(scenario())


@PROPERTY
@given(histories())
def test_a_rebuild_of_everything_leaves_the_graph_the_history_left(history: History) -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.recorded(*history.as_recorded())
            rig.deliver(*history.as_delivered())
            await rig.settled()

            rebuilt = await rig.weaver.rebuild_all()
            await rig.settled()

            assert rebuilt.failed == 0
            await as_the_record_says(rig, history)

    run(scenario())


@PROPERTY
@given(histories())
def test_a_weaver_that_kept_nothing_applies_the_record_again_and_ends_with_the_same_graph(history: History) -> None:
    async def scenario() -> None:
        async with Rig() as first:
            await first.recorded(*history.as_recorded())
            first.deliver(*history.as_delivered())
            await first.settled()

        # A second life of it, over the same graph, with no marks from the first: as a new container has.
        async with Rig(after=first) as second:
            caught_up = await second.weaver.catch_up()
            await second.settled()

            assert caught_up.events_failed == 0
            assert caught_up.parity_pending == 0
            await as_the_record_says(second, history)

    run(scenario())
