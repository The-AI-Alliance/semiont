"""The Weaver, over a transport a test scripts and a graph in the process: its order, how it follows the record, and its two repairs.

What each event does to the graph is the table's to hold
(`test_fold_cases.py`), how a follower of the record takes each log is the
follower's table's (`packages/service-python/tests/test_follow_cases.py`), and
what a Weaver process does behind a real gateway, a real Archivist and a real
database is the conformance suite's (`tests/conformance/weaver`). Here is what
none of them reaches: the Weaver's fold taken as a follower's take, a store
that fails, a record that was rewound, a view the record cannot account for,
and what is kept across a restart.
"""

import asyncio
import json
import logging
from pathlib import Path

import pytest
from aio import run
from rig import Rig, added, archived, body_updated, created, event, link, removed, tag, tagged
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.transport import Frame
from semiont.types import ResourceDescriptor
from semiont_graph.interface import ResourceChange

from semiont_weaver.weaver import Reconciled

R1, R2 = ResourceId("res-1"), ResourceId("res-2")


def reasons(caplog: pytest.LogCaptureFixture) -> list[object]:
    """Why reconcile called each resource divergent, as it logged it."""
    return [vars(record)["reason"] for record in caplog.records if record.getMessage().startswith("Reconcile divergence")]


async def turns() -> None:
    """Give the Weaver turns enough to go on with whatever it could: what a scenario does before it says something did not happen."""
    for _ in range(200):
        await asyncio.sleep(0)


# ── Order ──────────────────────────────────────────────────────────────


def test_an_event_delivered_again_after_later_ones_does_not_undo_them() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            first = created("res-1")
            await rig.happened(first, tagged("res-1", 2, "Place"), archived("res-1", 3))
            rig.deliver(first)
            await rig.settled()

            resource = await rig.graph.get_resource(R1)
            assert resource is not None
            assert resource.entity_types == ["Place"]
            assert resource.archived is True
            # The three were taken in one run, and how far it got was signalled once.
            assert rig.signalled() == {"res-1": [3]}

    run(scenario())


def test_a_removal_delivered_after_the_making_it_removes_is_applied_after_it() -> None:
    # The two are on two channels. Read a channel at a time they could be handed on in either order, and the
    # making would be passed by as one delivered again.
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), added("res-1", 2, "ann-1"), added("res-1", 3, "ann-2"), removed("res-1", 4, "ann-1"))
            assert [annotation.id for annotation in await rig.graph.get_resource_annotations(R1)] == ["ann-2"]
            assert rig.applied() == {"res-1": 4}

    run(scenario())


def test_a_frame_on_a_channel_of_the_record_that_is_no_recorded_event_is_said_and_passed_by(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            rig.transport.deliver(Frame(channel="mark:added", payload={"not": "an event"}))
            await rig.happened(created("res-1"))
            assert rig.applied() == {"res-1": 1}
            assert rig.weaver.follower.refused == 0

    with caplog.at_level(logging.ERROR, logger="semiont_weaver"):
        run(scenario())
    assert [record.getMessage() for record in caplog.records] == ["A frame on a channel of the record is not a recorded event"]


def test_an_event_the_fold_has_no_use_for_is_taken_as_nothing_and_moves_the_cursor() -> None:
    async def scenario() -> None:
        async with Rig() as first:
            # A resource's log holds events that are the views' alone.
            await first.recorded(created("res-1"), event("yield:updated", "res-1", 2, {"name": "Renamed"}), tagged("res-1", 3, "Place"))
        async with Rig(after=first) as rig:
            assert rig.applied() == {"res-1": 3}
            assert rig.weaver.follower.refused == 0
            await rig.same_as_the_views()

    run(scenario())


# ── A stream that drops ────────────────────────────────────────────────


def test_what_is_recorded_while_the_stream_is_down_is_taken_by_the_sweep_when_it_opens_again() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"))

            # The stream drops, and what is recorded meanwhile is never delivered.
            await rig.dropped()
            await rig.recorded(archived("res-1", 2), tagged("res-1", 3, "Place"))
            assert rig.applied() == {"res-1": 1}

            await rig.reopened()

            assert rig.applied() == {"res-1": 3}
            await rig.same_as_the_views()

    run(scenario())


def test_an_event_delivered_as_the_stream_opens_again_is_taken_after_what_was_recorded_unseen_before_it() -> None:
    # The race: an event delivered live before the sweep reaches its resource, with two before it recorded while the
    # stream was down. A Weaver that moved its mark to the delivered event would pass the two by for good.
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), tagged("res-1", 2, "Person"))
            await rig.dropped()
            await rig.recorded(archived("res-1", 3), tagged("res-1", 4, "Place"))
            later = added("res-1", 5, "ann-1", tag("Place"))
            await rig.recorded(later)

            rig.transport.set_state("connecting")
            rig.transport.set_state("open")
            rig.deliver(later)
            await rig.settled()

            assert rig.applied() == {"res-1": 5}
            await rig.same_as_the_views()
            held = await rig.graph.get_resource(R1)
            assert held is not None
            assert (held.archived, sorted(held.entity_types or ())) == (True, ["Person", "Place"])

    run(scenario())


def test_each_opening_after_a_drop_sweeps_and_nothing_is_taken_twice() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"))
            for sequence, entity_type in ((2, "Person"), (3, "Place")):
                await rig.dropped()
                await rig.recorded(tagged("res-1", sequence, entity_type))
                await rig.reopened()

            assert rig.applied() == {"res-1": 3}
            assert rig.signalled() == {"res-1": [1, 2, 3]}
            assert rig.weaver.follower.said()["streamDrops"] == 2
            await rig.same_as_the_views()

    run(scenario())


# ── A taking that fails ────────────────────────────────────────────────


def test_a_store_that_fails_stops_the_resource_s_log_where_it_is_and_the_next_sweep_takes_it_on(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            update = rig.graph.update_resource

            async def unreachable(resource_id: ResourceId, change: ResourceChange) -> ResourceDescriptor:
                if change.archived is not None:
                    raise ConnectionError("the database did not answer")
                return await update(resource_id, change)

            monkeypatch.setattr(rig.graph, "update_resource", unreachable)
            await rig.happened(created("res-1"), archived("res-1", 2), tagged("res-1", 3, "Place"))

            # The log stops at the event that failed: the one after it waits, and no cursor passes it.
            assert rig.applied() == {"res-1": 1}
            assert rig.weaver.follower.stopped == {"res-1"}
            assert rig.signalled() == {"res-1": [1]}
            held = await rig.graph.get_resource(R1)
            assert held is not None
            assert (held.archived, held.entity_types) == (False, [])

            monkeypatch.setattr(rig.graph, "update_resource", update)
            await rig.dropped()
            await rig.reopened()

            assert rig.applied() == {"res-1": 3}
            assert rig.weaver.follower.stopped == frozenset()
            assert rig.signalled() == {"res-1": [1, 3]}
            await rig.same_as_the_views()

    run(scenario())


def test_a_stopped_log_holds_no_other_resource_s(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig() as first:
            await first.recorded(created("res-1"), archived("res-1", 2), created("res-2"))
        update = first.graph.update_resource

        async def unreachable(resource_id: ResourceId, change: ResourceChange) -> ResourceDescriptor:
            if change.archived is not None:
                raise ConnectionError("the database did not answer")
            return await update(resource_id, change)

        monkeypatch.setattr(first.graph, "update_resource", unreachable)
        async with Rig(after=first) as rig:
            assert rig.applied() == {"res-1": 1, "res-2": 1}
            assert rig.weaver.follower.stopped == {"res-1"}
            assert rig.weaver.follower.said()["stopped"] == 1

    run(scenario())


def test_an_event_the_graph_cannot_take_as_recorded_is_taken_as_nothing_and_counted() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), added("res-1", 2, "ann-nobodys", creator=None), tagged("res-1", 3, "Place"))
            assert rig.applied() == {"res-1": 3}
            assert rig.weaver.follower.refused == 1
            assert await rig.graph.get_annotation(AnnotationId("ann-nobodys")) is None
            held = await rig.graph.get_resource(R1)
            assert held is not None
            assert held.entity_types == ["Place"]

    run(scenario())


# ── A start ────────────────────────────────────────────────────────────


def test_a_start_with_nothing_kept_takes_the_whole_record_and_keeps_its_cursors() -> None:
    async def scenario() -> None:
        async with Rig() as first:
            await first.recorded(
                created("res-1"), added("res-1", 2, "ann-1", tag("Person"), link("res-2")), created("res-2"), archived("res-2", 2)
            )
        async with Rig(after=first) as rig:
            await rig.same_as_the_views()
            assert rig.signalled() == {"res-1": [2], "res-2": [2]}
            assert json.loads(rig.kept.read_bytes()) == {"res-1": 2, "res-2": 2}

    run(scenario())


def test_a_start_takes_only_what_was_recorded_since_the_cursors_it_kept(tmp_path: Path) -> None:
    async def scenario() -> None:
        kept = tmp_path / "cursors.json"
        async with Rig(kept=kept) as first:
            await first.happened(created("res-1"), tagged("res-1", 2, "Place"), created("res-2"))
        # Stopped, it kept its cursors.
        assert json.loads(kept.read_bytes()) == {"res-1": 2, "res-2": 1}
        # Recorded while no Weaver was running.
        await first.recorded(archived("res-1", 3), created("res-3"))

        async with Rig(kept=kept, after=first) as second:
            assert second.signalled() == {"res-1": [3], "res-3": [1]}
            await second.same_as_the_views()

    run(scenario())


def test_cursors_that_cannot_be_read_are_no_cursors_and_the_whole_record_is_taken(tmp_path: Path) -> None:
    async def scenario() -> None:
        kept = tmp_path / "cursors.json"
        async with Rig() as first:
            await first.recorded(created("res-1"), tagged("res-1", 2, "Place"))
        kept.write_text("{ this is not JSON", encoding="utf-8")
        async with Rig(kept=kept, after=first) as rig:
            assert rig.applied() == {"res-1": 2}
            await rig.same_as_the_views()

    run(scenario())


def test_a_cursor_above_the_records_last_event_means_the_record_was_rewound_and_the_resource_is_rebuilt(tmp_path: Path) -> None:
    async def scenario() -> None:
        kept = tmp_path / "cursors.json"
        async with Rig(kept=kept) as first:
            await first.happened(created("res-1"), tagged("res-1", 2, "Place"), tagged("res-1", 3, "Stale"), added("res-1", 4, "ann-stale"))
        assert json.loads(kept.read_bytes()) == {"res-1": 4}

        # The record is put back to where it was after its second event. Its views are made again from it.
        del first.record["res-1"][2:]
        await first.views.clear_database()
        for stored in first.record.pop("res-1"):
            await first.recorded(stored)

        async with Rig(kept=kept, after=first) as second:
            assert second.applied() == {"res-1": 2}
            await second.same_as_the_views()
            assert await second.graph.get_annotation(AnnotationId("ann-stale")) is None

    run(scenario())


# ── Reconcile ──────────────────────────────────────────────────────────


def test_reconcile_asks_for_the_catalog_again_while_the_archivist_is_not_there() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"))
            rig.unanswered.add("browse:resources-requested")
            asking = asyncio.ensure_future(rig.weaver.reconcile())
            await asyncio.sleep(0.05)
            assert not asking.done()

            rig.unanswered.clear()
            reconciled = await asking

            assert reconciled.resources_checked == 1
            assert [entry.channel for entry in rig.transport.request_log].count("browse:resources-requested") == 2

    run(scenario())


def test_a_graph_the_weaver_has_just_built_is_not_divergent() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(
                created("res-1"),
                created("res-2"),
                added(
                    "res-1",
                    2,
                    "ann-1",
                    tag("Person"),
                    link("res-2"),
                    generator={"@type": "Software", "@id": "did:web:x:agents:a:b", "name": "a b"},
                ),
                body_updated("res-1", 3, "ann-1", {"op": "add", "item": tag("Place")}, at="2021-01-02T03:04:05.000Z"),
                archived("res-2", 2),
            )
            assert await rig.weaver.reconcile() == Reconciled(resources_checked=2, divergent=0, healed=0, heal_failures=0, orphaned=0)

    run(scenario())


@pytest.mark.parametrize(
    "reason", ["missing-node", "archived-mismatch", "entity-types-mismatch", "annotation-set-mismatch", "annotation-content-mismatch"]
)
def test_a_graph_changed_behind_the_weaver_is_found_and_healed_from_the_record(reason: str, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(
                created("res-1"), created("res-2"), added("res-1", 2, "ann-1", tag("Person")), added("res-2", 2, "ann-2", link("res-1"))
            )
            match reason:
                case "missing-node":
                    await rig.graph.delete_resource(R1)
                case "archived-mismatch":
                    await rig.graph.update_resource(R1, ResourceChange(archived=True))
                case "entity-types-mismatch":
                    await rig.graph.update_resource(R1, ResourceChange(entity_types=["Nothing the record says"]))
                case "annotation-set-mismatch":
                    await rig.graph.delete_annotation(AnnotationId("ann-1"))
                case _:
                    await rig.graph.update_annotation(AnnotationId("ann-1"), {"body": [tag("Place")]})

            reconciled = await rig.weaver.reconcile()

            assert reconciled == Reconciled(resources_checked=2, divergent=1, healed=1, heal_failures=0, orphaned=0)
            await rig.same_as_the_views()
            # The other resource's link to the healed one was not touched, and is followed to it as before.
            assert [annotation.id for annotation in await rig.graph.get_resource_referenced_by(R1, None)] == ["ann-2"]
            assert await rig.weaver.reconcile() == Reconciled(resources_checked=2, divergent=0, healed=0, heal_failures=0, orphaned=0)

    with caplog.at_level(logging.WARNING, logger="semiont_weaver"):
        run(scenario())
    assert reasons(caplog) == [reason]


def test_a_cleared_graph_is_rebuilt_whole_by_reconcile() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), created("res-2"), added("res-1", 2, "ann-1", link("res-2")))
            await rig.graph.clear_database()

            assert await rig.weaver.reconcile() == Reconciled(resources_checked=2, divergent=2, healed=2, heal_failures=0, orphaned=0)
            await rig.same_as_the_views()

    run(scenario())


def test_a_resource_the_catalog_lists_and_the_record_holds_no_events_for_is_orphaned_and_not_healed() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"))
            # A view the record cannot account for: listed, and nothing recorded.
            await rig.recorded(created("res-2"))
            del rig.record["res-2"]

            assert await rig.weaver.reconcile() == Reconciled(resources_checked=2, divergent=1, healed=0, heal_failures=0, orphaned=1)
            assert await rig.graph.get_resource(R2) is None

    run(scenario())


def test_a_heal_that_stops_at_an_event_it_could_not_apply_is_no_heal(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), archived("res-1", 2))
            await rig.graph.delete_resource(R1)
            update = rig.graph.update_resource

            async def unreachable(resource_id: ResourceId, change: ResourceChange) -> ResourceDescriptor:
                if change.archived is not None:
                    raise ConnectionError("the database did not answer")
                return await update(resource_id, change)

            monkeypatch.setattr(rig.graph, "update_resource", unreachable)
            assert await rig.weaver.reconcile() == Reconciled(resources_checked=1, divergent=1, healed=0, heal_failures=1, orphaned=0)
            assert rig.weaver.follower.stopped == {"res-1"}
            assert await rig.graph.get_resource(R1) is not None

    run(scenario())


# ── Rebuild ────────────────────────────────────────────────────────────


def commanded(resource: str | None, correlation: str) -> Frame:
    return Frame(channel="weave:rebuild", payload={} if resource is None else {"resourceId": resource}, correlation_id=correlation)


def test_a_rebuild_of_one_resource_applies_its_record_again_and_leaves_anothers_link_to_it() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(
                created("res-1"),
                created("res-2"),
                added("res-1", 2, "ann-1", tag("Person"), created="2019-01-02T03:04:05.000Z"),
                added("res-2", 2, "ann-2", link("res-1")),
            )
            await rig.graph.update_resource(R1, ResourceChange(entity_types=["Nothing the record says"]))
            await rig.graph.update_resource(R2, ResourceChange(archived=True))

            rig.transport.deliver(commanded("res-1", "c-1"))
            await rig.settled()

            (answer,) = rig.answered("weave:rebuild-ok")
            assert answer.correlation_id == "c-1"
            rebuilt = await rig.graph.get_resource(R1)
            assert rebuilt is not None
            assert rebuilt.entity_types == []
            # A rebuilt annotation was made when its event says, and not when it was rebuilt.
            (annotation,) = await rig.graph.get_resource_annotations(R1)
            assert annotation.created == "2019-01-02T03:04:05.000Z"
            # The other resource was not touched: what was changed behind the Weaver there is still changed.
            other = await rig.graph.get_resource(R2)
            assert other is not None
            assert other.archived is True
            assert [linking.id for linking in await rig.graph.get_resource_referenced_by(R1, None)] == ["ann-2"]

    run(scenario())


def test_a_rebuild_of_everything_clears_the_graph_and_applies_the_whole_record() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(
                created("res-1"),
                created("res-2"),
                added("res-1", 2, "ann-1", link("res-2")),
                body_updated("res-1", 3, "ann-1", {"op": "add", "item": tag("Person")}, at="2021-01-02T03:04:05.000Z"),
            )
            await rig.graph.update_resource(R2, ResourceChange(archived=True))
            await rig.graph.delete_annotation(AnnotationId("ann-1"))

            rig.transport.deliver(commanded(None, "c-all"))
            await rig.settled()

            (answer,) = rig.answered("weave:rebuild-ok")
            assert answer.correlation_id == "c-all"
            await rig.same_as_the_views()
            assert rig.weaver.follower.refused == 0

    run(scenario())


def test_a_rebuild_that_meets_an_event_the_graph_cannot_take_takes_it_as_nothing_and_answers_that_it_rebuilt() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"))
            rig.record["res-1"].append(added("res-1", 2, "ann-nobodys", creator=None))

            rig.transport.deliver(commanded("res-1", "c-1"))
            await rig.settled()

            (answer,) = rig.answered("weave:rebuild-ok")
            assert answer.correlation_id == "c-1"
            assert rig.applied() == {"res-1": 2}
            assert rig.weaver.follower.refused == 1

    run(scenario())


def test_a_rebuild_that_stops_at_an_event_it_could_not_apply_answers_that_it_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), archived("res-1", 2))
            update = rig.graph.update_resource

            async def unreachable(resource_id: ResourceId, change: ResourceChange) -> ResourceDescriptor:
                if change.archived is not None:
                    raise ConnectionError("the database did not answer")
                return await update(resource_id, change)

            monkeypatch.setattr(rig.graph, "update_resource", unreachable)
            rig.transport.deliver(commanded("res-1", "c-1"))
            rig.transport.deliver(commanded(None, "c-2"))
            await rig.settled()

            assert rig.answered("weave:rebuild-ok") == []
            failed = rig.answered("weave:rebuild-failed")
            assert [answer.correlation_id for answer in failed] == ["c-1", "c-2"]
            assert all("the rebuild stopped at an event it could not apply" in written_text(answer) for answer in failed)

    run(scenario())


def test_a_rebuild_the_record_cannot_be_read_for_answers_that_it_failed() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"))
            rig.archivist.unanswered = True

            rig.transport.deliver(commanded("res-1", "c-1"))
            await rig.settled()

            (failed,) = rig.answered("weave:rebuild-failed")
            assert failed.correlation_id == "c-1"
            assert "the rebuild stopped at an event it could not apply" in written_text(failed)
            assert rig.weaver.follower.stopped == {"res-1"}

    run(scenario())


def written_text(frame: Frame) -> str:
    message = frame.payload["message"]
    assert isinstance(message, str)
    return message


def test_an_event_that_arrives_while_its_resource_is_rebuilt_is_taken_after_the_rebuild() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), tagged("res-1", 2, "Place"))
            later = archived("res-1", 3)
            await rig.recorded(later)

            # Commanded, and then the event delivered before the Weaver has had a turn: the event's turn is first in the
            # lane, and the rebuild, after it there, takes the whole log again, the event among it.
            rebuilding = asyncio.ensure_future(rig.weaver.rebuild_resource(R1))
            rig.deliver(later)
            await rebuilding
            await rig.settled()

            await rig.same_as_the_views()
            assert rig.applied() == {"res-1": 3}
            assert rig.signalled() == {"res-1": [2, 3, 3]}

    run(scenario())


def test_what_it_holds_of_the_record_is_never_written_back_into_it() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), added("res-1", 2, "ann-1", tag("Person")))
            await rig.weaver.reconcile()
            # It asks one thing of the record on the bus and says one: everything else on the bus is somebody else's.
            assert {frame.channel for frame in rig.transport.emitted} <= {
                "yield:created",
                "mark:added",
                "browse:resources-requested",
                "weave:applied",
            }
            assert written((await rig.views.get_resource_annotations(R1))[0])["id"] == "ann-1"

    run(scenario())
