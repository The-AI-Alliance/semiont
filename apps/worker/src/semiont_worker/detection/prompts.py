"""What a `mark` job says to its model: the prompt of each kind of detection, around one piece of the text.

A prompt asks for the text of each span, `exact`, and for what stands before
and after it, and never for an offset: where a span is, is found in the text
afterwards. The words are those the worker service's suite holds a worker to,
as the files of `tests/conformance/worker-service/prompts` state them.

Two languages may be named, and neither depends on the other. `language` is
the one the model is to write in, which matters to a comment and to an
assessment and to nothing else a detection makes. `source_language` is the
one the text is in. Each is said by its English name.

A prompt carries its piece as it is given. Whoever cuts the piece sizes it,
and a prompt that cut it again would lose text without a word.

Where a line of a prompt is longer than a line of this file may be, it is
written over several, each but the last ending in a backslash: the lines are
one in the prompt.
"""

from collections.abc import Sequence
from typing import Final

from semiont.types import TagCategory, TagSchema

from semiont_worker.locales import language_name
from semiont_worker.numbers import as_javascript_writes


def _in_the_language(source_language: str | None) -> str:
    """The line that says what language the text is in, where the job says."""
    return f"\n\nSource text language: {language_name(source_language)}." if source_language else ""


def _to_be_written_in(language: str | None, what: str) -> str:
    """The line that says what language the model is to write in, where the job says and it is not English."""
    if not language or language == "en":
        return ""
    return f"\n\nIMPORTANT: Write your {what} in {language_name(language)}."


_COMMENTS_AS_INSTRUCTED: Final = """
---

Return a JSON array of comments. Each comment must have:
- "exact": the exact text passage being commented on (quoted verbatim from source)
- "prefix": up to 64 characters of text immediately before the passage
- "suffix": up to 64 characters of text immediately after the passage
- "comment": your comment following the instructions above

Respond with a valid JSON array.

Example:
[
  {"exact": "the quarterly review meeting", "prefix": "We need to schedule ", "suffix": " for next month.", \
"comment": "Who will lead this? Should we invite the external auditors?"}
]"""

_COMMENTS_THAT_EXPLAIN: Final = """
---

Return a JSON array of comments. Each comment should have:
- "exact": the exact text passage being commented on (quoted verbatim from source)
- "prefix": up to 64 characters of text immediately before the passage
- "suffix": up to 64 characters of text immediately after the passage
- "comment": your explanatory comment (1-3 sentences, provide context/background/clarification)

Respond with a valid JSON array.

Example format:
[
  {"exact": "Ouranos", "prefix": "In the beginning, ", "suffix": " ruled the universe", \
"comment": "Ouranos (also spelled Uranus) is the primordial Greek deity personifying the sky. \
In Hesiod's Theogony, he is the son and husband of Gaia (Earth) and father of the Titans."}
]"""


def comment_prompt(
    content: str,
    *,
    instructions: str | None,
    tone: str | None,
    density: float | None,
    language: str | None,
    source_language: str | None,
) -> str:
    """The prompt of a commenting job, around `content`.

    With `instructions` it follows them, with the `tone` and the `density`
    the job states. With none it asks for comments that explain. `density`
    is how many comments to aim for in 2000 words.
    """
    languages = _in_the_language(source_language) + _to_be_written_in(language, "comments")
    if instructions:
        in_tone = f" Use a {tone} tone." if tone else ""
        how_many = f"\n\nAim for approximately {as_javascript_writes(density)} comments per 2000 words of text." if density else ""
        return (
            "Add comments to passages in this text following these instructions:\n"
            "\n"
            f"{instructions}{in_tone}{how_many}{languages}\n"
            "\n"
            "Text to analyze:\n"
            "---\n"
            f"{content}{_COMMENTS_AS_INSTRUCTED}"
        )
    in_tone = f"\n\nTone: Use a {tone} style in your comments." if tone else ""
    how_many = (
        f"\n- Aim for approximately {as_javascript_writes(density)} comments per 2000 words"
        if density
        else "\n- Aim for 3-8 comments per 2000 words (not too sparse or dense)"
    )
    return (
        "Identify passages in this text that would benefit from explanatory comments.\n"
        f"For each passage, provide contextual information, clarification, or background.{in_tone}\n"
        "\n"
        "Guidelines:\n"
        "- Select passages that reference technical terms, historical figures, complex concepts, or unclear references\n"
        "- Provide comments that ADD VALUE beyond restating the text\n"
        "- Focus on explanation, background, or connections to other ideas\n"
        "- Avoid obvious or trivial comments\n"
        f"- Keep comments concise (1-3 sentences typically){how_many}{languages}\n"
        "\n"
        "Text to analyze:\n"
        "---\n"
        f"{content}{_COMMENTS_THAT_EXPLAIN}"
    )


_HIGHLIGHTS_AS_INSTRUCTED: Final = """
---

Return a JSON array of highlights. Each highlight must have:
- "exact": the exact text passage to highlight (quoted verbatim from source)
- "prefix": up to 64 characters of text immediately before the passage
- "suffix": up to 64 characters of text immediately after the passage

Respond with a valid JSON array.

Example:
[
  {"exact": "revenue grew 45% year-over-year", "prefix": "In Q3 2024, ", "suffix": ", exceeding all forecasts."}
]"""

_HIGHLIGHTS_OF_WHAT_MATTERS: Final = """
---

Return a JSON array of highlights. Each highlight should have:
- "exact": the exact text passage to highlight (quoted verbatim from source)
- "prefix": up to 64 characters of text immediately before the passage
- "suffix": up to 64 characters of text immediately after the passage

Respond with a valid JSON array.

Example format:
[
  {"exact": "we will discontinue support for legacy systems by March 2025", \
"prefix": "After careful consideration, ", "suffix": ". This decision affects"}
]"""


def highlight_prompt(content: str, *, instructions: str | None, density: float | None, source_language: str | None) -> str:
    """The prompt of a highlighting job, around `content`.

    With `instructions` it follows them, with the `density` the job states.
    With none it asks for what is important in the text. `density` is how
    many highlights to aim for in 2000 words.
    """
    in_the_language = _in_the_language(source_language)
    if instructions:
        how_many = f"\n\nAim for approximately {as_javascript_writes(density)} highlights per 2000 words of text." if density else ""
        return (
            "Identify passages in this text to highlight following these instructions:\n"
            "\n"
            f"{instructions}{how_many}{in_the_language}\n"
            "\n"
            "Text to analyze:\n"
            "---\n"
            f"{content}{_HIGHLIGHTS_AS_INSTRUCTED}"
        )
    how_many = (
        f"\n- Aim for approximately {as_javascript_writes(density)} highlights per 2000 words"
        if density
        else "\n- Aim for 3-8 highlights per 2000 words (be selective)"
    )
    return (
        "Identify passages in this text that merit highlighting for their importance or salience.\n"
        "Focus on content that readers should notice and remember.\n"
        "\n"
        "Guidelines:\n"
        "- Highlight key claims, findings, or conclusions\n"
        "- Highlight important definitions, terminology, or concepts\n"
        "- Highlight notable quotes or particularly striking statements\n"
        "- Highlight critical decisions, action items, or turning points\n"
        "- Select passages that are SIGNIFICANT, not just interesting\n"
        f"- Avoid trivial or obvious content{how_many}{in_the_language}\n"
        "\n"
        "Text to analyze:\n"
        "---\n"
        f"{content}{_HIGHLIGHTS_OF_WHAT_MATTERS}"
    )


_ASSESSMENTS_AS_INSTRUCTED: Final = """
---

Return a JSON array of assessments. Each assessment must have:
- "exact": the exact text passage being assessed (quoted verbatim from source)
- "prefix": up to 64 characters of text immediately before the passage
- "suffix": up to 64 characters of text immediately after the passage
- "assessment": your assessment following the instructions above

Respond with a valid JSON array.

Example:
[
  {"exact": "the quarterly revenue target", "prefix": "We established ", "suffix": " for Q4 2024.", \
"assessment": "This target seems ambitious given market conditions. Consider revising based on recent trends."}
]"""

_ASSESSMENTS_THAT_EVALUATE: Final = """
---

Return a JSON array of assessments. Each assessment should have:
- "exact": the exact text passage being assessed (quoted verbatim from source)
- "prefix": up to 64 characters of text immediately before the passage
- "suffix": up to 64 characters of text immediately after the passage
- "assessment": your analytical assessment (1-3 sentences, evaluate validity/strength/implications)

Respond with a valid JSON array.

Example format:
[
  {"exact": "AI will replace most jobs by 2030", "prefix": "Many experts predict that ", "suffix": ", fundamentally reshaping", \
"assessment": "This claim lacks nuance and supporting evidence. \
Employment patterns historically show job transformation rather than wholesale replacement. \
The timeline appears speculative without specific sector analysis."}
]"""


def assessment_prompt(
    content: str,
    *,
    instructions: str | None,
    tone: str | None,
    density: float | None,
    language: str | None,
    source_language: str | None,
) -> str:
    """The prompt of an assessing job, around `content`.

    With `instructions` it follows them, with the `tone` and the `density`
    the job states. With none it asks for assessments that evaluate.
    `density` is how many assessments to aim for in 2000 words.
    """
    languages = _in_the_language(source_language) + _to_be_written_in(language, "assessments")
    if instructions:
        in_tone = f" Use a {tone} tone." if tone else ""
        how_many = f"\n\nAim for approximately {as_javascript_writes(density)} assessments per 2000 words of text." if density else ""
        return (
            "Assess passages in this text following these instructions:\n"
            "\n"
            f"{instructions}{in_tone}{how_many}{languages}\n"
            "\n"
            "Text to analyze:\n"
            "---\n"
            f"{content}{_ASSESSMENTS_AS_INSTRUCTED}"
        )
    in_tone = f"\n\nTone: Use a {tone} style in your assessments." if tone else ""
    how_many = (
        f"\n- Aim for approximately {as_javascript_writes(density)} assessments per 2000 words"
        if density
        else "\n- Aim for 2-6 assessments per 2000 words (focus on key passages)"
    )
    return (
        "Identify passages in this text that merit critical assessment or evaluation.\n"
        f"For each passage, provide analysis of its validity, strength, or implications.{in_tone}\n"
        "\n"
        "Guidelines:\n"
        "- Select passages containing claims, arguments, conclusions, or assertions\n"
        "- Assess evidence quality, logical soundness, or practical implications\n"
        "- Provide assessments that ADD INSIGHT beyond restating the text\n"
        "- Focus on passages where evaluation would help readers form judgments\n"
        f"- Keep assessments concise yet substantive (1-3 sentences typically){how_many}{languages}\n"
        "\n"
        "Text to analyze:\n"
        "---\n"
        f"{content}{_ASSESSMENTS_THAT_EVALUATE}"
    )


# The last example's `\n` are the two characters, a backslash and an n: it is JSON, as the model is to write it.
_TAGS: Final = """
---

Return a JSON array of tags. Each tag should have:
- "exact": the exact text passage (quoted verbatim from source)
- "prefix": up to 64 characters of text immediately before the passage
- "suffix": up to 64 characters of text immediately after the passage

Respond with a valid JSON array.

Example format:
[
  {"exact": "What duty did the defendant owe?", "prefix": "The central question is: ", "suffix": " This question must be"},
  {"exact": "In tort law, a duty of care is established when...", "prefix": "Legal framework:\\n", "suffix": "\\n\\nApplying this standard"}
]"""


def tag_prompt(content: str, schema: TagSchema, category: TagCategory, *, source_language: str | None) -> str:
    """The prompt of a tagging job for one `category` of its `schema`, around `content`.

    A tag's category is the schema's own word, which the model does not
    write: so no language is asked for, and only the text's is said.
    """
    key_questions = "\n".join(f"- {example}" for example in category.examples)
    return (
        f"You are analyzing a text using the {schema.name} framework.\n"
        "\n"
        f"Schema: {schema.description}\n"
        f"Domain: {schema.domain}\n"
        "\n"
        f'Your task: Identify passages that serve the structural role of "{category.name}".\n'
        "\n"
        f"Category: {category.name}\n"
        f"Description: {category.description}\n"
        "Key questions:\n"
        f"{key_questions}\n"
        "\n"
        "Guidelines:\n"
        "- Focus on STRUCTURAL FUNCTION, not semantic content\n"
        f'- A passage serves the "{category.name}" role if it performs this function in the document\'s structure\n'
        "- Look for passages that explicitly fulfill this role\n"
        "- Passages can be sentences, paragraphs, or sections\n"
        "- Aim for precision - only tag passages that clearly serve this structural role\n"
        f"- Typical documents have 1-5 instances of each category (some may have 0){_in_the_language(source_language)}\n"
        "\n"
        "Text to analyze:\n"
        "---\n"
        f"{content}{_TAGS}"
    )


_NAMES_ONLY: Final = """
Find direct mentions only (names, proper nouns). Do not include pronouns or descriptive references.
"""

_NAMES_AND_DESCRIPTIONS: Final = """
Include both:
- Direct mentions (names, proper nouns)
- Descriptive references (substantive phrases that refer to entities)

For descriptive references, include:
- Definite descriptions: "the Nobel laureate", "the tech giant", "the former president"
- Role-based references: "the CEO", "the physicist", "the author", "the owner", "the contractor"
- Epithets with context: "the Cupertino-based company", "the iPhone maker"
- References to entities even when identity is unknown or unspecified

Do NOT include:
- Simple pronouns alone: he, she, it, they, him, her, them
- Generic determiners alone: this, that, these, those
- Possessives without substance: his, her, their, its

Examples:
- For "Marie Curie", include "the Nobel laureate" and "the physicist" but NOT "she"
- For an unknown person, include "the owner" or "the contractor" (role-based references count even when identity is unspecified)
"""

_MENTIONS: Final = '''
"""

Respond with a JSON array of entities found. Each entity should have:
- exact: the exact text span from the input (quoted verbatim — character-for-character)
- entityType: one of the provided entity types
- prefix: up to 64 characters of text immediately before the entity (used to disambiguate when the same text appears more than once)
- suffix: up to 64 characters of text immediately after the entity (same purpose)

If no entities are found, respond with an empty array [].

Example output:
[{"exact":"Alice","entityType":"Person","prefix":"","suffix":" went to"},\
{"exact":"Paris","entityType":"Location","prefix":"went to ","suffix":" yesterday"}]'''


def asked_for(entity_types: Sequence[str]) -> str:
    """The entity types one call asks about, as its prompts name them."""
    return ", ".join(entity_types)


def mention_prompt(content: str, entity_types: Sequence[str], *, include_descriptive_references: bool, source_language: str | None) -> str:
    """The prompt of a linking job's extraction, around `content`: the mentions of `entity_types`.

    It asks for names alone, or with `include_descriptive_references` for a
    description that stands for an entity too ("the physicist"), and never
    for a bare pronoun.
    """
    which = _NAMES_AND_DESCRIPTIONS if include_descriptive_references else _NAMES_ONLY
    in_the_language = f"\nSource text language: {language_name(source_language)}.\n" if source_language else ""
    return (
        f"Identify entity references in the following text. Look for mentions of: {asked_for(entity_types)}.\n"
        f"{which}{in_the_language}\n"
        "Text to analyze:\n"
        '"""\n'
        f"{content}{_MENTIONS}"
    )


def count_prompt(content: str, entity_types: Sequence[str]) -> str:
    """The prompt of a linking job's count, around `content`: how many mentions of `entity_types` the same piece holds.

    It asks of the same text, of the same types, in the same words, whatever
    the extraction was asked.
    """
    return (
        f"Count every mention of: {asked_for(entity_types)} in the following text. "
        "Repeated mentions of the same entity count separately. Respond with only the number.\n"
        "\n"
        "Text:\n"
        '"""\n'
        f"{content}\n"
        '"""'
    )
