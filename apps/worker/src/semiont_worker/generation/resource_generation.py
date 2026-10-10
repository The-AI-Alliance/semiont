"""Asking a model for a document on a topic, from the context gathered for it.

The document is Markdown, plain text, or Typst source that the worker then
compiles to a PDF, as the job's output media type says. The prompt is made of
what the job asks for and of the context: the annotation or the resource in
focus, the neighbourhood the knowledge graph shows, and the passages found
similar. Every passage the prompt shows is labelled with the id of its
source in square brackets, which is what a model cites by.

The words of the prompt are the TypeScript worker's, for as long as there is
one: the tests hold each piece of text here to that worker's source.
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Final, final

from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import (
    GatheredContext,
    GatheredContextFocusAnnotation,
    GatheredContextFocusResource,
    GenerationJobParams,
    SemanticMatch,
    SupportedMediaType,
    TextualBody,
)
from semiont_inference.interface import InferenceClient

from semiont_worker.chunking import estimate_tokens
from semiont_worker.failure_class import DeterministicJobError
from semiont_worker.generation.graph_views import Connection, derive_views
from semiont_worker.inference_call import bounded_generate_text
from semiont_worker.locales import language_name
from semiont_worker.log import LOG
from semiont_worker.numbers import as_javascript_writes
from semiont_worker.white_space import trimmed

DEFAULT_MAX_TOKENS: Final = 500
"""How long a document is asked for, in tokens, where the job states no length: a short definition's."""

DEFAULT_TEMPERATURE: Final = 0.7
"""The temperature a document is asked for at, where the job states none."""

RESOURCE_CONTENT_CAP: Final = 4000
"""How much of a resource's content a prompt carries, in code points. What is past it never reaches the model."""

SEMANTIC_MATCH_LIMIT: Final = 3
"""How many of the similar passages a prompt carries: the best by score."""

SEMANTIC_MATCH_CODE_POINTS: Final = 240
"""How much of each similar passage a prompt carries, in code points."""


@final
@dataclass(frozen=True, slots=True)
class Repair:
    """A Typst source that did not compile, and what the compiler said of it: what the model is handed to write the document again."""

    source: str
    error: str


@final
@dataclass(frozen=True, slots=True)
class GeneratedDocument:
    """What a model wrote."""

    content: str
    """The document, in the format asked for."""
    truncated: bool
    """Whether the model was cut off at the length asked for: the document is then not whole."""


def tokens_asked(params: GenerationJobParams) -> int:
    """How long a document `params` asks for, in tokens: the job's `maxTokens`, or 500 where it states none.

    Raises a `DeterministicJobError` for a length that is no whole number. A
    job states its length as a JSON number, a model is asked for a whole
    number of tokens, and the job states the same length on every attempt.
    """
    if params.max_tokens is None:
        return DEFAULT_MAX_TOKENS
    if not params.max_tokens.is_integer():
        raise DeterministicJobError(
            f"The job asks for {as_javascript_writes(params.max_tokens)} tokens, and a model is asked for a whole number of them"
        )
    return int(params.max_tokens)


def _two_places(score: float) -> str:
    """`score` to two decimal places, a number exactly halfway between two rounded away from nought.

    Python's own formatting rounds such a number to the even neighbour: 0.625
    is `0.62` there, and `0.63` here.
    """
    return str(Decimal(score).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _id_label(resource_id: str, annotation_id: str | None) -> str:
    """The handle a passage is shown under, and cited by: its resource's id, and its annotation's after it where it came from one."""
    return f"[{resource_id}{f'/{annotation_id}' if annotation_id else ''}]"


def _annotation_sections(focus: GatheredContextFocusAnnotation) -> str:
    """What is said of an annotation in focus, and of the passage it marks."""
    annotation = focus.annotation
    parts = [
        f"- Annotation motivation: {annotation.motivation}",
        f"- Source resource: {focus.source_resource.name} {_id_label(focus.source_resource.id, None)}",
    ]
    # The words of a comment or an assessment are its first body's, where that is text.
    if annotation.motivation in ("commenting", "assessing"):
        first = annotation.body[0] if isinstance(annotation.body, list) else annotation.body
        if isinstance(first, TextualBody) and first.value:
            label = "Comment" if annotation.motivation == "commenting" else "Assessment"
            parts.append(f"- {label}: {first.value}")
    # A hint says what to write about, beside the passage or in its place.
    if focus.user_hint:
        parts.append(f"- User hint (steers what to generate): {focus.user_hint}")
    sections = "\n\nAnnotation context:\n" + "\n".join(parts)

    if focus.selected is not None:
        before = f"...{focus.selected.before}" if focus.selected.before else ""
        after = f"{focus.selected.after}..." if focus.selected.after else ""
        sections += f"\n\nSource document context:\n---\n{before}\n**[{focus.selected.text}]**\n{after}\n---\n"
    return sections


def _resource_sections(focus: GatheredContextFocusResource) -> str:
    """What is said of a resource in focus: its summary, the references suggested for it, and the content gathered with it."""
    parts = [f"- Resource: {focus.resource.name} {_id_label(focus.resource.id, None)}"]
    if focus.summary:
        parts.append(f"- Summary: {focus.summary}")
    if focus.suggested_references:
        parts.append(f"- Suggested references: {', '.join(focus.suggested_references)}")
    sections = "\n\nResource context:\n" + "\n".join(parts)

    content = focus.content
    if content is not None and content.main:
        sections += f"\n\nResource content:\n---\n{content.main[:RESOURCE_CONTENT_CAP]}\n---"
    if content is not None and content.related:
        blocks = "\n\n".join(f"[{resource_id}]\n{text[:RESOURCE_CONTENT_CAP]}" for resource_id, text in content.related.items())
        sections += f"\n\nRelated resource content:\n---\n{blocks}\n---"
    return sections


def _connection(connection: Connection) -> str:
    """A connected resource as a prompt names one: its name, its entity types where it has any, and its handle."""
    types = f" ({', '.join(connection.entity_types)})" if connection.entity_types else ""
    return f"{connection.resource_name}{types} {_id_label(connection.resource_id, None)}"


def _graph_section(context: GatheredContext, main_resource_id: ResourceId, focal_annotation_id: AnnotationId | None) -> str:
    """What the knowledge graph shows around the resource in focus, or nothing where it shows nothing."""
    views = derive_views(context.graph, main_resource_id, focal_annotation_id)
    parts: list[str] = []
    if views.connections:
        parts.append(f"- Connected resources: {', '.join(map(_connection, views.connections))}")
    if views.cited_by:
        count = len(views.cited_by)
        citers = ", ".join(f"{citer.resource_name} {_id_label(citer.resource_id, None)}" for citer in views.cited_by)
        parts.append(f"- This resource is cited by {count} other resource{'s' if count > 1 else ''}: {citers}")
    if views.sibling_entity_types:
        parts.append(f"- Related entity types in this document: {', '.join(views.sibling_entity_types)}")
    if context.inferred_relationship_summary:
        parts.append(f"- Relationship summary: {context.inferred_relationship_summary}")
    return "\n\nKnowledge graph context:\n" + "\n".join(parts) if parts else ""


def _semantic_section(similar: list[SemanticMatch]) -> str:
    """The passages found similar: the best few by score, each cut short and under its source's handle."""
    if not similar:
        return ""
    # The sort keeps passages of one score in the order the context gave them.
    best = sorted(similar, key=lambda match: match.score, reverse=True)[:SEMANTIC_MATCH_LIMIT]
    lines = [
        f"- {_id_label(match.resource_id, match.annotation_id)} ({_two_places(match.score)}){' [OCR]' if match.machine_read else ''} "
        f"{match.text[:SEMANTIC_MATCH_CODE_POINTS]}"
        for match in best
    ]
    # A passage marked so was recognized from a scanned image, and its wording, its digits above all, may
    # be misread. The model is the only reader of these passages, and is told.
    ocr_note = (
        "\nPassages marked [OCR] were read from scanned images by character recognition; "
        "treat their exact wording and numbers as uncertain, and say so if you rely on one."
        if any(match.machine_read for match in similar)
        else ""
    )
    return "\n\nRelated passages from the knowledge base:\n" + "\n".join(lines) + ocr_note


def _lead_line(task: str | None, topic: str) -> str:
    """What the model is asked to make of `topic`. A task that is none of the canonical three is the instruction itself."""
    if task is None or task == "resource":
        return f'Generate a concise, informative resource about "{topic}".'
    if task == "answer":
        return f'Answer the following question directly and concisely, grounded in the provided context: "{topic}"'
    if task == "summary":
        return f'Write a concise summary of "{topic}".'
    LOG.warning("Unknown task — using it verbatim as the framing instruction", extra={"task": task})
    return f'{task}\nTopic: "{topic}"'


def _structure_requirements(structure: str | None, output_media_type: SupportedMediaType) -> str:
    """How the document is to be organized, where the job says. Nothing is said where it does not: a length never decides a shape."""
    is_plain_text = output_media_type == "text/plain"
    is_pdf = output_media_type == "application/pdf"
    if structure == "sections":
        if is_pdf:
            return "\n- Organize the content into titled sections (= Heading) with well-structured paragraphs"
        if is_plain_text:
            return "\n- Organize the content into titled sections with well-structured paragraphs"
        title_requirement = "\n- Start with a clear heading (# Title)"
        return "\n- Organize the content into titled sections (## Section) with well-structured paragraphs" + title_requirement
    if structure == "prose":
        return "\n- Write flowing, well-structured paragraphs with no section headings"
    if structure == "chat":
        return (
            "\n- Structure the content as a conversational chat transcript — "
            "a sequence of alternating, speaker-labeled turns (no section headings)"
        )
    if structure:
        LOG.warning("Unknown structure — passing it through as freeform organization guidance", extra={"structure": structure})
        return f"\n- Organize the output as: {structure}"
    return ""


def _format_requirements(output_media_type: SupportedMediaType) -> str:
    """What the document is to be written in. For a PDF that is Typst, which the worker compiles."""
    if output_media_type == "application/pdf":
        return (
            "- Write the response as Typst markup (the Typst typesetting language — not markdown, not LaTeX)\n"
            "- Headings are written as = Heading (deeper levels == Subheading); everything else is plain prose paragraphs\n"
            "- Do not emit markdown syntax or code fences"
        )
    if output_media_type == "text/plain":
        return (
            "- Write the response as plain text — no formatting markup (no #, *, backticks, headings, or links)\n"
            "- Begin with the title on its own first line"
        )
    return "- Use markdown formatting\n- Write the response as markdown"


def generation_prompt(params: GenerationJobParams, output_media_type: SupportedMediaType, repair: Repair | None) -> str:
    """The prompt that asks for the document `params` describes, written as `output_media_type`.

    `output_media_type` is the format the job writes, as its caller settled
    it: the job's own, or Markdown where the job states none. `repair`, where
    one is given, is put before the model as its own failed attempt.

    A `task` or a `structure` that is none of the canonical ones is passed to
    the model as the job wrote it, and a warning says so.
    """
    # The language the document is written in and the language of what the prompt carries are two
    # things: a German reader may ask for a German account of an English source.
    language_instruction = (
        f"\n\nIMPORTANT: Write the entire resource in {language_name(params.language)}."
        if params.language and params.language != "en"
        else ""
    )
    source_language_instruction = (
        f"\n\nThe source resource and embedded context are in {language_name(params.source_language)}." if params.source_language else ""
    )

    context = params.context
    focus = context.focus
    if isinstance(focus, GatheredContextFocusAnnotation):
        focus_sections = _annotation_sections(focus)
        graph_section = _graph_section(context, focus.source_resource.id, focus.annotation.id)
    else:
        focus_sections = _resource_sections(focus)
        graph_section = _graph_section(context, focus.resource.id, None)
    semantic_section = _semantic_section([] if context.semantic_context is None else context.semantic_context.similar)

    lead_line = _lead_line(params.task, params.title)
    # The job's own prompt leads as an instruction: the task is what to make, and this is how.
    instruction = f"Instruction: {params.prompt}" if params.prompt else ""
    # The compiler's diagnostics go back to the model with the source they are of, to be fixed and written out whole.
    repair_section = (
        "\n\nYour previous attempt failed to compile. Fix the error and return the complete corrected document — "
        f"full source, not a diff.\nCompile error:\n{repair.error}\nPrevious source:\n{repair.source}"
        if repair is not None
        else ""
    )
    focus_on = f"Focus on these entity types: {', '.join(params.entity_types)}." if params.entity_types else ""
    # The model is asked to follow each claim with a token naming an id the context shows. The worker
    # takes the tokens out and makes a citation of each: none reaches what is stored.
    cite_requirement = (
        "\n- Ground every claim in the provided context. Immediately after each claim, cite its source by emitting [[<id>]], "
        "where <id> is an id shown in square brackets in the context above (for a passage labeled [abc], emit [[abc]]). "
        "Cite only ids that appear in the context."
        if params.cite
        else ""
    )

    return (
        f"{lead_line}\n"
        f"{instruction}{repair_section}\n"
        f"{focus_on}{focus_sections}{graph_section}{semantic_section}{source_language_instruction}{language_instruction}"
        f"\n\nRequirements:\n- Aim for approximately {as_javascript_writes(tokens_asked(params))} tokens of content\n"
        f"- Be factual and informative{_structure_requirements(params.structure, output_media_type)}{cite_requirement}\n"
        f"{_format_requirements(output_media_type)}"
    )


def document_of(response: str) -> str:
    """The document in a model's answer: the answer less the white space at its ends, and less a code fence around it."""
    content = trimmed(response)
    if content.startswith(("```markdown", "```md", "```typst")):
        content = content[content.find("\n") + 1 :]
    elif content.startswith("```"):
        content = content[3:]
    else:
        return content
    closing = content.rfind("```")
    return trimmed(content if closing == -1 else content[:closing])


async def generate_resource_from_topic(
    params: GenerationJobParams, output_media_type: SupportedMediaType, client: InferenceClient, repair: Repair | None
) -> GeneratedDocument:
    """Ask `client`'s model for the document `params` describes, and answer what it wrote.

    The call is one generation of text, at the job's temperature or 0.7,
    bounded as every call to a model is.

    Raises a `DeterministicJobError`, with nothing asked of the model, where
    the provider's one window holds both prompt and reply and the prompt and
    the length asked for are together over it: they fit on no attempt. A
    provider with a ceiling of its own on a reply is asked whatever the two
    come to, and refuses what it will not take.
    """
    max_tokens = tokens_asked(params)
    temperature = DEFAULT_TEMPERATURE if params.temperature is None else params.temperature
    LOG.debug(
        "Generating resource from topic",
        extra={
            "topicPreview": params.title[:100],
            "entityTypes": params.entity_types,
            "hasUserPrompt": bool(params.prompt),
            "locale": params.language,
            "sourceLanguage": params.source_language,
            "temperature": params.temperature,
            "maxTokens": params.max_tokens,
            "outputMediaType": output_media_type,
            "task": params.task,
            "structure": params.structure,
        },
    )
    prompt = generation_prompt(params, output_media_type, repair)

    limits = await client.limits()
    prompt_tokens = estimate_tokens(prompt)
    if limits.max_output_tokens >= limits.context_tokens and prompt_tokens + max_tokens > limits.context_tokens:
        raise DeterministicJobError(
            f"The prompt (~{prompt_tokens} tokens) and the {as_javascript_writes(max_tokens)} tokens asked for are together over "
            f"the context window of '{client.model_id}' ({limits.context_tokens} tokens)"
        )

    LOG.debug("Sending prompt to inference", extra={"promptLength": len(prompt), "temperature": temperature, "maxTokens": max_tokens})
    response = await bounded_generate_text(client, prompt, max_tokens, temperature, None)
    LOG.debug("Got response from inference", extra={"responseLength": len(response.text), "stopReason": response.stop_reason})

    content = document_of(response.text)
    LOG.debug("Parsed response", extra={"hasContent": bool(content), "contentLength": len(content)})
    # Only `max_tokens` says the document was cut off. Any other reason is a model that stopped of itself.
    return GeneratedDocument(content=content, truncated=response.stop_reason == "max_tokens")
