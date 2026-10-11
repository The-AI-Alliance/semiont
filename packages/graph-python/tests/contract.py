"""What every store does, whichever database it asks: the contract a `GraphDatabase` is held to.

One set of cases, run against the in-memory store (`test_memory.py`) and
against a real neo4j (`neo4j_live.py`). A case that passed on a fake and not
on a database is how the TypeScript stores were found to disagree, so nothing
here is run against a fake of a database's client.
"""

import itertools
from collections.abc import Awaitable, Callable

import pytest
from aio import run
from pydantic import JsonValue
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.types import Annotation, ResourceDescriptor

from semiont_graph.codec import intended_graph_annotation
from semiont_graph.interface import GraphDatabase, ResourceChange, ResourceQuery

ADA: dict[str, JsonValue] = {"@type": "Person", "@id": "did:web:example.org:users:ada"}
MODEL: dict[str, JsonValue] = {
    "@type": "Software",
    "@id": "did:web:example.org:agents:anthropic:model",
    "name": "anthropic model",
    "provider": "anthropic",
    "model": "model",
}
AUTHORED = "2020-03-04T05:06:07.000Z"

_NEXT = itertools.count(1)


def rid(name: str) -> ResourceId:
    """A resource id no other case of this run has."""
    return ResourceId(f"{name}-{next(_NEXT)}")


def aid(name: str) -> AnnotationId:
    """An annotation id no other case of this run has."""
    return AnnotationId(f"{name}-{next(_NEXT)}")


def resource(resource_id: ResourceId, **fields: JsonValue) -> ResourceDescriptor:
    """A resource as the Weaver gives one to the graph: what its fold builds from a `yield:created`, and no more."""
    stated: dict[str, JsonValue] = {
        "@context": "https://schema.org/",
        "@id": resource_id,
        "name": "Test Resource",
        "entityTypes": ["Person"],
        "representations": [{"mediaType": "text/plain", "checksum": "sha256:test-content", "rel": "original"}],
        "archived": False,
        "dateCreated": AUTHORED,
        "wasAttributedTo": ADA,
    }
    return ResourceDescriptor.model_validate({**stated, **fields})


def annotation(annotation_id: AnnotationId, on: ResourceId, motivation: str, **fields: JsonValue) -> Annotation:
    stated: dict[str, JsonValue] = {
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": annotation_id,
        "motivation": motivation,
        "target": {"source": on, "selector": {"type": "TextQuoteSelector", "exact": "some words"}},
        "creator": ADA,
        "created": AUTHORED,
    }
    return Annotation.model_validate({**stated, **fields})


def highlight(on: ResourceId, **fields: JsonValue) -> Annotation:
    return annotation(aid("highlight"), on, "highlighting", **fields)


def tag(value: str) -> JsonValue:
    return {"type": "TextualBody", "value": value, "purpose": "tagging"}


def link(to: ResourceId) -> JsonValue:
    return {"type": "SpecificResource", "source": to, "purpose": "linking"}


def reference(on: ResourceId, to: ResourceId | None, *tags: str, **fields: JsonValue) -> Annotation:
    """A reference on a resource: its entity tags, and its link when it is bound."""
    body: list[JsonValue] = [*(tag(value) for value in tags), *(() if to is None else (link(to),))]
    return annotation(aid("reference"), on, "linking", **({"body": body} if body else {}), **fields)


def ids(annotations: list[Annotation]) -> list[str]:
    return [str(held.id) for held in annotations]


def names(resources: list[ResourceDescriptor]) -> list[str]:
    return [held.name for held in resources]


async def each_stored(db: GraphDatabase, *resources: ResourceDescriptor) -> None:
    """Store each of `resources`."""
    for each in resources:
        await db.create_resource(each)


type Scenario = Callable[[GraphDatabase], Awaitable[None]]


class GraphContract:
    """The cases. A store's own test module subclasses this and says how its store is made."""

    def make(self) -> GraphDatabase:
        raise NotImplementedError

    def held(self, scenario: Scenario) -> None:
        """Run `scenario` against a connected store that holds nothing, and leave the store holding nothing."""

        async def whole() -> None:
            db = self.make()
            await db.connect()
            try:
                await db.clear_database()
                await scenario(db)
            finally:
                await db.clear_database()
                await db.disconnect()

        run(whole())

    # ── Connecting ─────────────────────────────────────────────────────

    def test_a_store_is_connected_from_connect_to_disconnect(self) -> None:
        async def whole() -> None:
            db = self.make()
            assert not db.is_connected()
            await db.connect()
            assert db.is_connected()
            await db.disconnect()
            assert not db.is_connected()

        run(whole())

    # ── A resource ─────────────────────────────────────────────────────

    def test_a_resource_reads_back_as_it_was_written(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            given = resource(
                rid("written"),
                name="Cedar County, Iowa",
                entityTypes=["Place", "County"],
                representations=[
                    {"mediaType": "text/markdown", "checksum": "sha256:abc", "rel": "original", "storageUri": "file:///kb/cedar.md"}
                ],
                wasAttributedTo=[ADA, MODEL],
            )
            assert await db.create_resource(given) == given
            assert await db.get_resource(given.id) == given

        self.held(scenario)

    def test_a_resource_with_no_storage_location_reads_back_with_none(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            given = resource(rid("unstored"))
            await db.create_resource(given)
            read = await db.get_resource(given.id)
            assert read is not None
            assert written(read)["representations"] == [{"mediaType": "text/plain", "checksum": "sha256:test-content", "rel": "original"}]

        self.held(scenario)

    def test_a_resource_the_graph_does_not_hold_is_none(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            assert await db.get_resource(rid("nobody")) is None

        self.held(scenario)

    def test_a_resource_written_again_is_the_same_one_resource(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            again = rid("again")
            await db.create_resource(resource(again))
            await db.create_resource(resource(again, name="Renamed"))
            listing = await db.list_resources(ResourceQuery())
            assert names(listing.resources) == ["Renamed"]
            assert listing.total == 1

        self.held(scenario)

    def test_a_resource_that_lacks_what_the_graph_holds_of_one_is_refused(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            with pytest.raises(ValueError, match="wasAttributedTo"):
                await db.create_resource(resource(rid("unattributed"), wasAttributedTo=None))
            with pytest.raises(ValueError, match="representations"):
                await db.create_resource(resource(rid("bodiless"), representations=[]))

        self.held(scenario)

    def test_archiving_and_entity_types_are_what_may_change_of_a_resource(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            given = resource(rid("changing"))
            await db.create_resource(given)

            archived = await db.update_resource(given.id, ResourceChange(archived=True))
            assert archived.archived is True
            assert archived.entity_types == ["Person"]

            tagged = await db.update_resource(given.id, ResourceChange(entity_types=["Person", "Author"]))
            assert tagged.entity_types == ["Person", "Author"]
            assert tagged.archived is True
            assert await db.get_resource(given.id) == tagged
            assert tagged.model_copy(update={"archived": False, "entity_types": ["Person"]}) == given

            untagged = await db.update_resource(given.id, ResourceChange(entity_types=[]))
            assert untagged.entity_types == []

        self.held(scenario)

    def test_a_change_that_names_nothing_is_refused_and_so_is_one_to_a_resource_not_held(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            with pytest.raises(ValueError, match="immutable"):
                ResourceChange()
            with pytest.raises(LookupError):
                await db.update_resource(rid("nobody"), ResourceChange(archived=True))

        self.held(scenario)

    # ── A listing ──────────────────────────────────────────────────────

    def test_a_listing_filters_by_entity_type_search_and_archived_and_totals_every_match(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            await db.create_resource(resource(rid("a"), name="Alpha report", entityTypes=["Person"]))
            await db.create_resource(resource(rid("b"), name="Beta report", entityTypes=["Place"], archived=True))
            await db.create_resource(resource(rid("c"), name="Gamma notes", entityTypes=["Place", "Event"]))

            assert sorted(names((await db.list_resources(ResourceQuery(entity_types=["Place"]))).resources)) == [
                "Beta report",
                "Gamma notes",
            ]
            assert sorted(names((await db.list_resources(ResourceQuery(entity_types=["Event", "Person"]))).resources)) == [
                "Alpha report",
                "Gamma notes",
            ]
            assert sorted(names((await db.list_resources(ResourceQuery(search="REPORT"))).resources)) == ["Alpha report", "Beta report"]
            assert names((await db.list_resources(ResourceQuery(archived=True))).resources) == ["Beta report"]
            assert sorted(names((await db.list_resources(ResourceQuery(archived=False))).resources)) == ["Alpha report", "Gamma notes"]
            assert names((await db.list_resources(ResourceQuery(search="report", entity_types=["Place"], archived=True))).resources) == [
                "Beta report"
            ]
            assert (await db.list_resources(ResourceQuery(search="nothing has this"))).resources == []

            page = await db.list_resources(ResourceQuery(search="report", limit=1))
            assert len(page.resources) == 1
            assert page.total == 2
            beyond = await db.list_resources(ResourceQuery(offset=10))
            assert beyond.resources == []
            assert beyond.total == 3

        self.held(scenario)

    def test_a_listing_is_newest_first_and_by_id_where_two_were_created_at_one_moment(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            await db.create_resource(resource(ResourceId("order-old"), name="Oldest", dateCreated="2020-01-01T00:00:00.000Z"))
            await db.create_resource(resource(ResourceId("order-new"), name="Newest", dateCreated="2026-01-01T00:00:00.000Z"))
            await db.create_resource(resource(ResourceId("order-mid"), name="Middle", dateCreated="2023-01-01T00:00:00.000Z"))
            assert names((await db.list_resources(ResourceQuery())).resources) == ["Newest", "Middle", "Oldest"]

            # Inserted out of the order of their ids: the order they were inserted in must not show.
            for tied in ("tie-c", "tie-a", "tie-d", "tie-b"):
                await db.create_resource(resource(ResourceId(tied), name=f"Tied {tied}", dateCreated="2019-01-01T00:00:00.000Z"))
            first = await db.list_resources(ResourceQuery(search="Tied", limit=2, offset=0))
            second = await db.list_resources(ResourceQuery(search="Tied", limit=2, offset=2))
            assert [str(held.id) for held in [*first.resources, *second.resources]] == ["tie-a", "tie-b", "tie-c", "tie-d"]

        self.held(scenario)

    def test_a_search_ranks_a_name_that_is_it_then_begins_with_it_then_has_it_then_the_rest(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            # The dates run against the order expected, so only the ranking can give it.
            await db.create_resource(resource(rid("rank"), name="Notes about Marathon", dateCreated="2026-04-01T00:00:00.000Z"))
            await db.create_resource(
                resource(
                    rid("rank"),
                    name="Greek victory",
                    dateCreated="2026-03-01T00:00:00.000Z",
                    representations=[
                        {"mediaType": "text/plain", "checksum": "sha256:c", "rel": "original", "storageUri": "file://places/Marathon.md"}
                    ],
                )
            )
            await db.create_resource(resource(rid("rank"), name="Marathon", dateCreated="2020-01-01T00:00:00.000Z"))
            await db.create_resource(resource(rid("rank"), name="Marathon Chronicle", dateCreated="2021-01-01T00:00:00.000Z"))
            await db.create_resource(resource(rid("rank"), name="Marathon Annals", dateCreated="2022-01-01T00:00:00.000Z"))

            assert names((await db.list_resources(ResourceQuery(search="Marathon"))).resources) == [
                "Marathon",
                # Within a rank, newest first.
                "Marathon Annals",
                "Marathon Chronicle",
                "Notes about Marathon",
                "Greek victory",
            ]

        self.held(scenario)

    def test_a_search_needs_every_word_in_any_order_from_the_name_the_location_or_an_entity_type(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            def at(location: str) -> JsonValue:
                return [{"mediaType": "text/plain", "checksum": "sha256:c", "rel": "original", "storageUri": location}]

            await db.create_resource(
                resource(rid("words"), name="Greek victory", representations=at("file://authors/Aeschylus/places/Marathon.md"))
            )
            # One word and not the other: every word is needed.
            await db.create_resource(
                resource(rid("words"), name="Aeschylus alone", representations=at("file://authors/Aeschylus/index.md"))
            )
            await db.create_resource(resource(rid("words"), name="Battle of Marathon", dateCreated="2021-01-01T00:00:00.000Z"))
            await db.create_resource(resource(rid("words"), name="Herodotus", entityTypes=["Historian"]))

            assert names((await db.list_resources(ResourceQuery(search="Aeschylus Marathon"))).resources) == ["Greek victory"]
            assert names((await db.list_resources(ResourceQuery(search="marathon battle"))).resources) == ["Battle of Marathon"]
            assert names((await db.list_resources(ResourceQuery(search="historian"))).resources) == ["Herodotus"]
            # A search of only white space is no search: a bare match on a space would keep every name that has one.
            assert (await db.list_resources(ResourceQuery(search="   "))).total == 4

        self.held(scenario)

    # ── An annotation ──────────────────────────────────────────────────

    def test_an_annotation_reads_back_as_the_codec_says_the_graph_holds_it(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on, to = resource(rid("on")), resource(rid("to"))
            await each_stored(db, on, to)
            given = reference(
                on.id,
                to.id,
                "Place",
                "Person",
                generator=MODEL,
                modified="2021-01-02T03:04:05.000Z",
                creator={**ADA, "name": "Ada"},
                wasAttributedTo=[ADA, MODEL],
            )

            stored = await db.create_annotation(given)

            assert stored == intended_graph_annotation(given)
            assert await db.get_annotation(given.id) == stored
            # Tags in the one order, then the link; a person without the name; nothing of the attribution.
            assert written(stored)["body"] == [tag("Person"), tag("Place"), link(to.id)]
            assert written(stored)["creator"] == ADA
            assert written(stored)["generator"] == MODEL
            assert stored.created == AUTHORED
            assert stored.modified == "2021-01-02T03:04:05.000Z"
            assert stored.was_attributed_to is None

        self.held(scenario)

    def test_an_annotation_of_a_whole_resource_has_no_selector_and_a_highlight_no_body(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on = resource(rid("on"))
            await db.create_resource(on)
            whole = await db.create_annotation(annotation(aid("whole"), on.id, "linking", target={"source": on.id}))
            assert written(whole)["target"] == {"source": on.id}

            noted = await db.create_annotation(
                highlight(on.id, body={"type": "TextualBody", "value": "A note", "format": "text/plain", "purpose": "commenting"})
            )
            assert noted.body is None
            assert await db.get_annotation(noted.id) == noted

        self.held(scenario)

    def test_an_annotation_the_graph_does_not_hold_is_none(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            assert await db.get_annotation(aid("nobody")) is None

        self.held(scenario)

    def test_an_annotation_with_no_creator_or_on_a_resource_not_held_is_refused(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on = resource(rid("on"))
            await db.create_resource(on)
            with pytest.raises(ValueError, match="creator"):
                await db.create_annotation(highlight(on.id, creator=None))
            with pytest.raises(LookupError, match="not found"):
                await db.create_annotation(highlight(rid("nobody")))

        self.held(scenario)

    def test_a_deleted_annotation_is_gone_and_deleting_one_not_held_is_nothing(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on, to = resource(rid("on")), resource(rid("to"))
            await each_stored(db, on, to)
            made = await db.create_annotation(reference(on.id, to.id, "Person"))

            await db.delete_annotation(made.id)
            await db.delete_annotation(aid("nobody"))

            assert await db.get_annotation(made.id) is None
            assert await db.get_resource_referenced_by(to.id, None) == []
            assert await db.get_resource_connections(on.id) == []

        self.held(scenario)

    def test_the_annotations_on_a_resource_and_those_that_link_to_it_are_answered_newest_first(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on, to = resource(rid("on")), resource(rid("to"))
            await each_stored(db, on, to)
            old = await db.create_annotation(reference(on.id, to.id, created="2020-01-01T00:00:00.000Z"))
            new = await db.create_annotation(reference(on.id, to.id, created="2022-01-01T00:00:00.000Z"))
            mid = await db.create_annotation(highlight(on.id, created="2021-01-01T00:00:00.000Z"))
            elsewhere = await db.create_annotation(highlight(to.id))

            assert ids(await db.get_resource_annotations(on.id)) == ids([new, mid, old])
            assert ids(await db.get_resource_annotations(to.id)) == ids([elsewhere])
            assert ids(await db.get_resource_referenced_by(to.id, None)) == ids([new, old])
            assert ids(await db.get_resource_referenced_by(to.id, "linking")) == ids([new, old])
            assert await db.get_resource_referenced_by(to.id, "highlighting") == []
            assert await db.get_resource_referenced_by(on.id, None) == []

        self.held(scenario)

    # ── An update ──────────────────────────────────────────────────────

    def test_an_updated_body_reads_back_its_link_and_its_tags(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on, to = resource(rid("on")), resource(rid("to"))
            await each_stored(db, on, to)
            made = await db.create_annotation(reference(on.id, None))

            updated = await db.update_annotation(made.id, {"body": [tag("Person"), link(to.id)], "modified": "2021-01-02T03:04:05.000Z"})

            assert written(updated)["body"] == [tag("Person"), link(to.id)]
            assert updated.modified == "2021-01-02T03:04:05.000Z"
            assert updated.created == AUTHORED
            assert await db.get_annotation(made.id) == updated
            assert ids(await db.get_resource_referenced_by(to.id, None)) == [made.id]
            assert [str(held.target_resource.id) for held in await db.get_resource_connections(on.id)] == [to.id]

        self.held(scenario)

    def test_a_link_or_a_tag_the_body_has_lost_is_followed_and_kept_no_longer(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on, to, other = resource(rid("on")), resource(rid("to")), resource(rid("other"))
            await each_stored(db, on, to, other)
            made = await db.create_annotation(reference(on.id, to.id, "Person", "Place"))

            relinked = await db.update_annotation(made.id, {"body": [tag("Place"), link(other.id)]})
            assert written(relinked)["body"] == [tag("Place"), link(other.id)]
            assert await db.get_resource_referenced_by(to.id, None) == []
            assert ids(await db.get_resource_referenced_by(other.id, None)) == [made.id]

            emptied = await db.update_annotation(made.id, {"body": []})
            assert emptied.body is None
            read = await db.get_annotation(made.id)
            assert read is not None
            assert read.body is None
            assert await db.get_resource_referenced_by(other.id, None) == []
            assert (await db.get_stats()).entity_reference_count == 0

        self.held(scenario)

    def test_an_update_that_names_nothing_changes_nothing_and_one_cannot_rename_or_move_an_annotation(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on, other = resource(rid("on")), resource(rid("other"))
            await each_stored(db, on, other)
            made = await db.create_annotation(reference(on.id, None, "Person"))

            assert await db.update_annotation(made.id, {}) == made
            assert (await db.update_annotation(made.id, {"id": "another-name"})).id == made.id
            with pytest.raises(ValueError, match="cannot move it"):
                await db.update_annotation(made.id, {"target": {"source": other.id}})
            assert await db.get_annotation(made.id) == made
            with pytest.raises(LookupError):
                await db.update_annotation(aid("nobody"), {"body": []})

        self.held(scenario)

    def test_resolving_a_reference_replaces_its_link_and_keeps_its_tags(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on, first, second = resource(rid("on")), resource(rid("first")), resource(rid("second"))
            await each_stored(db, on, first, second)
            made = await db.create_annotation(reference(on.id, None, "Person"))

            resolved = await db.resolve_reference(made.id, first.id)
            assert written(resolved)["body"] == [tag("Person"), link(first.id)]
            assert await db.get_annotation(made.id) == resolved
            assert resolved.modified is None

            again = await db.resolve_reference(made.id, second.id)
            assert written(again)["body"] == [tag("Person"), link(second.id)]
            assert await db.get_resource_referenced_by(first.id, None) == []
            with pytest.raises(LookupError):
                await db.resolve_reference(aid("nobody"), first.id)

        self.held(scenario)

    # ── A link's target the graph has not been given yet ───────────────

    def test_a_link_to_a_resource_not_yet_held_is_kept_and_followed_once_the_resource_arrives(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on, unseen, later = resource(rid("on")), rid("unseen"), rid("later")
            await db.create_resource(on)
            # Made with the link, and given the link by an update: the one rule for both.
            made = await db.create_annotation(reference(on.id, unseen))
            bound = await db.create_annotation(reference(on.id, None))
            await db.update_annotation(bound.id, {"body": [link(later)]})

            assert written(made)["body"] == [link(unseen)]
            # It is not a resource the graph has: not read, not listed, not counted, and no connection.
            assert await db.get_resource(unseen) is None
            assert (await db.list_resources(ResourceQuery())).total == 1
            assert (await db.get_stats()).resource_count == 1
            assert await db.get_resource_connections(on.id) == []
            assert await db.find_path(on.id, unseen, 5) == []
            assert ids(await db.get_resource_referenced_by(unseen, None)) == [made.id]

            arrived = resource(unseen)
            assert await db.create_resource(arrived) == arrived
            await db.create_resource(resource(later))
            connections = await db.get_resource_connections(on.id)
            assert sorted(str(held.target_resource.id) for held in connections) == sorted([unseen, later])
            assert (await db.get_stats()).resource_count == 3

        self.held(scenario)

    # ── Deleting a resource ────────────────────────────────────────────

    def test_deleting_a_resource_removes_it_and_the_annotations_on_it(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            gone, other = resource(rid("gone")), resource(rid("other"))
            await each_stored(db, gone, other)
            own = await db.create_annotation(highlight(gone.id))
            outward = await db.create_annotation(reference(gone.id, other.id, "Person"))
            kept = await db.create_annotation(highlight(other.id))

            await db.delete_resource(gone.id)
            await db.delete_resource(rid("nobody"))

            assert await db.get_resource(gone.id) is None
            assert await db.get_annotation(own.id) is None
            assert await db.get_annotation(outward.id) is None
            assert await db.get_resource_annotations(gone.id) == []
            assert await db.get_resource_referenced_by(other.id, None) == []
            assert await db.get_annotation(kept.id) == kept
            assert (await db.get_stats()).resource_count == 1

        self.held(scenario)

    def test_deleting_a_resource_leaves_another_resources_link_to_it_which_is_followed_when_it_is_made_again(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            gone, other = resource(rid("gone")), resource(rid("other"))
            await each_stored(db, gone, other)
            inward = await db.create_annotation(reference(other.id, gone.id))

            await db.delete_resource(gone.id)

            read = await db.get_annotation(inward.id)
            assert read is not None
            assert written(read)["body"] == [link(gone.id)]
            assert ids(await db.get_resource_annotations(other.id)) == [inward.id]
            assert await db.get_resource_connections(other.id) == []

            await db.create_resource(gone)
            assert ids(await db.get_resource_referenced_by(gone.id, None)) == [inward.id]
            assert [str(held.target_resource.id) for held in await db.get_resource_connections(other.id)] == [gone.id]

        self.held(scenario)

    # ── Connections and paths ──────────────────────────────────────────

    def test_a_connection_is_one_for_each_resource_linked_to_with_every_annotation_that_links_to_it(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            here, there, back = resource(rid("here")), resource(rid("there")), resource(rid("back"))
            await each_stored(db, here, there, back)
            older = await db.create_annotation(reference(here.id, there.id, "Person", created="2020-01-01T00:00:00.000Z"))
            newer = await db.create_annotation(reference(here.id, there.id, created="2021-01-01T00:00:00.000Z"))
            mutual = await db.create_annotation(reference(here.id, back.id))
            await db.create_annotation(reference(back.id, here.id))
            # A highlight links to nothing, and a reference not bound links to nothing yet.
            await db.create_annotation(highlight(here.id))
            await db.create_annotation(reference(here.id, None, "Person"))

            connections = {str(held.target_resource.id): held for held in await db.get_resource_connections(here.id)}

            assert sorted(connections) == sorted([there.id, back.id])
            assert connections[there.id].target_resource == there
            assert sorted(ids(connections[there.id].annotations)) == sorted(ids([older, newer]))
            assert connections[there.id].annotations[0] in (older, newer)
            assert not connections[there.id].bidirectional
            assert ids(connections[back.id].annotations) == [mutual.id]
            assert connections[back.id].bidirectional
            assert await db.get_resource_connections(there.id) == []

        self.held(scenario)

    def test_a_path_follows_links_forwards_and_counts_the_resources_on_it_against_its_depth(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            a, b, c, apart = resource(rid("a")), resource(rid("b")), resource(rid("c")), resource(rid("apart"))
            await each_stored(db, a, b, c, apart)
            a_to_b = await db.create_annotation(reference(a.id, b.id))
            b_to_c = await db.create_annotation(reference(b.id, c.id, "Person"))
            # A way round: the shortest is still the one of two links.
            await db.create_annotation(reference(c.id, a.id))

            (found,) = await db.find_path(a.id, c.id, 5)
            assert found.resources == [a, b, c]
            assert found.annotations == [a_to_b, b_to_c]

            (direct,) = await db.find_path(c.id, a.id, 2)
            assert direct.resources == [c, a]
            (itself,) = await db.find_path(a.id, a.id, 5)
            assert itself.resources == [a]
            assert itself.annotations == []

            # Three resources are on the way from a to c: it is not found at a depth of two.
            assert await db.find_path(a.id, c.id, 2) == []
            assert len(await db.find_path(a.id, c.id, 3)) == 1
            assert await db.find_path(a.id, apart.id, 5) == []
            assert await db.find_path(apart.id, a.id, 5) == []
            assert await db.find_path(rid("nobody"), a.id, 5) == []
            assert await db.find_path(a.id, c.id, 0) == []

        self.held(scenario)

    # ── Counting ───────────────────────────────────────────────────────

    def test_what_the_graph_holds_is_counted(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            person = resource(rid("person"), entityTypes=["Person", "Author"])
            place = resource(rid("place"), entityTypes=["Place"], representations=[{"mediaType": "text/markdown", "checksum": "sha256:m"}])
            other = resource(rid("other"), entityTypes=["Person"])
            await each_stored(db, person, place, other)
            await db.create_annotation(highlight(person.id))
            await db.create_annotation(highlight(person.id))
            await db.create_annotation(reference(person.id, place.id, "Place"))
            await db.create_annotation(reference(person.id, None, "Person"))
            await db.create_annotation(reference(person.id, other.id))
            await db.create_annotation(annotation(aid("comment"), place.id, "commenting"))

            stats = await db.get_stats()
            assert stats.resource_count == 3
            assert stats.annotation_count == 6
            assert stats.highlight_count == 2
            assert stats.reference_count == 3
            assert stats.entity_reference_count == 2
            assert stats.entity_types == {"Person": 2, "Author": 1, "Place": 1}
            assert stats.content_types == {"text/plain": 2, "text/markdown": 1}

            counted = await db.get_entity_type_stats()
            assert [(held.type, held.count) for held in counted] == [("Person", 2), ("Author", 1), ("Place", 1)]

        self.held(scenario)

    # ── The vocabulary ─────────────────────────────────────────────────

    def test_the_vocabulary_is_what_every_knowledge_base_starts_with_and_each_type_added_sorted(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            start = await db.get_entity_types()
            assert "Person" in start
            assert start == sorted(start)

            await db.add_entity_type("Zebra")
            await db.add_entity_type("Aardvark")
            await db.add_entity_type("Zebra")
            await db.add_entity_types(["Mango", "Aardvark"])
            await db.add_entity_types([])

            assert await db.get_entity_types() == sorted({*start, "Zebra", "Aardvark", "Mango"})

        self.held(scenario)

    def test_the_vocabulary_is_the_databases_and_not_one_connections(self) -> None:
        async def whole() -> None:
            first = self.make()
            await first.connect()
            try:
                await first.clear_database()
                await first.add_entity_type("Kept")
            finally:
                await first.disconnect()
            second = self.shared_with(first)
            if second is None:
                return
            await second.connect()
            try:
                assert "Kept" in await second.get_entity_types()
            finally:
                await second.clear_database()
                await second.disconnect()

        run(whole())

    def shared_with(self, first: GraphDatabase) -> GraphDatabase | None:
        """Another store on the database `first` is on. None for a store whose graph is its own process's."""
        del first
        return None

    # ── Everything ─────────────────────────────────────────────────────

    def test_clearing_removes_everything_the_vocabulary_added_included(self) -> None:
        async def scenario(db: GraphDatabase) -> None:
            on = resource(rid("on"))
            await db.create_resource(on)
            await db.create_annotation(highlight(on.id))
            await db.add_entity_type("Custom")
            start = sorted(set(await db.get_entity_types()) - {"Custom"})

            await db.clear_database()

            stats = await db.get_stats()
            assert stats.resource_count == 0
            assert stats.annotation_count == 0
            assert await db.get_entity_types() == start
            assert await db.get_annotation(aid("nobody")) is None

        self.held(scenario)
