"""The Weaver, over a transport a test scripts and a graph in the process: its order, its marks, and its three repairs.

What each event does to the graph is the table's to hold
(`test_fold_cases.py`), and what a Weaver process does behind a real gateway,
a real Archivist and a real database is the conformance suite's
(`tests/conformance/weaver`). Here is what neither reaches: a store that
fails, a record that was rewound, a view the record cannot account for, and
what is kept across a restart.
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

from semiont_weaver.weaver import CaughtUp, Reconciled

R1, R2 = ResourceId("res-1"), ResourceId("res-2")


def reasons(caplog: pytest.LogCaptureFixture) -> list[object]:
    """Why reconcile called each resource divergent, as it logged it."""
    return [vars(record)["reason"] for record in caplog.records if record.getMessage().startswith("Reconcile divergence")]


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
            assert rig.signalled() == {"res-1": [1, 2, 3]}

    run(scenario())


def test_a_removal_delivered_after_the_making_it_removes_is_applied_after_it() -> None:
    # The two are on two channels. Read a channel at a time they could be handed on in either order, and the
    # making would be passed by as one delivered again.
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), added("res-1", 2, "ann-1"), added("res-1", 3, "ann-2"), removed("res-1", 4, "ann-1"))
            assert [annotation.id for annotation in await rig.graph.get_resource_annotations(R1)] == ["ann-2"]
            assert rig.weaver.applied() == {"res-1": 4}

    run(scenario())


def test_a_frame_on_a_followed_channel_that_is_no_recorded_event_is_said_and_passed_by(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            rig.transport.deliver(Frame(channel="mark:added", payload={"not": "an event"}))
            await rig.happened(created("res-1"))
            assert rig.weaver.applied() == {"res-1": 1}
            assert rig.weaver.apply_failures == 0

    with caplog.at_level(logging.ERROR, logger="semiont_weaver"):
        run(scenario())
    assert [record.getMessage() for record in caplog.records] == ["A frame on a followed channel is not a recorded event"]


def test_an_event_the_weaver_does_not_follow_changes_nothing_and_is_passed_when_a_history_is_replayed() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            # A resource's history holds events that are the views' alone.
            await rig.recorded(created("res-1"), event("yield:updated", "res-1", 2, {"name": "Renamed"}), tagged("res-1", 3, "Place"))
            caught_up = await rig.weaver.catch_up()
            assert caught_up.events_replayed == 3
            assert caught_up.events_failed == 0
            assert rig.weaver.applied() == {"res-1": 3}
            await rig.same_as_the_views()

    run(scenario())


# ── A stream that drops ────────────────────────────────────────────────


async def turns() -> None:
    """Give the Weaver turns enough to go on with whatever it could: what a scenario does before it says something did not happen."""
    for _ in range(200):
        await asyncio.sleep(0)


def test_what_is_recorded_while_the_stream_is_down_is_applied_by_the_catch_up_when_it_opens_again() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"))

            # The stream drops, and what is recorded meanwhile is never delivered.
            rig.transport.set_state("reconnecting")
            await rig.recorded(archived("res-1", 2), tagged("res-1", 3, "Place"))
            reopening = asyncio.ensure_future(rig.weaver.reopened())
            await turns()
            assert not reopening.done()
            assert rig.weaver.applied() == {"res-1": 1}

            # It opens again: a catch-up is due, and finds the two.
            rig.transport.set_state("connecting")
            rig.transport.set_state("open")
            await asyncio.wait_for(reopening, timeout=5)
            caught_up = await rig.weaver.catch_up()

            assert caught_up.events_replayed == 2
            assert rig.weaver.applied() == {"res-1": 3}
            await rig.same_as_the_views()

    run(scenario())


def test_drops_that_came_before_it_is_awaited_make_one_reopening() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            for _ in range(2):
                rig.transport.set_state("reconnecting")
                rig.transport.set_state("connecting")
                rig.transport.set_state("open")
                await turns()

            await asyncio.wait_for(rig.weaver.reopened(), timeout=5)
            again = asyncio.ensure_future(rig.weaver.reopened())
            await turns()
            try:
                assert not again.done()
            finally:
                again.cancel()
                await asyncio.gather(again, return_exceptions=True)

    run(scenario())


# ── The marks ──────────────────────────────────────────────────────────


def test_a_store_that_fails_holds_the_mark_below_the_event_and_catch_up_applies_it(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            update = rig.graph.update_resource

            async def unreachable(resource_id: ResourceId, change: ResourceChange) -> ResourceDescriptor:
                if change.archived is not None:
                    raise ConnectionError("the database did not answer")
                return await update(resource_id, change)

            monkeypatch.setattr(rig.graph, "update_resource", unreachable)
            await rig.happened(created("res-1"), archived("res-1", 2), tagged("res-1", 3, "Place"))

            # The event after the one that failed is applied, and the mark does not pass the one that failed.
            assert rig.weaver.applied() == {"res-1": 1}
            assert rig.weaver.apply_failures == 1
            assert rig.signalled() == {"res-1": [1]}
            held = await rig.graph.get_resource(R1)
            assert held is not None
            assert (held.archived, held.entity_types) == (False, ["Place"])

            monkeypatch.setattr(rig.graph, "update_resource", update)
            caught_up = await rig.weaver.catch_up()

            assert caught_up == CaughtUp(resources_checked=1, events_replayed=2, resources_rebuilt=0, events_failed=0, parity_pending=0)
            assert rig.weaver.applied() == {"res-1": 3}
            assert rig.signalled() == {"res-1": [1, 2, 3]}
            await rig.same_as_the_views()

    run(scenario())


def test_what_catch_up_could_not_apply_is_reported_and_holds_the_mark(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.recorded(created("res-1"), archived("res-1", 2), created("res-2"))

            async def unreachable(resource_id: ResourceId, change: ResourceChange) -> ResourceDescriptor:
                raise ConnectionError("the database did not answer")

            monkeypatch.setattr(rig.graph, "update_resource", unreachable)
            caught_up = await rig.weaver.catch_up()

            assert caught_up == CaughtUp(resources_checked=2, events_replayed=3, resources_rebuilt=0, events_failed=1, parity_pending=1)
            assert rig.weaver.applied() == {"res-1": 1, "res-2": 1}

    run(scenario())


# ── Catch-up ───────────────────────────────────────────────────────────


def test_catch_up_with_nothing_kept_applies_the_whole_record_and_keeps_its_marks() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.recorded(
                created("res-1"), added("res-1", 2, "ann-1", tag("Person"), link("res-2")), created("res-2"), archived("res-2", 2)
            )

            caught_up = await rig.weaver.catch_up()

            assert caught_up == CaughtUp(resources_checked=2, events_replayed=4, resources_rebuilt=0, events_failed=0, parity_pending=0)
            await rig.same_as_the_views()
            assert rig.signalled() == {"res-1": [1, 2], "res-2": [1, 2]}
            assert json.loads(rig.kept.read_bytes()) == {"res-1": 2, "res-2": 2}

    run(scenario())


def test_catch_up_applies_only_what_was_recorded_since_the_marks_it_kept(tmp_path: Path) -> None:
    async def scenario() -> None:
        kept = tmp_path / "marks.json"
        async with Rig(kept=kept) as first:
            await first.happened(created("res-1"), tagged("res-1", 2, "Place"), created("res-2"))
        # Stopped, it kept its marks.
        assert json.loads(kept.read_bytes()) == {"res-1": 2, "res-2": 1}

        async with Rig(kept=kept, after=first) as second:
            # Recorded while no Weaver was running.
            await second.recorded(archived("res-1", 3), created("res-3"))

            caught_up = await second.weaver.catch_up()

            assert caught_up == CaughtUp(resources_checked=3, events_replayed=2, resources_rebuilt=0, events_failed=0, parity_pending=0)
            assert second.signalled() == {"res-1": [3], "res-3": [1]}
            await second.same_as_the_views()

    run(scenario())


def test_marks_that_cannot_be_read_are_no_marks_and_the_whole_record_is_applied(tmp_path: Path) -> None:
    async def scenario() -> None:
        kept = tmp_path / "marks.json"
        kept.write_text("{ this is not JSON", encoding="utf-8")
        async with Rig(kept=kept) as rig:
            await rig.recorded(created("res-1"), tagged("res-1", 2, "Place"))
            assert (await rig.weaver.catch_up()).events_replayed == 2
            await rig.same_as_the_views()

    run(scenario())


def test_a_mark_above_the_records_last_event_means_the_record_was_rewound_and_the_resource_is_rebuilt(tmp_path: Path) -> None:
    async def scenario() -> None:
        kept = tmp_path / "marks.json"
        async with Rig(kept=kept) as first:
            await first.happened(created("res-1"), tagged("res-1", 2, "Place"), tagged("res-1", 3, "Stale"), added("res-1", 4, "ann-stale"))
        assert json.loads(kept.read_bytes()) == {"res-1": 4}

        async with Rig(kept=kept, after=first) as second:
            # The record is put back to where it was after its second event. Its views are made again from it.
            del second.record["res-1"][2:]
            await second.views.clear_database()
            for stored in second.record.pop("res-1"):
                await second.recorded(stored)

            caught_up = await second.weaver.catch_up()

            assert caught_up == CaughtUp(resources_checked=1, events_replayed=0, resources_rebuilt=1, events_failed=0, parity_pending=0)
            assert second.weaver.applied() == {"res-1": 2}
            await second.same_as_the_views()
            assert await second.graph.get_annotation(AnnotationId("ann-stale")) is None

    run(scenario())


def test_catch_up_asks_for_the_catalog_again_while_the_archivist_is_not_there() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.recorded(created("res-1"))
            rig.unanswered.add("browse:resources-requested")
            asking = asyncio.ensure_future(rig.weaver.catch_up())
            await asyncio.sleep(0.05)
            assert not asking.done()

            rig.unanswered.clear()
            caught_up = await asking

            assert caught_up.events_replayed == 1
            assert [entry.channel for entry in rig.transport.request_log].count("browse:resources-requested") == 2

    run(scenario())


# ── Reconcile ──────────────────────────────────────────────────────────


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


def test_a_heal_that_leaves_an_event_not_applied_is_no_heal() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"))
            # The record holds an annotation with no creator, which the graph refuses.
            rig.record["res-1"].append(added("res-1", 2, "ann-nobodys", creator=None))
            await rig.graph.delete_resource(R1)

            assert await rig.weaver.reconcile() == Reconciled(resources_checked=1, divergent=1, healed=0, heal_failures=1, orphaned=0)
            assert rig.weaver.apply_failures == 1
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
            assert rig.weaver.apply_failures == 0

    run(scenario())


def test_a_rebuild_that_leaves_events_not_applied_answers_that_it_failed_and_says_how_many() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"))
            rig.record["res-1"].append(added("res-1", 2, "ann-nobodys", creator=None))

            rig.transport.deliver(commanded("res-1", "c-1"))
            rig.transport.deliver(commanded(None, "c-2"))
            await rig.settled()

            assert rig.answered("weave:rebuild-ok") == []
            failed = rig.answered("weave:rebuild-failed")
            assert [answer.correlation_id for answer in failed] == ["c-1", "c-2"]
            assert all("rebuild dropped 1 event(s)" in str(answer.payload["message"]) for answer in failed)

    run(scenario())


def test_a_rebuild_the_record_cannot_be_read_for_answers_that_it_failed() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"))
            rig.unanswered.add("browse:events-requested")

            rig.transport.deliver(commanded("res-1", "c-1"))
            await rig.settled()

            (failed,) = rig.answered("weave:rebuild-failed")
            assert failed.correlation_id == "c-1"
            assert written_text(failed) == "nothing answers"

    run(scenario())


def written_text(frame: Frame) -> str:
    message = frame.payload["message"]
    assert isinstance(message, str)
    return message


def test_an_event_that_arrives_while_its_resource_is_rebuilt_is_applied_after_the_rebuild() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), tagged("res-1", 2, "Place"))
            later = archived("res-1", 3)
            await rig.recorded(later)

            # Commanded, and then the event delivered before the Weaver has had a turn: the rebuild is first in the
            # lane, reads a record that holds the event, and the event is then one applied already.
            rebuilding = asyncio.ensure_future(rig.weaver.rebuild_resource(R1))
            rig.deliver(later)
            await rebuilding
            await rig.settled()

            await rig.same_as_the_views()
            assert rig.weaver.applied() == {"res-1": 3}
            assert rig.signalled() == {"res-1": [1, 2, 3]}

    run(scenario())


def test_what_it_holds_of_the_record_is_never_written_back_into_it() -> None:
    async def scenario() -> None:
        async with Rig() as rig:
            await rig.happened(created("res-1"), added("res-1", 2, "ann-1", tag("Person")))
            await rig.weaver.catch_up()
            await rig.weaver.reconcile()
            # It asks two things of the record on the bus and says one: everything else on the bus is somebody else's.
            assert {frame.channel for frame in rig.transport.emitted} <= {
                "yield:created",
                "mark:added",
                "browse:resources-requested",
                "browse:events-requested",
                "weave:applied",
            }
            assert written((await rig.views.get_resource_annotations(R1))[0])["id"] == "ann-1"

    run(scenario())
