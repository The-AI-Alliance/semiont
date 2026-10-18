"""The citations of a generated text.

Under `cite` a model is asked to wrap the words of each claim in a token
that names the source it rests on: `[[<resourceId>: <claim>]]`, or
`[[<resourceId>/<annotationId>: <claim>]]` where the passage it read came from
an annotation, with several sources' ids separated by commas. Such a token is
MARKED: it is taken out of the text and its claim left where it stood, and its
citations are of exactly that claim. A BARE token, one with no claim,
`[[<resourceId>]]`, is replaced by the name the context gave its source, and
its citation is of exactly that name. So nothing is guessed. A token is
transport and never content. What a model invents is never linked: an id the
context did not show cites nothing, and a warning says so. Nor is a source
named that the context named only by its id.

A position here is an offset: it counts the text's code points, as a Python
string's own index does. `specs/src/worker/citation-cases.json` holds the
rule.
"""

import re
import string
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, final

from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import GatheredContext, GatheredContextFocusAnnotation, GraphResourceNode, SupportedMediaType
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

_ASCII_PUNCTUATION: Final = re.compile(f"[{re.escape(string.punctuation)}]")
"""The 32 ASCII punctuation characters: each is read as itself after a backslash, in Markdown and in Typst alike."""


@final
@dataclass(frozen=True, slots=True)
class GenerationCitation:
    """One claim of a generated text, and the source it cites."""

    resource_id: ResourceId
    """The resource cited: one the context showed."""
    annotation_id: AnnotationId | None
    """The annotation the cited passage came from, where the token named one: one the context showed."""
    start: int
    """Where the cited words start in the text without its tokens: the claim a marked token wrapped, or the name a bare one became."""
    end: int
    """Where it ends."""
    exact: str
    """The text between the two."""


@final
@dataclass(frozen=True, slots=True)
class CitableIds:
    """The ids a gathered context makes citable, and the names it gives them: what a token is held to, and what a bare one becomes.

    They are text and no ids yet. A context's related content is keyed by
    text, and a key that is no resource id is never cited.
    """

    resource_ids: frozenset[str]
    annotation_ids: frozenset[str]
    names: Mapping[str, str]
    """The name of each citable resource the context names by more than its id."""


@final
@dataclass(frozen=True, slots=True)
class ResolvedCitations:
    """A generated text without its tokens, and the citations they made."""

    content: str
    citations: list[GenerationCitation]


def collect_citable_ids(context: GatheredContext | None) -> CitableIds:
    """The ids the context put before the model, each of which the prompt labels a passage with, and the names it gave them.

    Of resources: the focus (for a focus that is an annotation, the resource
    the annotation is in), every node of the graph that is a resource, the
    resource of every semantically similar passage, and every key of a
    resource focus's related content. Of annotations: the one a similar
    passage came from, which is the only annotation id a label carries. Not
    the annotation a focus is, and not an annotation among the graph's nodes.
    There is none of either where there is no context.

    A resource's name is the first the context gives it, read in that order
    (the focus's name, a graph node's label, a similar passage's resource
    name), that is more than white space and more than the resource's id,
    without the white space at its ends. A key of the related content brings
    none. So a resource the context names only by its id, as the Librarian
    labels a citer whose view it could not read, has no name.
    """
    if context is None:
        return CitableIds(resource_ids=frozenset(), annotation_ids=frozenset(), names={})
    focus = context.focus
    resource_ids: set[str] = set()
    annotation_ids: set[str] = set()
    names: dict[str, str] = {}

    def named(resource_id: str, name: str) -> None:
        resource_ids.add(resource_id)
        words = trimmed(name)
        if words and words != resource_id:
            names.setdefault(resource_id, words)

    if isinstance(focus, GatheredContextFocusAnnotation):
        named(focus.source_resource.id, focus.source_resource.name)
    else:
        named(focus.resource.id, focus.resource.name)
        if focus.content is not None and focus.content.related is not None:
            resource_ids.update(focus.content.related)
    for node in context.graph.nodes:
        if isinstance(node, GraphResourceNode):
            named(node.id, node.label)
    if context.semantic_context is not None:
        for match in context.semantic_context.similar:
            named(match.resource_id, match.resource_name)
            if match.annotation_id is not None:
                annotation_ids.add(match.annotation_id)
    return CitableIds(resource_ids=frozenset(resource_ids), annotation_ids=frozenset(annotation_ids), names=names)


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


def _name_of(resource_id: ResourceId, citable: CitableIds) -> str | None:
    """The name the context gave a resource; or None, and a warning naming it, where the context named it only by its id."""
    name = citable.names.get(resource_id)
    if name is None:
        LOG.warning(
            "Citation token names a source the context gave no name but its id \N{EM DASH} dropped", extra={"resourceId": resource_id}
        )
    return name


def _written(name: str, written_as: SupportedMediaType) -> str:
    """`name` as a text in `written_as` writes it to be read as itself.

    Plain text is read as it is. Markdown, and Typst, which is what a PDF is
    written in, read a punctuation character as markup in some places and
    not in others, and each reads any ASCII punctuation character after a
    backslash as itself: so each of a name's is written after one, wherever
    the name stands. A format no rule here writes in is a fault.
    """
    if written_as == "text/plain":
        return name
    if written_as in ("text/markdown", "application/pdf"):
        return _ASCII_PUNCTUATION.sub(r"\\\g<0>", name)
    raise ValueError(f"No rule writes a cited name in {written_as}")


def resolve_citation_tokens(content: str, citable: CitableIds, written_as: SupportedMediaType) -> ResolvedCitations:
    """`content` without its citation tokens, and a citation for each of their citations that names what `citable` holds.

    Tokens are taken left to right. A marked token whose claim is not empty
    is replaced by its claim, and each of its citations cites exactly that
    claim. A bare token is replaced by the name `citable` holds for its
    source, as `written_as` writes it, and cites exactly that. A marked token
    whose claim is empty is taken as bare tokens are, one for each of its
    citations, in order, each after where the one before it ended. Where a
    token puts something in its place, the text since the token before it is
    kept as it is. Where it puts nothing, the spaces and tabs at the very end
    of that text are left out with it. The text after the last token is kept
    as it is.

    A citation cites nothing, and a warning names its first id, when that id
    is no `ResourceId` or is not among `citable`'s; when it has a second id
    that is no `AnnotationId` or is not among `citable`'s; and, of a bare
    token, when `citable` holds no name for its source. A marked token's
    claim stays in the text whatever its citations make.
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

        for resource, annotation in _citations_of(token):
            ids = _cited_ids(resource, annotation, citable)
            name = None if ids is None else _name_of(ids[0], citable)
            if ids is None or name is None:
                # A line end is neither a space nor a tab: spaces that stand before one are not at the end, and stay.
                clean += before.rstrip(" \t")
            else:
                # The name takes the token's place, so the space before the token is the name's to keep.
                clean += before
                start = len(clean)
                clean += _written(name, written_as)
                citations.append(
                    GenerationCitation(resource_id=ids[0], annotation_id=ids[1], start=start, end=len(clean), exact=clean[start:])
                )
            before = ""

    return ResolvedCitations(content=clean + content[last:], citations=citations)
