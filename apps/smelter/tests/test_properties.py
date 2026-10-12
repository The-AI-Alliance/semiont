"""The Smelter's rules, held over histories nobody wrote.

`test_smelter.py` holds each rule to a knowledge base someone thought to
write. These hold what is to be so of every history: Hypothesis makes the
histories, and shrinks one that fails to the least that still does.

A history here is a list of changes to a knowledge base, each of which the
Archivist records one event of. It is well formed, as a record is: a
resource is made before anything else happens to it, nothing happens to an
archived resource but its unarchiving, and an annotation has an id no other
has and is removed once. A Smelter is delivered the events in their order:
all of them or some, once or twice, having caught up before the next change
or still at work on the one before.

The index is held to a fold written here, which shares nothing with the
Smelter's code and works nothing out of bytes or of a quote. Each of the
bytes a resource may be given is stated with what it comes to, and each
quote with whether it quotes text. From those the fold says what an index is
to hold: a resource has points if and only if it is not archived and its
bytes give text, the points carry the checksum of its bytes and its entity
types, and an annotation has a point if and only if its resource is not
archived and it quotes text.

One property begins a reconcile in the middle of a history. What a reconcile
plans, it plans from one read of the catalog, and a plan is not looked at
again when its turn comes. So a resource archived after that read, or an
annotation removed after it, may be put back, and a resource whose type had
no text at that read may lose the points a later event gives it, until the
Smelter next starts. A history steps around that with a calm end: from a
change that is drawn, no resource is archived, no annotation is removed and
no resource is given bytes of a type without text. The reconcile begins
there.
"""

import asyncio
import hashlib
import itertools
import tempfile
from collections.abc import Callable, Coroutine, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, assert_never, final

from aio import run
from hypothesis import given, settings
from hypothesis import strategies as st
from pydantic import JsonValue
from rig import Held, Rig, World, drawn
from semiont_vectors.memory import MemoryVectorStore
from spec import JsonObject, text, thing

from semiont_smelter.reconcile import ReconcileSummary

RESOURCES: Final = ("res-a", "res-b", "res-c")
ENTITY_TYPES: Final = ("Person", "Place", "Treaty")

MOST_CHANGES: Final = 16
"""The most changes a history is of."""

MARKDOWN: Final = "text/markdown"
"""A media type whose bytes are its text."""
PDF: Final = "application/pdf"
"""A media type whose text is derived from its bytes: here by a reader that was told what one document draws."""
PNG: Final = "image/png"
"""A media type that has no text."""
WITH_TEXT: Final = frozenset({MARKDOWN, PDF})
"""The media types whose resources have text: the ones a Smelter that starts sets out to index."""

_TURNS: Final = 100_000
"""The most turns a scenario gives a reconcile to ask for the catalog. Its read of the store, which comes first, takes far fewer."""

# Every example runs a Smelter to rest many times over, so none is held to a time; and nothing is kept between runs,
# so a run reads no file a run before it wrote.
PROPERTY: Final = settings(max_examples=50, deadline=None, database=None)

type Reason = Literal["empty", "no-extractor"]
"""Why nothing of some bytes is indexed, of the reasons these histories meet."""


@final
@dataclass(frozen=True, slots=True)
class Stored:
    """Bytes a resource may be given, the media type they are stored under, and what they come to."""

    data: bytes
    media_type: str
    declined: Reason | None
    """Why nothing of them is indexed. `None` for bytes that give text."""

    @property
    def checksum(self) -> str:
        """Their SHA-256 in lower-case hex: the checksum the Archivist states of them, and a Smelter is to."""
        return hashlib.sha256(self.data).hexdigest()


DOCUMENT: Final = Stored(b"%PDF-1.7 the one document the reader was told of", PDF, None)

CONTENTS: Final[tuple[Stored, ...]] = (
    Stored(b"# The treaty of 1804\n\nSigned at St. Louis, and disputed ever after.\n", MARKDOWN, None),
    Stored(b"Black Hawk led a band of the Sauk back across the Mississippi in 1832.", MARKDOWN, None),
    # One character, and it is not white space, though `str.isspace` says it is: a text.
    Stored(b"\x1f", MARKDOWN, None),
    Stored(" \n\t\u0085\u3000".encode(), MARKDOWN, "empty"),
    DOCUMENT,
    Stored(b"\x89PNG\r\n\x1a\n and nothing a reader of text reads", PNG, "no-extractor"),
)
"""Everything a resource here may be given."""

WITH_A_TEXT_TYPE: Final = tuple(given for given in CONTENTS if given.media_type in WITH_TEXT)

PDFS: Final = {DOCUMENT.data: drawn("The treaty of 1804", "was signed at St. Louis")}
"""The documents a rig's reader of PDFs is told of."""

QUOTED: Final = ("Black Hawk", "the treaty of 1804", "\ufeff")
"""The quotes that quote text. The last is one character, and it is not white space."""
QUOTES: Final[tuple[str | None, ...]] = (*QUOTED, None, "", " \t\u0085\u3000")
"""Every quote an annotation here may have. The last three quote no text: no quote at all, an empty one, white space alone."""


@final
@dataclass(frozen=True, slots=True)
class Put:
    """A resource is given bytes: it is made, where there was none."""

    resource: str
    stored: Stored


@final
@dataclass(frozen=True, slots=True)
class Tag:
    resource: str
    entity_type: str


@final
@dataclass(frozen=True, slots=True)
class Untag:
    resource: str
    entity_type: str


@final
@dataclass(frozen=True, slots=True)
class Archive:
    resource: str


@final
@dataclass(frozen=True, slots=True)
class Unarchive:
    resource: str


@final
@dataclass(frozen=True, slots=True)
class Annotate:
    resource: str
    annotation: str
    quote: str | None
    """The text it quotes. `None` for an annotation of its resource whole."""


@final
@dataclass(frozen=True, slots=True)
class Unannotate:
    resource: str
    annotation: str


type Change = Put | Tag | Untag | Archive | Unarchive | Annotate | Unannotate
"""One change to a knowledge base, which the Archivist records one event of."""


def made(world: World, change: Change) -> JsonObject:
    """Make a change to a knowledge base, and answer the event the Archivist records of it."""
    match change:
        case Put():
            return world.put(change.resource, change.stored.data, change.stored.media_type)
        case Tag():
            return world.tag(change.resource, change.entity_type)
        case Untag():
            return world.untag(change.resource, change.entity_type)
        case Archive():
            return world.archive(change.resource)
        case Unarchive():
            return world.unarchive(change.resource)
        case Annotate():
            return world.annotate(change.resource, change.annotation, change.quote)
        case Unannotate():
            return world.unannotate(change.resource, change.annotation)
        case _:
            assert_never(change)


@final
@dataclass(frozen=True, slots=True)
class History:
    changes: tuple[Change, ...]
    """The changes, in the order they are made."""
    caught_up: tuple[bool, ...]
    """For each change, whether a Smelter that follows has applied all it was delivered before the next change is made."""
    heard: tuple[bool, ...]
    """For each change, whether a Smelter that was not always following was delivered its event."""
    calm_from: int
    """How many changes come before the calm end. Every one, for a history with no calm end."""


type Kind = Literal["put", "tag", "untag", "archive", "unarchive", "annotate", "unannotate"]

_CALM: Final[tuple[Kind, ...]] = ("put", "tag", "untag", "annotate")
"""What happens in the calm end of a history to a resource that is there and is not archived."""


@final
@dataclass(frozen=True, slots=True)
class _SoFar:
    """What has happened in a history that is being made: what the next change is kept well formed by."""

    there: set[str]
    """The resources that were made."""
    archived: set[str]
    on: dict[str, list[str]]
    """The annotations on each resource that were not removed."""
    minted: Iterator[int]


def _change(draw: st.DrawFn, resource: str, calm: bool, so_far: _SoFar) -> Change:
    """The next change to a resource, by what has happened so far, which is added to."""
    kinds: tuple[Kind, ...]
    if resource not in so_far.there:
        kinds = ("put",)
    elif resource in so_far.archived:
        kinds = ("unarchive",)
    elif calm:
        kinds = _CALM
    elif so_far.on[resource]:
        kinds = (*_CALM, "archive", "unannotate")
    else:
        kinds = (*_CALM, "archive")
    kind = draw(st.sampled_from(kinds))
    match kind:
        case "put":
            given = draw(st.sampled_from(WITH_A_TEXT_TYPE if calm else CONTENTS))
            so_far.there.add(resource)
            so_far.on.setdefault(resource, [])
            return Put(resource, given)
        case "tag":
            return Tag(resource, draw(st.sampled_from(ENTITY_TYPES)))
        case "untag":
            return Untag(resource, draw(st.sampled_from(ENTITY_TYPES)))
        case "archive":
            so_far.archived.add(resource)
            return Archive(resource)
        case "unarchive":
            so_far.archived.discard(resource)
            return Unarchive(resource)
        case "annotate":
            # An id no other annotation has: an annotation is on one resource, and is not made again once it is removed.
            annotation = f"ann-{next(so_far.minted)}"
            so_far.on[resource].append(annotation)
            return Annotate(resource, annotation, draw(st.sampled_from(QUOTES)))
        case "unannotate":
            annotation = draw(st.sampled_from(so_far.on[resource]))
            so_far.on[resource].remove(annotation)
            return Unannotate(resource, annotation)
        case _:
            assert_never(kind)


@st.composite
def histories(draw: st.DrawFn, *, with_a_calm_end: bool = False) -> History:
    """A well-formed history of two or three resources. Its calm end, where it has one, begins at a change that is drawn."""
    resources = draw(st.lists(st.sampled_from(RESOURCES), min_size=2, max_size=len(RESOURCES), unique=True))
    length = draw(st.integers(min_value=1, max_value=MOST_CHANGES))
    calm_from = draw(st.integers(min_value=0, max_value=length)) if with_a_calm_end else length
    so_far = _SoFar(there=set(), archived=set(), on={}, minted=itertools.count(1))
    changes: list[Change] = []
    for at in range(length):
        changes.append(_change(draw, draw(st.sampled_from(resources)), at >= calm_from, so_far))
    flags = st.lists(st.booleans(), min_size=length, max_size=length)
    return History(changes=tuple(changes), caught_up=tuple(draw(flags)), heard=tuple(draw(flags)), calm_from=calm_from)


@final
@dataclass(frozen=True, slots=True)
class Indexed:
    """What an index holds, as far as the fold says it."""

    resources: Mapping[str, tuple[str | None, frozenset[str]]]
    """Each resource that has points: the checksum they carry, and their entity types, in no order and each once."""
    annotations: Mapping[str, tuple[str, str]]
    """Each annotation that has a point: the resource it is on, and the text it quotes."""


@final
@dataclass(frozen=True, slots=True)
class Folded:
    """A knowledge base after a history, as far as the fold reads it, and what is to be so of a Smelter's index and signals."""

    stored: Mapping[str, Stored]
    """The bytes each resource has."""
    entity_types: Mapping[str, frozenset[str]]
    archived: frozenset[str]
    quoting: Mapping[str, tuple[str, str]]
    """Each annotation that quotes text and was not removed: the resource it is on, and the text."""

    def index(self, *, unread: str | None = None) -> Indexed:
        """What an index is to hold. `unread` names a resource whose bytes cannot be read, which has no points whatever they are."""
        return Indexed(
            resources={
                resource: (given.checksum, self.entity_types[resource])
                for resource, given in self.stored.items()
                if resource not in self.archived and given.declined is None and resource != unread
            },
            annotations={annotation: quoted for annotation, quoted in self.quoting.items() if quoted[0] not in self.archived},
        )

    def decisions(self) -> dict[str, JsonObject]:
        """What a Smelter that indexed each resource is to have signalled of it last on `smelt:settled`.

        A decision is of a resource's bytes, so that of an archived resource
        is the one its bytes come to.
        """
        said: dict[str, JsonObject] = {}
        for resource, given in self.stored.items():
            decision: JsonObject = {"resourceId": resource, "contentChecksum": given.checksum, "outcome": "indexed"}
            if given.declined is not None:
                decision["outcome"] = "skipped"
                decision["reason"] = given.declined
            said[resource] = decision
        return said

    def at_rest(self) -> JsonObject:
        """What a reconcile is to report where it finds the index as it should be, by the names its health gives each count.

        Nothing is mended. A resource that is not archived, whose type has
        text and whose bytes give none, has no points. So every start sets
        out to index it again, and declines it again for the same reason.
        """
        live = [given for resource, given in self.stored.items() if resource not in self.archived]
        declined_again: dict[str, int] = {}
        for given in live:
            if given.media_type in WITH_TEXT and given.declined is not None:
                declined_again[given.declined] = declined_again.get(given.declined, 0) + 1
        skipped: JsonObject = {}
        skipped.update(declined_again)
        return {
            "resourcesEmbedded": 0,
            "resourcesSkipped": skipped,
            "resourcesUnavailable": 0,
            "resourcesFailed": 0,
            "resourcesRestamped": 0,
            "resourcesReanchored": 0,
            "resourceVectorsDeleted": 0,
            "annotationsEmbedded": 0,
            "annotationVectorsDeleted": 0,
            "resourcesEligible": sum(1 for given in live if given.media_type in WITH_TEXT),
            "resourcesIndexed": len(self.index().resources),
        }


def folded(changes: Sequence[Change]) -> Folded:
    """A knowledge base after these changes. It shares nothing with the Smelter's code."""
    stored: dict[str, Stored] = {}
    entity_types: dict[str, set[str]] = {}
    archived: set[str] = set()
    quoting: dict[str, tuple[str, str]] = {}
    for change in changes:
        match change:
            case Put():
                stored[change.resource] = change.stored
                entity_types.setdefault(change.resource, set())
            case Tag():
                entity_types[change.resource].add(change.entity_type)
            case Untag():
                entity_types[change.resource].discard(change.entity_type)
            case Archive():
                archived.add(change.resource)
            case Unarchive():
                archived.discard(change.resource)
            case Annotate():
                if change.quote is not None and change.quote in QUOTED:
                    quoting[change.annotation] = (change.resource, change.quote)
            case Unannotate():
                quoting.pop(change.annotation, None)
            case _:
                assert_never(change)
    return Folded(
        stored=stored,
        entity_types={resource: frozenset(types) for resource, types in entity_types.items()},
        archived=frozenset(archived),
        quoting=quoting,
    )


def indexed(held: Held) -> Indexed:
    """What an index holds, read as the fold states it."""
    return Indexed(
        resources={resource: (stamp.content_checksum, frozenset(stamp.entity_types)) for resource, stamp in held.stamps.items()},
        annotations={annotation: (point.resource, point.text) for annotation, point in held.annotations.items()},
    )


def lying(event: JsonObject) -> JsonObject:
    """An event whose payload says nothing true but which annotation it is of: that is the event's own to say, and is kept."""
    payload = thing(event["payload"], "an event's payload")
    lie: JsonObject = {"name": "A name it never had", "format": "image/gif", "contentChecksum": "0" * 64, "entityType": "Nobody"}
    lie.update({name: payload[name] for name in ("annotation", "annotationId") if name in payload})
    return {**event, "payload": lie}


async def followed(rig: Rig, changes: Sequence[Change], caught_up: Sequence[bool]) -> None:
    """Make these changes with a Smelter following: each change's event is delivered as the change is made.

    Where `caught_up` says so, the Smelter has applied all it was delivered
    before the next change is made. Where it does not, it is given one turn,
    and the next change is made while it works: what it then reads of the
    knowledge base is what the knowledge base holds by then.
    """
    for change, waited_for in zip(changes, caught_up, strict=True):
        rig.deliver(made(rig.world, change))
        if waited_for:
            await rig.settled()
        else:
            await asyncio.sleep(0)
    await rig.settled()


async def until_the_catalog_is_asked_for(rig: Rig, reconciling: asyncio.Task[ReconcileSummary]) -> None:
    """Give the Smelter turns until its reconcile has asked for the catalog, or has ended without asking.

    What the reconcile plans, it plans from what the knowledge base holds
    at that moment: a change made after this is one it did not read.
    """
    for _ in range(_TURNS):
        if reconciling.done() or rig.asked("browse:resources-requested"):
            return
        await asyncio.sleep(0)


async def nothing_is_left_to_mend(rig: Rig, said: Folded) -> None:
    """A reconcile of an index that holds what it should reports that, asks the provider for nothing and changes nothing."""
    before, asked = await rig.held(), len(rig.provider.asked)
    again = await rig.smelter.reconcile()
    assert again.said() == said.at_rest()
    assert len(rig.provider.asked) == asked
    assert await rig.held() == before


def in_a_home(scenario: Callable[[Path], Coroutine[None, None, None]]) -> None:
    """Run a scenario to its end, handed a directory of its own for its anchored-text stores, which is gone afterwards.

    No fixture makes the directory: one made for a test is shared by every
    history the test is run with.
    """
    with tempfile.TemporaryDirectory() as home:
        run(scenario(Path(home)))


@PROPERTY
@given(histories())
def test_a_smelter_that_followed_a_history_holds_what_the_knowledge_base_says(history: History) -> None:
    async def scenario(home: Path) -> None:
        async with Rig(home, pdfs=PDFS) as rig:
            await followed(rig, history.changes, history.caught_up)

            # Every event was applied: one that failed is passed by, and not counted.
            assert rig.smelter.events_processed == len(history.changes)
            assert indexed(await rig.held()) == folded(history.changes).index()

    in_a_home(scenario)


@PROPERTY
@given(histories())
def test_an_event_delivered_twice_in_a_row_changes_nothing_the_second_time(history: History) -> None:
    async def scenario(home: Path) -> None:
        async with Rig(home / "once", pdfs=PDFS) as once, Rig(home / "twice", pdfs=PDFS) as twice:
            for change in history.changes:
                await once.happened(made(once.world, change))
                event = made(twice.world, change)
                await twice.happened(event, event)
                assert await twice.held() == await once.held()

            assert twice.smelter.events_processed == 2 * len(history.changes)
            assert indexed(await twice.held()) == folded(history.changes).index()

    in_a_home(scenario)


@PROPERTY
@given(histories(with_a_calm_end=True), st.integers(min_value=0, max_value=MOST_CHANGES))
def test_a_reconcile_begun_in_the_middle_of_a_history_undoes_nothing_a_later_event_did(history: History, read_after: int) -> None:
    calm = history.calm_from
    before, after = history.changes[:calm], history.changes[calm:]

    async def scenario(home: Path) -> None:
        async with Rig(home, pdfs=PDFS) as rig:
            await followed(rig, before, history.caught_up[:calm])

            reconciling = asyncio.create_task(rig.smelter.reconcile())
            for at, change in enumerate(after):
                # From this change on, each is one the reconcile did not read of the catalog.
                if at == read_after:
                    await until_the_catalog_is_asked_for(rig, reconciling)
                # The reconcile and the Smelter's lanes are given a turn, and the next change is made while they work.
                await asyncio.sleep(0)
                rig.deliver(made(rig.world, change))
            mended = await reconciling
            await rig.settled()

            assert (mended.resources_unavailable, mended.resources_failed) == (0, 0)
            # What the reconcile did is counted among no events.
            assert rig.smelter.events_processed == len(history.changes)
            assert indexed(await rig.held()) == folded(history.changes).index()

    in_a_home(scenario)


@PROPERTY
@given(histories())
def test_a_reconcile_mends_what_was_missed_and_fills_a_cleared_index_and_a_second_finds_nothing_to_mend(history: History) -> None:
    said = folded(history.changes)
    whole = said.index()

    async def scenario(home: Path) -> None:
        async with Rig(home, pdfs=PDFS) as rig:
            # A Smelter that heard some of the history, and missed the rest of it.
            for change, heard in zip(history.changes, history.heard, strict=True):
                event = made(rig.world, change)
                if heard:
                    await rig.happened(event)

            mended = await rig.smelter.reconcile()
            assert (mended.resources_unavailable, mended.resources_failed) == (0, 0)
            assert indexed(await rig.held()) == whole
            await nothing_is_left_to_mend(rig, said)

        # The index was cleared while the Smelter was stopped: it starts with a new one, and the store it had.
        async with Rig(home, pdfs=PDFS, after=rig, index=MemoryVectorStore()) as later:
            filled = await later.smelter.reconcile()
            assert filled.resources_embedded == len(whole.resources)
            assert filled.annotations_embedded == len(whole.annotations)
            assert indexed(await later.held()) == whole
            await nothing_is_left_to_mend(later, said)

    in_a_home(scenario)


@PROPERTY
@given(histories())
def test_nothing_in_an_events_payload_but_which_annotation_it_is_of_changes_what_is_indexed(history: History) -> None:
    async def scenario(home: Path) -> None:
        async with Rig(home / "told", pdfs=PDFS) as told, Rig(home / "lied-to", pdfs=PDFS) as lied_to:
            for change in history.changes:
                await told.happened(made(told.world, change))
                await lied_to.happened(lying(made(lied_to.world, change)))

            assert lied_to.smelter.events_processed == len(history.changes)
            assert await lied_to.held() == await told.held()
            assert lied_to.signalled() == told.signalled()

    in_a_home(scenario)


@PROPERTY
@given(histories())
def test_at_every_step_of_a_history_only_a_resource_whose_bytes_gave_text_has_points(history: History) -> None:
    async def scenario(home: Path) -> None:
        async with Rig(home, pdfs=PDFS) as rig:
            for so_far, change in enumerate(history.changes, start=1):
                await rig.happened(made(rig.world, change))

                said, held = folded(history.changes[:so_far]), await rig.held()
                assert all(said.stored[resource].declined is None for resource in held.stamps)
                assert indexed(held) == said.index()

    in_a_home(scenario)


@PROPERTY
@given(histories(), st.sampled_from(RESOURCES))
def test_a_resource_whose_bytes_cannot_be_read_is_decided_nothing_of_and_holds_up_no_other(history: History, unread: str) -> None:
    async def scenario(home: Path) -> None:
        async with Rig(home, pdfs=PDFS) as rig:
            rig.world.unread.add(unread)
            await followed(rig, history.changes, history.caught_up)

            # An event of the resource that cannot be read is applied all the same: it is no failure.
            assert rig.smelter.events_processed == len(history.changes)
            # Its annotations have their points, which are made of no byte of it, and every other resource has its own.
            assert indexed(await rig.held()) == folded(history.changes).index(unread=unread)
            assert [signal for signal in rig.signalled() if signal.get("resourceId") == unread] == []

    in_a_home(scenario)


@PROPERTY
@given(histories())
def test_the_last_signal_of_each_resource_is_the_decision_for_its_bytes_as_they_are(history: History) -> None:
    async def scenario(home: Path) -> None:
        async with Rig(home, pdfs=PDFS) as rig:
            await followed(rig, history.changes, history.caught_up)

            last: dict[str, Mapping[str, JsonValue]] = {}
            for signal in rig.signalled():
                last[text(signal.get("resourceId"), "the resource a signal is of")] = signal
            # Every resource was made, and so was to be indexed: each has a decision, `indexed` or `skipped` with its reason.
            assert last == folded(history.changes).decisions()

    in_a_home(scenario)
