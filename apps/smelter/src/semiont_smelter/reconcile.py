"""The work a Smelter plans when it starts: what its index and its anchored-text store hold, held to what the catalog says they should.

`specs/src/smelter/reconcile-cases.json` is the rule, and
`docs/protocol/SMELTER.md` § Reconcile says it in prose. A plan is worked out
from what it is handed and from nothing else: it reads nothing, waits on
nothing and logs nothing. The reads are the Smelter's, and so is doing the
work.

**A checksum is compared as it is written.** The checksum on a resource's
points, the key of an anchored-text entry and the checksum the catalog states
for a resource's first representation are each the SHA-256 of the bytes, in
lower-case hex and with nothing before it: the Archivist writes that, and the
Smelter writes the other two. A plan compares them as text.

**Entity types are compared as sets:** in no order, and a type stated twice
is stated once.

**An annotation quotes text when its quote has a character that is not white
space**, and white space is Unicode's (`semiont_service.white_space`).
"""

from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass
from typing import final

from pydantic import JsonValue
from semiont.annotations import annotation_exact_text
from semiont.identifiers import AnnotationId, ResourceId
from semiont.media_types import text_source_of, yields_geometry_of
from semiont.resources import primary_representation, resource_entity_types
from semiont.types import Annotation, ResourceDescriptor, SmeltSettledReason
from semiont_service.white_space import trimmed
from semiont_vectors.store import ResourceStamp

__all__ = [
    "Embed",
    "EmbedAnnotation",
    "Embeddable",
    "Purge",
    "PurgeAnnotation",
    "Reanchor",
    "ReconcileSummary",
    "Restamp",
    "Work",
    "classify_embeddable",
    "plan_reconcile",
    "quotes_text",
]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Embeddable:
    """What the catalog says of a resource whose media type has text."""

    checksum: str | None
    """The checksum of its first representation: of the bytes a Smelter would read. `None` where the catalog states none."""
    entity_types: frozenset[str]
    """Its entity types, which its points are to carry."""
    yields_geometry: bool
    """Whether reading its text gives where each run of it is on a page: whether its bytes should have an anchored-text entry."""


@final
@dataclass(frozen=True, slots=True)
class Embed:
    """Index a resource's text, in place of whatever points it has."""

    resource: ResourceId


@final
@dataclass(frozen=True, slots=True)
class Restamp:
    """Rewrite the entity types a resource's points carry. Nothing is embedded."""

    resource: ResourceId


@final
@dataclass(frozen=True, slots=True)
class Reanchor:
    """Derive a resource's anchored text again. Nothing is embedded, and the index is not touched."""

    resource: ResourceId


@final
@dataclass(frozen=True, slots=True)
class Purge:
    """Take a resource's points out."""

    resource: ResourceId


@final
@dataclass(frozen=True, slots=True)
class EmbedAnnotation:
    """Index an annotation that quotes text, on a resource of the catalog."""

    resource: ResourceId
    annotation: Annotation


@final
@dataclass(frozen=True, slots=True)
class PurgeAnnotation:
    """Take an annotation's point out. Which resource the annotation was on is not known: the index was asked for its ids alone."""

    annotation: AnnotationId


type Work = Embed | Restamp | Reanchor | Purge | EmbedAnnotation | PurgeAnnotation
"""One item of planned work."""


def quotes_text(annotation: Annotation) -> bool:
    """Whether an annotation quotes text: whether the text its target quotes has a character that is not white space."""
    return trimmed(annotation_exact_text(annotation)) != ""


def classify_embeddable(resources: Iterable[ResourceDescriptor]) -> dict[ResourceId, Embeddable]:
    """The resources whose media type has text, each with what the catalog says of it, in the order given.

    Whether a type has text, and whether reading it gives places on a page,
    is asked of the type (`semiont.media_types`). A resource with no
    representation has no media type, and so no text.
    """
    embeddable: dict[ResourceId, Embeddable] = {}
    for resource in resources:
        representation = primary_representation(resource)
        if representation is None or text_source_of(representation.media_type) == "none":
            continue
        embeddable[resource.id] = Embeddable(
            checksum=representation.checksum,
            entity_types=frozenset(resource_entity_types(resource)),
            yields_geometry=yields_geometry_of(representation.media_type),
        )
    return embeddable


def plan_reconcile(
    *,
    indexed_resources: Mapping[ResourceId, ResourceStamp],
    indexed_annotations: Collection[AnnotationId],
    anchored_keys: Collection[str],
    embeddable: Mapping[ResourceId, Embeddable],
    live_annotations: Iterable[tuple[ResourceId, Annotation]],
) -> list[Work]:
    """The work that brings an index and an anchored-text store to what the catalog says, in an order it can be done in.

    `indexed_resources` is the stamp of each resource the index holds points
    for, and `indexed_annotations` the annotations it holds a point for.
    `anchored_keys` is the keys of the anchored-text store. `embeddable` is
    `classify_embeddable`'s answer for the catalog's resources, and
    `live_annotations` every annotation of every resource of the catalog,
    with the resource it is on: of a resource whose media type has no text
    too, and whether or not it quotes anything.

    An `Embed` of a resource comes before every `EmbedAnnotation` on it: an
    annotation's point takes the mark of text read from pixels from its
    resource's points as they then are. The work is otherwise in no stated
    order.
    """
    work: list[Work] = [Purge(resource) for resource in indexed_resources if resource not in embeddable]

    for resource, catalog in embeddable.items():
        indexed = indexed_resources.get(resource)
        if indexed is None:
            work.append(Embed(resource))
            continue
        if catalog.checksum is not None and indexed.content_checksum != catalog.checksum:
            # Points made from earlier bytes, or points that state no checksum at all. Indexing reads the entity types afresh too.
            work.append(Embed(resource))
            continue
        if frozenset(indexed.entity_types) != catalog.entity_types:
            # A tag changes no byte, so the checksums say nothing of it.
            work.append(Restamp(resource))
        # Beside a restamp or alone: each mends its own half. A catalog that states no checksum does not say whether
        # the bytes changed, so nothing is derived again for it. The store is asked by the checksum, which is what
        # names the bytes, and not by the resource.
        if catalog.checksum is not None and catalog.yields_geometry and catalog.checksum not in anchored_keys:
            work.append(Reanchor(resource))

    live: set[AnnotationId] = set()
    for resource, annotation in live_annotations:
        if not quotes_text(annotation):
            continue
        live.add(annotation.id)
        if annotation.id not in indexed_annotations:
            work.append(EmbedAnnotation(resource, annotation))

    work.extend(PurgeAnnotation(annotation) for annotation in indexed_annotations if annotation not in live)
    return work


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ReconcileSummary:
    """What a reconcile came to (`docs/protocol/SMELTER.md` § Reconcile).

    The first four are what the resources it set out to index came to, and
    add up to how many those were. The next five are counts of what was
    planned.
    """

    resources_embedded: int
    """The resources it set out to index that were indexed."""
    resources_skipped: Mapping[SmeltSettledReason, int]
    """Those that were declined, by the reason each was."""
    resources_unavailable: int
    """Those whose bytes could not be read."""
    resources_failed: int
    """Those whose indexing failed some other way."""
    resources_restamped: int
    resources_reanchored: int
    resource_vectors_deleted: int
    annotations_embedded: int
    annotation_vectors_deleted: int
    resources_eligible: int
    """How many resources of the catalog have text."""
    resources_indexed: int
    """How many resources have points when it ends."""

    def said(self) -> dict[str, JsonValue]:
        """This, as the health endpoint reports it."""
        skipped: dict[str, JsonValue] = {}
        for reason, count in self.resources_skipped.items():
            skipped[reason] = count
        return {
            "resourcesEmbedded": self.resources_embedded,
            "resourcesSkipped": skipped,
            "resourcesUnavailable": self.resources_unavailable,
            "resourcesFailed": self.resources_failed,
            "resourcesRestamped": self.resources_restamped,
            "resourcesReanchored": self.resources_reanchored,
            "resourceVectorsDeleted": self.resource_vectors_deleted,
            "annotationsEmbedded": self.annotations_embedded,
            "annotationVectorsDeleted": self.annotation_vectors_deleted,
            "resourcesEligible": self.resources_eligible,
            "resourcesIndexed": self.resources_indexed,
        }
