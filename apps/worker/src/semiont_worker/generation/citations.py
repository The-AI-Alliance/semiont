"""The citations of a generated text.

Under `cite` a model is asked to wrap the words of each claim in a token
that names the source it rests on: `[[<resourceId>: <claim>]]`, or
`[[<resourceId>/<annotationId>: <claim>]]` where the passage it read came from
an annotation, with several sources' ids separated by commas. Such a token is
MARKED: it is taken out of the text and its claim left where it stood, and its
citations are of exactly that claim. A BARE token, one with no claim,
`[[<resourceId>]]`, is taken out and cites the sentence before it. A token is
transport and never content. What a model invents is never linked: an id the
context did not show cites nothing, and a warning says so.

A position here is an offset: it counts the text's code points, as a Python
string's own index does. `specs/src/worker/citation-cases.json` holds the
rule.
"""

import re
from dataclasses import dataclass
from typing import Final, final

from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import GatheredContext, GatheredContextFocusAnnotation, GraphResourceNode
from semiont_service.white_space import WHITE_SPACE, trimmed

from semiont_worker.log import LOG

_WHITE: Final = re.escape("".join(sorted(WHITE_SPACE)))
"""White space, written to stand in a character class."""

_ID: Final = f"[^{_WHITE}\\[\\]/]+"
"""An id, as a bare token writes one: one or more characters, none of them white space, `[`, `]` or `/`."""

_MARKED_ID: Final = f"[^{_WHITE}\\[\\]/,:]+"
"""An id, as a marked token writes one: as a bare token's, and with no `,` or `:`, which part its citations and end them."""

_CITATION: Final = f"{_MARKED_ID}(?:/{_MARKED_ID})?"
"""One citation of a marked token: an id, or two parted by `/`."""

_TOKEN: Final = re.compile(
    rf"\[\[(?P<citations>{_CITATION}(?:[{_WHITE}]*,[{_WHITE}]*{_CITATION})*):(?P<claim>.*?)\]\]"
    rf"|\[\[(?P<resource>{_ID})(?:/(?P<annotation>{_ID}))?\]\]",
    re.DOTALL,
)
"""A marked token, `[[<citations>: <claim>]]`, whose claim ends at the first `]]`; or a bare one, `[[<id>]]` or `[[<id>/<id>]]`.

What can be read as marked is. Anything else in double brackets is no token, and stays in the text.
"""

_SENTENCE_MARKS: Final = frozenset(".!?")
"""The marks that end a sentence."""

_CLOSERS: Final = frozenset("\"'\u201d\u2019\u00bb)]}*_`~")
"""What may follow a sentence's mark and still be the sentence's own.

A closing quotation mark or bracket, and the marks that close emphasis, code
and struck text in Markdown, which a generated text is written in
(`**Bold.**`).
"""

_DIGITS: Final = frozenset("0123456789")
"""The digits a full stop is inside a number between. `str.isdigit` counts every script's."""


@final
@dataclass(frozen=True, slots=True)
class GenerationCitation:
    """One claim of a generated text, and the source it cites."""

    resource_id: ResourceId
    """The resource cited: one the context showed."""
    annotation_id: AnnotationId | None
    """The annotation the cited passage came from, where the token named one: one the context showed."""
    start: int
    """Where the claim starts in the text without its tokens."""
    end: int
    """Where it ends."""
    exact: str
    """The text between the two."""


@final
@dataclass(frozen=True, slots=True)
class CitableIds:
    """The ids a gathered context makes citable: what a token is held to.

    They are text and no ids yet. A context's related content is keyed by
    text, and a key that is no resource id is never cited.
    """

    resource_ids: frozenset[str]
    annotation_ids: frozenset[str]


@final
@dataclass(frozen=True, slots=True)
class ResolvedCitations:
    """A generated text without its tokens, and the citations they made."""

    content: str
    citations: list[GenerationCitation]


def collect_citable_ids(context: GatheredContext | None) -> CitableIds:
    """The ids the context put before the model, each of which the prompt labels a passage with.

    Of resources: the focus (for a focus that is an annotation, the resource
    the annotation is in), every node of the graph that is a resource, the
    resource of every semantically similar passage, and every key of a
    resource focus's related content. Of annotations: the one a similar
    passage came from, which is the only annotation id a label carries. Not
    the annotation a focus is, and not an annotation among the graph's nodes.
    There is none of either where there is no context.
    """
    if context is None:
        return CitableIds(resource_ids=frozenset(), annotation_ids=frozenset())
    focus = context.focus
    resource_ids: set[str] = set()
    annotation_ids: set[str] = set()

    if isinstance(focus, GatheredContextFocusAnnotation):
        resource_ids.add(focus.source_resource.id)
    else:
        resource_ids.add(focus.resource.id)
        if focus.content is not None and focus.content.related is not None:
            resource_ids.update(focus.content.related)
    resource_ids.update(node.id for node in context.graph.nodes if isinstance(node, GraphResourceNode))
    if context.semantic_context is not None:
        for match in context.semantic_context.similar:
            resource_ids.add(match.resource_id)
            if match.annotation_id is not None:
                annotation_ids.add(match.annotation_id)
    return CitableIds(resource_ids=frozenset(resource_ids), annotation_ids=frozenset(annotation_ids))


def _closes_sentence(text: str, at: int) -> bool:
    """Whether the character at `at` closes a sentence: a line feed, or a sentence mark.

    A full stop between two digits closes none: it is inside a number. A full
    stop after an abbreviation closes one like any other, since no
    abbreviation is known here.
    """
    character = text[at]
    if character == "\n":
        return True
    if character not in _SENTENCE_MARKS:
        return False
    inside_a_number = character == "." and 0 < at < len(text) - 1 and text[at - 1] in _DIGITS and text[at + 1] in _DIGITS
    return not inside_a_number


def _claim_before(text: str) -> tuple[int, int] | None:
    """The claim a token cites: the sentence that ends `text`, the text resolved so far, with its closing marks.

    It is answered as the two offsets it stands between, or as `None` where
    there is no claim to cite.
    """
    # The claim ends where the text does, less the white space at its end: a token on a line of its own
    # cites the sentence on the line before.
    end = len(text)
    while end > 0 and text[end - 1] in WHITE_SPACE:
        end -= 1

    # Its closing marks are its own, however many: an ellipsis, `?!`, a full stop inside a closing
    # quotation mark, a bracket or emphasis.
    marks = end
    while marks > 0 and (text[marks - 1] in _SENTENCE_MARKS or text[marks - 1] in _CLOSERS):
        marks -= 1

    # What closes the sentence before is the nearest close ahead of those.
    start = 0
    for at in range(marks - 1, -1, -1):
        if not _closes_sentence(text, at):
            continue
        start = at + 1
        # The closers that follow a sentence mark at once belong to the sentence it closed. One after
        # white space does not: an asterisk there is a list item's bullet, and begins the claim.
        if text[at] != "\n":
            while start < end and text[start] in _CLOSERS:
                start += 1
        break
    while start < end and text[start] in WHITE_SPACE:
        start += 1
    return (start, end) if start < end else None


def _cited_ids(resource: str, annotation: str | None, citable: CitableIds) -> tuple[ResourceId, AnnotationId | None] | None:
    """The ids a citation names, where the context showed them; or None, and a warning naming the first id, where it did not.

    The annotation a citation names is held as its resource is: an id by the
    spec's rule, and one the context showed. A citation half invented cites
    nothing.
    """
    resource_id = ResourceId.parse(resource)
    if resource_id is None or resource_id not in citable.resource_ids:
        LOG.warning("Citation token references an id absent from the provided context \N{EM DASH} dropped", extra={"resourceId": resource})
        return None
    annotation_id = None if annotation is None else AnnotationId.parse(annotation)
    if annotation is not None and (annotation_id is None or annotation_id not in citable.annotation_ids):
        LOG.warning(
            "Citation token references an annotation absent from the provided context \N{EM DASH} dropped",
            extra={"resourceId": resource, "annotationId": annotation},
        )
        return None
    return resource_id, annotation_id


def _citations_of(token: re.Match[str]) -> list[tuple[str, str | None]]:
    """Each citation a token names, as its ids, in the order it names them."""
    listed = token.group("citations")
    if listed is None:
        return [(token.group("resource"), token.group("annotation"))]
    named: list[tuple[str, str | None]] = []
    for citation in listed.split(","):
        resource, _, annotation = trimmed(citation).partition("/")
        named.append((resource, annotation or None))
    return named


def resolve_citation_tokens(content: str, citable: CitableIds) -> ResolvedCitations:
    """`content` without its citation tokens, and a citation for each of their citations that names what `citable` holds.

    Tokens are taken left to right. A marked token whose claim is not empty
    is replaced by its claim, the text since the token before it kept as it
    is, and each of its citations cites exactly that claim. Any other token,
    a bare one or a marked one with an empty claim, is left out, the spaces
    and tabs at the very end of the text since the token before it with it,
    and each of its citations cites the sentence before it. The text after
    the last token is kept as it is.

    A citation cites nothing, and a warning names its first id, when that id
    is no `ResourceId` or is not among `citable`'s; when it has a second id
    that is no `AnnotationId` or is not among `citable`'s; and when it is a
    bare one and no claim stands before it. A marked token's claim stays in
    the text whatever its citations make.
    """
    citations: list[GenerationCitation] = []
    # The text resolved so far. A position in it is final: what is added later moves nothing before it.
    clean = ""
    # Where `content` has been read to: just past the last token.
    last = 0

    for token in _TOKEN.finditer(content):
        before = content[last : token.start()]
        last = token.end()
        claimed = token.group("claim")
        claim = "" if claimed is None else trimmed(claimed)

        if claim:
            # The claim takes the token's place, so the space before the token is the claim's to keep.
            clean += before
            start = len(clean)
            clean += claim
            for resource, annotation in _citations_of(token):
                ids = _cited_ids(resource, annotation, citable)
                if ids is not None:
                    citations.append(GenerationCitation(resource_id=ids[0], annotation_id=ids[1], start=start, end=len(clean), exact=claim))
            continue

        # A line end is neither a space nor a tab: spaces that stand before one are not at the end, and stay.
        clean += before.rstrip(" \t")
        for resource, annotation in _citations_of(token):
            ids = _cited_ids(resource, annotation, citable)
            if ids is None:
                continue
            before_claim = _claim_before(clean)
            if before_claim is None:
                LOG.warning("Citation token has no preceding claim text \N{EM DASH} dropped", extra={"resourceId": resource})
                continue
            claim_start, claim_end = before_claim
            citations.append(
                GenerationCitation(
                    resource_id=ids[0], annotation_id=ids[1], start=claim_start, end=claim_end, exact=clean[claim_start:claim_end]
                )
            )

    return ResolvedCitations(content=clean + content[last:], citations=citations)
