"""The work a start plans, held to `specs/src/smelter/reconcile-cases.json`.

It is the table every Smelter runs, so that one index, one catalog and one
anchored-text store come to the same work whoever plans it. A case is run
through the two functions a reconcile plans with, and through nothing else of
the Smelter: `classify_embeddable`, which asks what each catalog resource's
media type means, and `plan_reconcile`. There is no bus and no store here,
and none of the work is done.

The table states a case's work as a set. Planned and stated work are compared
as lists in one order all the same, so that an item planned twice does not
pass for one. The one order the rule states is checked of every plan as it
was planned: no resource is indexed after an annotation on it.

A member of the table or of a case that has no place here fails. An item of
work needs no such place: each is compared whole with a planned one.

After the table's cases comes what no case of it rests on: white space about
which the trimming a language is born with disagrees, entity types stated
twice or in another order, and the words a reconcile's summary is said in.
"""

import re
from collections.abc import Iterable, Sequence
from dataclasses import replace
from typing import Annotated, Final, assert_never

import pytest
from pydantic import BaseModel, Field
from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import Annotation, ResourceDescriptor
from semiont_vectors.store import ResourceStamp
from spec import ROOT, SPEC

from semiont_smelter.reconcile import (
    Embed,
    EmbedAnnotation,
    Purge,
    PurgeAnnotation,
    Reanchor,
    ReconcileSummary,
    Restamp,
    Work,
    classify_embeddable,
    plan_reconcile,
    quotes_text,
)


class Stated(BaseModel, frozen=True, extra="forbid", strict=True):
    """Something the table states: a member of it that has no place here cannot be read, and fails."""


class IndexedResource(Stated, frozen=True):
    """A resource the index holds points for, with what those points carry: no checksum, where none is stated."""

    id: str
    checksum: str | None = None
    entity_types: Annotated[list[str], Field(alias="entityTypes")]


class Index(Stated, frozen=True):
    resources: list[IndexedResource]
    annotations: list[str]


class CatalogAnnotation(Stated, frozen=True):
    """An annotation of the catalog, with the text its target quotes: the empty text when it quotes none."""

    id: str
    quote: str


class CatalogResource(Stated, frozen=True):
    """A resource of the catalog. One that has no representation states no media type, and no checksum."""

    id: str
    media_type: Annotated[str | None, Field(alias="mediaType")] = None
    checksum: str | None = None
    entity_types: Annotated[list[str], Field(alias="entityTypes")]
    annotations: list[CatalogAnnotation]


class Case(Stated, frozen=True):
    why: str
    index: Index
    anchored: list[str]
    catalog: list[CatalogResource]
    # Each item as the table words it, whatever its members: an item is compared whole with a planned one.
    work: list[dict[str, str]]


class Table(Stated, frozen=True):
    comment: Annotated[str, Field(alias="$comment")]
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "smelter/reconcile-cases.json").read_bytes())

R1: Final = ResourceId("res-1")
R2: Final = ResourceId("res-2")
A1: Final = AnnotationId("ann-1")

CHECKSUM: Final = "5f" * 32
"""A checksum as the Archivist writes one. A plan compares it as text, and the table's own are other text."""


# ── What a start hands the plan ───────────────────────────────────────


def described(resource: str, *, media_type: str | None, checksum: str | None, entity_types: Sequence[str]) -> ResourceDescriptor:
    """A resource as the catalog answers one. One that has no media type has no representation, and so no checksum."""
    representations: list[dict[str, str]] = []
    if media_type is None:
        assert checksum is None, f"{resource} states a checksum and no media type: a checksum is a representation's"
    else:
        representations.append({"mediaType": media_type} if checksum is None else {"mediaType": media_type, "checksum": checksum})
    return ResourceDescriptor.model_validate(
        {
            "@context": "https://schema.org",
            "@id": resource,
            "name": f"Name of {resource}",
            "representations": representations,
            "entityTypes": [*entity_types],
        }
    )


def descriptor_of(listed: CatalogResource) -> ResourceDescriptor:
    """A resource the table lists, as the catalog answers one."""
    return described(listed.id, media_type=listed.media_type, checksum=listed.checksum, entity_types=listed.entity_types)


def annotation_on(resource: str, annotation: str, quote: str | None) -> Annotation:
    """An annotation as the Archivist answers one. Its target quotes `quote`, or is the resource as a whole when that is `None`."""
    return Annotation.model_validate(
        {
            "@context": "http://www.w3.org/ns/anno.jsonld",
            "type": "Annotation",
            "id": annotation,
            "motivation": "linking",
            "target": resource if quote is None else {"source": resource, "selector": {"type": "TextQuoteSelector", "exact": quote}},
            "created": "2020-03-04T05:06:07.000Z",
        }
    )


def stamp_of(held: IndexedResource) -> ResourceStamp:
    """What a resource's points say of it, as the index lists it."""
    return ResourceStamp(content_checksum=held.checksum, entity_types=tuple(held.entity_types))


def plan_of(case: Case) -> list[Work]:
    """The plan of a case, from what a start hands it.

    The stamps are as the index lists them, and the resources as the catalog
    answers them. Every annotation of every resource of the catalog is handed
    over with the resource it is on, whatever that resource's media type and
    whatever the annotation quotes.
    """
    live = [(ResourceId(on.id), annotation_on(on.id, each.id, each.quote)) for on in case.catalog for each in on.annotations]
    return plan_reconcile(
        indexed_resources={ResourceId(held.id): stamp_of(held) for held in case.index.resources},
        indexed_annotations={AnnotationId(point) for point in case.index.annotations},
        anchored_keys=frozenset(case.anchored),
        embeddable=classify_embeddable(descriptor_of(listed) for listed in case.catalog),
        live_annotations=live,
    )


# ── The table's words ─────────────────────────────────────────────────


def in_table_words(item: Work) -> dict[str, str]:
    """A planned item as the table words one: the one place the kinds of `Work` meet the table's.

    A kind added to `Work` and given no word here does not type-check.
    """
    match item:
        case Embed():
            return {"kind": "embed", "resource": item.resource}
        case Restamp():
            return {"kind": "restamp", "resource": item.resource}
        case Reanchor():
            return {"kind": "reanchor", "resource": item.resource}
        case Purge():
            return {"kind": "purge", "resource": item.resource}
        case EmbedAnnotation():
            return {"kind": "embed-annotation", "annotation": item.annotation.id, "resource": item.resource}
        case PurgeAnnotation():
            return {"kind": "purge-annotation", "annotation": item.annotation}
        case _:
            assert_never(item)


def in_one_order(work: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    """Work in one order, whatever order it was planned or stated in. A list, so that an item planned twice is not taken for one."""
    return sorted(work, key=lambda item: (item["kind"], item.get("resource", ""), item.get("annotation", "")))


def indexed_after_an_annotation_on_it(plan: Iterable[Work]) -> list[ResourceId]:
    """The resources a plan indexes after it indexes an annotation on them: where the one order the rule states is broken."""
    annotated: set[ResourceId] = set()
    late: list[ResourceId] = []
    for item in plan:
        if isinstance(item, EmbedAnnotation):
            annotated.add(item.resource)
        elif isinstance(item, Embed) and item.resource in annotated:
            late.append(item.resource)
    return late


def each_once(stated: Sequence[str]) -> bool:
    """Whether a list states each thing once."""
    return len(set(stated)) == len(stated)


def plans_both(case: Case) -> bool:
    """Whether a case's work has the indexing of a resource and the indexing of an annotation on it."""
    indexed = {item["resource"] for item in case.work if item["kind"] == "embed"}
    return any(item["kind"] == "embed-annotation" and item["resource"] in indexed for item in case.work)


# ── The table's cases ─────────────────────────────────────────────────


def test_the_runner_found_the_table_s_cases() -> None:
    assert len(TABLE.cases) >= 30


def test_each_case_is_told_from_the_others_by_its_why() -> None:
    assert each_once([case.why for case in TABLE.cases])


def test_every_list_of_a_case_states_each_thing_once() -> None:
    # A case's lists are sets: a thing stated twice would be a case of what the table does not state.
    for case in TABLE.cases:
        lists = [
            [held.id for held in case.index.resources],
            case.index.annotations,
            case.anchored,
            [listed.id for listed in case.catalog],
            [each.id for listed in case.catalog for each in listed.annotations],
            *(held.entity_types for held in case.index.resources),
            *(listed.entity_types for listed in case.catalog),
        ]
        for stated in lists:
            assert each_once(stated), f"{case.why}: {stated}"


def test_some_case_plans_to_index_a_resource_and_an_annotation_on_it() -> None:
    # The order checked of every plan holds nothing unless some plan has both.
    assert any(plans_both(case) for case in TABLE.cases)


def test_the_check_of_the_order_finds_a_resource_indexed_after_an_annotation_on_it() -> None:
    annotation = annotation_on(R1, A1, "Black Hawk")
    assert indexed_after_an_annotation_on_it([EmbedAnnotation(R1, annotation), Embed(R1), Embed(R2)]) == [R1]
    assert indexed_after_an_annotation_on_it([Embed(R1), EmbedAnnotation(R1, annotation), Embed(R2)]) == []


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_start_plans_the_work_the_table_states_and_indexes_no_resource_after_an_annotation_on_it(case: Case) -> None:
    plan = plan_of(case)
    assert indexed_after_an_annotation_on_it(plan) == [], case.why
    assert in_one_order(in_table_words(item) for item in plan) == in_one_order(case.work), case.why


# ── What no case of the table rests on ────────────────────────────────


def plan_about(annotation: Annotation, *, has_point: bool) -> list[Work]:
    """The plan for one annotation on a resource whose points are as the catalog says: whatever is planned is planned of the annotation."""
    points: set[AnnotationId] = {annotation.id} if has_point else set()
    return plan_reconcile(
        indexed_resources={R1: ResourceStamp(content_checksum=CHECKSUM, entity_types=())},
        indexed_annotations=points,
        anchored_keys=frozenset(),
        embeddable=classify_embeddable([described(R1, media_type="text/markdown", checksum=CHECKSUM, entity_types=[])]),
        live_annotations=[(R1, annotation)],
    )


# No case of the table rests on a character about which the trimming a language is born with disagrees. These do. The
# next line (U+0085) and the ideographic space (U+3000) have Unicode's White_Space property. The byte order mark
# (U+FEFF) and the unit separator (U+001F) do not have it.


@pytest.mark.parametrize(
    ("quote", "is_text"),
    [("\u0085", False), ("\u3000\u0085", False), ("\ufeff", True), ("\x1f", True)],
    ids=["the next line", "an ideographic space and the next line", "the byte order mark", "a unit separator"],
)
def test_an_annotation_quotes_text_when_its_quote_has_a_character_that_is_not_unicode_s_white_space(quote: str, is_text: bool) -> None:
    annotation = annotation_on(R1, A1, quote)
    assert quotes_text(annotation) is is_text
    # With no point it is indexed only if it quotes text, and with one its point is taken out only if it quotes none.
    without_a_point: list[Work] = [EmbedAnnotation(R1, annotation)] if is_text else []
    with_a_point: list[Work] = [] if is_text else [PurgeAnnotation(A1)]
    assert plan_about(annotation, has_point=False) == without_a_point
    assert plan_about(annotation, has_point=True) == with_a_point


def test_an_annotation_of_a_resource_as_a_whole_quotes_no_text() -> None:
    # The table states an annotation that quotes none by a quote that is empty. One whose target selects nothing quotes none either.
    whole = annotation_on(R1, A1, None)
    assert not quotes_text(whole)
    assert plan_about(whole, has_point=False) == []
    assert plan_about(whole, has_point=True) == [PurgeAnnotation(A1)]


@pytest.mark.parametrize(
    ("carried", "stated"),
    [(("Person", "Person"), ["Person"]), (("Person",), ["Person", "Person"]), (("a", "b"), ["b", "a"])],
    ids=["a type the points carry twice", "a type the catalog states twice", "another order"],
)
def test_points_that_carry_the_catalog_s_entity_types_as_a_set_are_not_restamped(carried: tuple[str, ...], stated: list[str]) -> None:
    plan = plan_reconcile(
        indexed_resources={R1: ResourceStamp(content_checksum=CHECKSUM, entity_types=carried)},
        indexed_annotations=set(),
        anchored_keys=frozenset(),
        embeddable=classify_embeddable([described(R1, media_type="text/markdown", checksum=CHECKSUM, entity_types=stated)]),
        live_annotations=[],
    )
    assert plan == []


def test_a_reconcile_s_summary_is_said_in_the_eleven_members_the_protocol_names_with_the_skipped_counted_by_reason() -> None:
    summary = ReconcileSummary(
        resources_embedded=1,
        resources_skipped={"empty": 2, "no-text-layer": 3},
        resources_unavailable=4,
        resources_failed=5,
        resources_restamped=6,
        resources_reanchored=7,
        resource_vectors_deleted=8,
        annotations_embedded=9,
        annotation_vectors_deleted=10,
        resources_eligible=11,
        resources_indexed=12,
    )
    said = summary.said()
    assert said == {
        "resourcesEmbedded": 1,
        "resourcesSkipped": {"empty": 2, "no-text-layer": 3},
        "resourcesUnavailable": 4,
        "resourcesFailed": 5,
        "resourcesRestamped": 6,
        "resourcesReanchored": 7,
        "resourceVectorsDeleted": 8,
        "annotationsEmbedded": 9,
        "annotationVectorsDeleted": 10,
        "resourcesEligible": 11,
        "resourcesIndexed": 12,
    }
    # Nothing skipped is an object with no member, and not a member left out.
    assert replace(summary, resources_skipped={}).said()["resourcesSkipped"] == {}
    # The names are the page's: its rule of what a reconcile reports gives each in brackets.
    page = (ROOT / "docs/protocol/SMELTER.md").read_text(encoding="utf-8")
    rule = re.search(r"\*\*It reports\*\*(.*?)\*Held by", page, re.DOTALL)
    assert rule is not None, "docs/protocol/SMELTER.md no longer says what a reconcile reports"
    named = re.findall(r"\(`(\w+)`\)", rule.group(1))
    assert len(named) == 11
    assert sorted(said) == sorted(named)
