"""Browse: reads, and this viewer's own signals.

The queries (`Cached`) answer from the client's cache: one read with `fresh`,
or held with `async with` and watched. The one-shot reads are asked once. The
signals are this viewer's own, with the one report among them going over the
wire.
"""

import asyncio
import codecs
import string
from collections.abc import AsyncIterator, Callable, Hashable
from dataclasses import dataclass
from typing import Final, Self, final, override

from semiont._encodings import ENCODING_OF_LABEL, REFUSED, SINGLE_BYTE
from semiont.cache import Cache, CacheState, Ready
from semiont.cached import Cached, Keyed, Source, itself, shown
from semiont.channels import BROWSE_CLICK, BROWSE_RESOURCE_OPEN, BROWSE_RESOURCE_VIEWED
from semiont.errors import SemiontError, TransportError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.links import Links
from semiont.namespaces.live import LIMITS_HOLDERS, WHOLE, Live, ResourceFilters
from semiont.operations import BROWSE_ANNOTATION_HISTORY_REQUESTED, BROWSE_DIRECTORY_REQUESTED, BROWSE_KB_REQUESTED
from semiont.transport import Content, ContentStream, ContentTransport, ResourceHold
from semiont.types import (
    AgentSoftware,
    AnchoredTextAnswer,
    Annotation,
    AttributedEvent,
    BrowseAnnotationHistoryRequest,
    BrowseClickEvent,
    BrowseDirectoryRequest,
    BrowseDirectoryRequestSort,
    BrowseDirectoryResultResponse,
    BrowseKbRequest,
    BrowseResourceOpenEvent,
    BrowseResourceViewedEvent,
    CollaboratorEntry,
    GetAnnotationHistoryResponse,
    GetAnnotationsResponse,
    GetResourceResponse,
    InferenceLimits,
    InferencePairLimits,
    KbDescription,
    ListResourcesResponse,
    ResourceDescriptor,
    TagSchema,
)

__all__ = ["BrowseNamespace", "Collaborator"]

# How many resources a list asks for when its caller states no limit. Every
# SDK asks for as many: the cases of specs/src/client/surface.json hold each to it.
_LIST_LIMIT: Final = 100

# What a content type is made of, as the MIME Sniffing Standard reads one:
# its white space, and the characters of a type, a subtype and a parameter's
# name.
_HTTP_WHITE_SPACE: Final = "\n\r\t "
_HTTP_TOKEN: Final = frozenset("!#$%&'*+-.^_`|~" + string.digits + string.ascii_letters)

# What the Encoding Standard drops from around a label, and the case it
# matches one in.
_ASCII_WHITE_SPACE: Final = "\t\n\f\r "
_ASCII_LOWER: Final = str.maketrans(string.ascii_uppercase, string.ascii_lowercase)

# The byte-order marks, each with Python's decoder of the encoding it is
# the mark of, in the order the Encoding Standard looks for them.
_MARKS: Final = ((b"\xef\xbb\xbf", "utf-8"), (b"\xfe\xff", "utf-16-be"), (b"\xff\xfe", "utf-16-le"))

# The encodings Python's own decoders read as the standard's do, malformed
# input included: specs/src/text/decode-cases.json holds them to it.
_PYTHONS_OWN: Final = {"utf-8": "utf-8", "utf-16be": "utf-16-be", "utf-16le": "utf-16-le"}


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Collaborator:
    """One of the knowledge base's collaborators.

    Its entry in the directory, and its model's limits when the service
    holding that model's credentials reported them.
    """

    entry: CollaboratorEntry
    limits: InferenceLimits | None = None


def _joined(directory: list[CollaboratorEntry], reported: list[InferencePairLimits]) -> list[Collaborator]:
    """The directory with each reported model's limits on its entries."""
    by_model = {(pair.provider, pair.model): pair.limits for pair in reversed(reported)}
    return [
        Collaborator(
            entry=entry,
            limits=by_model.get((entry.agent.provider, entry.agent.model))
            if isinstance(entry.agent, AgentSoftware) and entry.agent.provider is not None and entry.agent.model is not None
            else None,
        )
        for entry in directory
    ]


def _listed(answer: GetAnnotationsResponse) -> list[Annotation]:
    return answer.annotations


async def _next[S](states: AsyncIterator[S]) -> S | None:
    """The next state, or nothing when there will be no other."""
    return await anext(states, None)


@final
class _Joined:
    """The directory's state, with what the key holders have reported so far.

    A holder that has not answered delays only its own models' limits.
    """

    def __init__(
        self,
        directory: AsyncIterator[CacheState[list[CollaboratorEntry]]],
        reports: list[AsyncIterator[CacheState[list[InferencePairLimits]]]],
    ) -> None:
        self._directory: Final = directory
        self._reports: Final = reports
        self._entries: CacheState[list[CollaboratorEntry]] | None = None
        self._reported: Final[list[list[InferencePairLimits]]] = [[] for _ in reports]
        self._shown: CacheState[list[Collaborator]] | None = None
        """The state last given: a report that changes nothing a watcher is shown is not a state."""

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> CacheState[list[Collaborator]]:
        while True:
            directory = asyncio.ensure_future(_next(self._directory))
            reports = [asyncio.ensure_future(_next(report)) for report in self._reports]
            waits: list[asyncio.Task[object]] = [directory, *reports]
            try:
                await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
            finally:
                # One that has not answered has taken nothing: it is asked again the next time.
                for wait in waits:
                    wait.cancel()
            changed = False
            if directory.done():
                entries = directory.result()
                if entries is None:
                    raise StopAsyncIteration
                self._entries, changed = entries, True
            for index, report in enumerate(reports):
                if report.done():
                    state = report.result()
                    if state is None:
                        # The caches end together, when their client closes.
                        raise StopAsyncIteration
                    # A holder's report is pending, then what it reported: it never fails (`Live`).
                    if isinstance(state, Ready):
                        self._reported[index], changed = state.value, True
            if self._entries is not None and changed:
                joined = shown(self._entries, self._with_limits)
                if joined != self._shown:
                    self._shown = joined
                    return joined

    def _with_limits(self, entries: list[CollaboratorEntry]) -> list[Collaborator]:
        return _joined(entries, [pair for report in self._reported for pair in report])


@final
class _Collaborators(Source[list[Collaborator]]):
    """The collaborator directory with each key holder's limits joined on."""

    def __init__(self, live: Live) -> None:
        self._live: Final = live

    @override
    async def fresh(self) -> list[Collaborator]:
        try:
            async with asyncio.TaskGroup() as asking:
                # The directory is asked for first; each key holder's limits after it.
                directory = asking.create_task(self._live.agents.fetch(WHOLE))
                reports = [asking.create_task(self._live.limits.fetch(holder)) for holder in LIMITS_HOLDERS]
        except* SemiontError as failed:
            # The directory's failure, or the client's closing: a holder that fails reports none, and fails nothing.
            raise failed.exceptions[0] from None
        return _joined(directory.result(), [pair for report in reports for pair in report.result()])

    @override
    def watch(self) -> AsyncIterator[CacheState[list[Collaborator]]]:
        directory = self._live.agents.observe(WHOLE)
        return _Joined(directory, [self._live.limits.observe(holder) for holder in LIMITS_HOLDERS])

    @override
    def invalidate(self) -> None:
        self._live.invalidate_agents()

    @override
    def hold(self) -> ResourceHold | None:
        return None


def _is_http_token(text: str) -> bool:
    return text != "" and all(character in _HTTP_TOKEN for character in text)


def _is_of_a_parameter_value(character: str) -> bool:
    """Whether a parameter's value may hold it: a tab, U+0020 to U+007E, and U+0080 to U+00FF."""
    return character == "\t" or " " <= character <= "~" or "\x80" <= character <= "\xff"


def _quoted_string(text: str, start: int) -> tuple[str, int]:
    """The quoted string that opens at `start`, without its quotation marks, and where it ends."""
    position = start + 1
    value: list[str] = []
    while True:
        opened = position
        while position < len(text) and text[position] not in '"\\':
            position += 1
        value.append(text[opened:position])
        if position >= len(text):
            break
        mark = text[position]
        position += 1
        if mark == '"':
            break
        # A backslash gives the character after it, and at the very end is itself.
        if position >= len(text):
            value.append("\\")
            break
        value.append(text[position])
        position += 1
    return "".join(value), position


def _charset(content_type: str) -> str | None:
    """The value of a content type's `charset` parameter, as the MIME Sniffing Standard parses a MIME type.

    The first parameter of that name that is one. None where there is none,
    and where the content type is no MIME type.
    """
    text = content_type.strip(_HTTP_WHITE_SPACE)
    kind, slash, rest = text.partition("/")
    if slash == "" or not _is_http_token(kind):
        return None
    subtype = rest.partition(";")[0]
    if not _is_http_token(subtype.rstrip(_HTTP_WHITE_SPACE)):
        return None
    position = len(kind) + 1 + len(subtype)
    while position < len(text):
        position += 1  # past the semicolon
        while position < len(text) and text[position] in _HTTP_WHITE_SPACE:
            position += 1
        opened = position
        while position < len(text) and text[position] not in ";=":
            position += 1
        name = text[opened:position].translate(_ASCII_LOWER)
        if position < len(text):
            if text[position] == ";":
                continue
            position += 1  # past the equals sign
        if position >= len(text):
            break
        if text[position] == '"':
            value, position = _quoted_string(text, position)
            while position < len(text) and text[position] != ";":
                position += 1
        else:
            opened = position
            while position < len(text) and text[position] != ";":
                position += 1
            value = text[opened:position].rstrip(_HTTP_WHITE_SPACE)
            if value == "":
                continue
        if name == "charset" and all(_is_of_a_parameter_value(character) for character in value):
            return value
    return None


def _stated_encoding(content_type: str) -> tuple[str, str] | None:
    """The encoding a content type states, and the label it states it by. None where it states none, or an empty one.

    The label is the Encoding Standard's: in lower case, without the white
    space around it. One the standard lacks is refused, and so is one of an
    encoding it reads no text under.
    """
    stated = _charset(content_type)
    if stated is None or stated == "":
        return None
    label = stated.strip(_ASCII_WHITE_SPACE).translate(_ASCII_LOWER)
    encoding = ENCODING_OF_LABEL.get(label)
    if encoding is None or encoding in REFUSED:
        raise TransportError(
            "error", f"The resource's text is {stated}, which is no charset the Encoding Standard decodes: read its bytes instead"
        )
    return encoding, label


def _text(content: Content) -> str:
    """Bytes as the text they are, by the rule every reader of a resource's text keeps.

    The rule is `docs/protocol/W3C-SELECTORS.md`'s ("The text of a
    resource"): the MIME Sniffing Standard's reading of the content type and
    the Encoding Standard's reading of the bytes, as a browser follows the
    two. The charset is the one the content type states, UTF-8 when it states
    none, and is a label of the Encoding Standard: any other is refused,
    whatever the bytes are. Bytes that begin with the byte-order mark of
    UTF-8, UTF-16BE or UTF-16LE are in that encoding, whatever was stated,
    and the mark is not part of the text. What the encoding does not have is
    U+FFFD. A refusal names the charset: nothing is read as something it is
    not, and the bytes are there to read (`resource_representation`).

    The labels and the single-byte encodings are the standard's, from the
    table generated of it (`semiont._encodings`), and not Python's own, which
    differ from it.
    """
    stated = _stated_encoding(content.content_type)
    data = content.data
    for mark, decoder in _MARKS:
        if data.startswith(mark):
            return data[len(mark) :].decode(decoder, "replace")
    if stated is None:
        return data.decode("utf-8", "replace")
    encoding, label = stated
    if encoding in _PYTHONS_OWN:
        return data.decode(_PYTHONS_OWN[encoding], "replace")
    if encoding in SINGLE_BYTE:
        return data.decode("latin-1").translate(SINGLE_BYTE[encoding])
    # What is left is the standard's legacy multi-byte encodings, which this
    # reader has no table of: Python's own codec of the label, where it has
    # one, reads them.
    try:
        legacy = codecs.lookup(label)
    except LookupError:
        raise TransportError(
            "error", f"The resource's text is {label}, which this SDK has no decoder for: read its bytes instead"
        ) from None
    return legacy.decode(data, "replace")[0]


@final
class BrowseNamespace:
    """See the module's documentation."""

    def __init__(self, links: Links, content: ContentTransport, live: Live) -> None:
        self._links: Final = links
        self._content: Final = content
        self._live: Final = live

    # ── Queries ─────────────────────────────────────────────────────────

    def _of[K: Hashable, V, T](self, resource_id: ResourceId, cache: Cache[K, V], key: K, view: Callable[[V], T]) -> Cached[T]:
        """A query of one resource: watching it holds the resource's scope."""
        return self._live.query(Keyed(cache, key, view, scope=(self._links.wire.transport, resource_id)))

    def resource(self, resource_id: ResourceId) -> Cached[ResourceDescriptor]:
        """A resource's description."""
        return self._of(resource_id, self._live.resource, resource_id, itself)

    def resources(
        self, *, limit: int = _LIST_LIMIT, archived: bool | None = None, entity_type: str | None = None
    ) -> Cached[ListResourcesResponse]:
        """A page of the resources the filters admit: the first hundred when no limit is stated.

        It is kept true by what every client hears and by the events of the
        resources this client holds the scope of, and by nothing else.
        Finding resources by text is `match.resources`.
        """
        return self._live.query(Keyed(self._live.lists, ResourceFilters(limit, archived, entity_type), itself))

    def annotations(self, resource_id: ResourceId) -> Cached[list[Annotation]]:
        """A resource's annotations."""
        return self._of(resource_id, self._live.annotations, resource_id, _listed)

    def annotation(self, resource_id: ResourceId, annotation_id: AnnotationId) -> Cached[Annotation]:
        """One annotation of a resource."""
        self._live.annotation_of[annotation_id] = resource_id
        return self._of(resource_id, self._live.annotation, annotation_id, itself)

    def entity_types(self) -> Cached[list[str]]:
        """The knowledge base's entity types."""
        return self._live.query(Keyed(self._live.entity_types, WHOLE, itself))

    def tag_schemas(self) -> Cached[list[TagSchema]]:
        """The knowledge base's tag schemas."""
        return self._live.query(Keyed(self._live.tag_schemas, WHOLE, itself))

    def agents(self) -> Cached[list[Collaborator]]:
        """The knowledge base's collaborators.

        The directory, asked for first, with each model's limits as the
        services holding its credentials report them.
        """
        return self._live.query(_Collaborators(self._live))

    def events(self, resource_id: ResourceId) -> Cached[list[AttributedEvent]]:
        """A resource's events, each with who it is attributed to."""
        return self._of(resource_id, self._live.events, resource_id, itself)

    # ── One-shot reads ──────────────────────────────────────────────────

    async def resource_content(self, resource_id: ResourceId) -> str:
        """A resource's bytes as the text they are.

        In the charset their content type states, UTF-8 when it states none,
        and in the encoding of a byte-order mark where they begin with one.
        """
        return _text(await self._content.get_binary(resource_id))

    async def resource_graph(self, resource_id: ResourceId) -> GetResourceResponse:
        """A resource's description as linked data: itself, its annotations and the references to it."""
        return await self._content.get_resource_graph(resource_id)

    async def resource_anchored_text(self, resource_id: ResourceId) -> AnchoredTextAnswer:
        """A resource's anchored text: the text of its content with where each run is on a page, a stored decline, or why there is none."""
        return await self._content.get_anchored_text(resource_id)

    async def resource_representation(self, resource_id: ResourceId) -> Content:
        """A resource's bytes, unchanged, with their media type."""
        return await self._content.get_binary(resource_id)

    async def resource_representation_stream(self, resource_id: ResourceId) -> ContentStream:
        """The same, as a stream."""
        return await self._content.get_binary_stream(resource_id)

    async def resource_events(self, resource_id: ResourceId) -> list[AttributedEvent]:
        """A resource's events, each with who it is attributed to."""
        return await self._live.events_of(resource_id)

    async def annotation_history(self, resource_id: ResourceId, annotation_id: AnnotationId) -> GetAnnotationHistoryResponse:
        """The events of one annotation."""
        request = BrowseAnnotationHistoryRequest(resource_id=resource_id, annotation_id=annotation_id)
        return (await self._links.request(BROWSE_ANNOTATION_HISTORY_REQUESTED, request)).response

    async def files(self, path: str = ".", *, sort: BrowseDirectoryRequestSort = "name") -> BrowseDirectoryResultResponse:
        """The entries of a directory of the knowledge base's tree: its root when no path is stated, by name when no order is."""
        return (await self._links.request(BROWSE_DIRECTORY_REQUESTED, BrowseDirectoryRequest(path=path, sort=sort))).response

    async def kb(self) -> KbDescription:
        """What the knowledge base says of itself: its name and domain, and its working tree's branch.

        Asked every time: a branch changes with no event to say so.
        """
        return (await self._links.request(BROWSE_KB_REQUESTED, BrowseKbRequest())).response

    # ── Signals ─────────────────────────────────────────────────────────

    def click(self, annotation_id: AnnotationId) -> None:
        """Signal: open an annotation for this viewer."""
        self._links.signal(BROWSE_CLICK, BrowseClickEvent(annotation_id=annotation_id))

    def open_resource(self, resource_id: ResourceId) -> None:
        """Signal: open a resource for this viewer."""
        self._links.signal(BROWSE_RESOURCE_OPEN, BrowseResourceOpenEvent(resource_id=resource_id))

    def resource_viewed(self, resource_id: ResourceId) -> None:
        """Report that this viewer is looking at a resource. It goes over the wire, and nobody awaits it."""
        self._links.report(BROWSE_RESOURCE_VIEWED, BrowseResourceViewedEvent(resource_id=resource_id))
