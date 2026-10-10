"""What a detection says to its model, held to the prompts the worker service's suite holds a worker to.

Each file of `tests/conformance/worker-service/prompts` is the exact text of
one prompt, less its one final line end. A prompt built here from what the
suite's case asked with, around the piece of text the file carries, is that
file's text. What no file states is held to a file's text with the one thing
changed that the job changes.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, final

import pytest
from semiont.types import TagCategory, TagSchema
from spec import ROOT

from semiont_worker.detection.prompts import assessment_prompt, comment_prompt, count_prompt, highlight_prompt, mention_prompt, tag_prompt

PROMPTS: Final = ROOT / "tests/conformance/worker-service/prompts"

# The schema the suite's tagging jobs are handed with.
CLAIM: Final = TagCategory(name="Claim", description="What the text asserts", examples=["What is being asserted?"])
EVIDENCE: Final = TagCategory(
    name="Evidence", description="What supports the assertion", examples=["What supports it?", "Is a source given?"]
)
SCHEMA: Final = TagSchema(
    id="argument",
    name="Argument",
    description="What a text claims and what it offers in support",
    domain="rhetoric",
    tags=[CLAIM, EVIDENCE],
)

# What stands just before and just after the piece of text a prompt carries.
PASSAGES: Final = ("\n\nText to analyze:\n---\n", "\n---\n\nReturn a JSON array of ")
MENTIONS: Final = ('\n\nText to analyze:\n"""\n', '\n"""\n\nRespond with a JSON array of entities found.')
COUNT: Final = ('\n\nText:\n"""\n', '\n"""')


@final
@dataclass(frozen=True, slots=True)
class Asked:
    """A prompt of the suite: what its piece of text stands between, and the prompt the worker builds around that piece for its job."""

    around: tuple[str, str]
    build: Callable[[str], str]


def highlighting(piece: str) -> str:
    return highlight_prompt(piece, instructions=None, density=None, source_language=None)


def commenting(piece: str) -> str:
    return comment_prompt(piece, instructions=None, tone=None, density=None, language=None, source_language=None)


def assessing(piece: str) -> str:
    return assessment_prompt(piece, instructions=None, tone=None, density=None, language=None, source_language=None)


# A density is a JSON number, and the SDK's params hold one as a float: 5 is 5.0 there, and is said as 5.
ASKED: Final[dict[str, Asked]] = {
    "highlighting": Asked(PASSAGES, highlighting),
    "highlighting-dense": Asked(PASSAGES, lambda piece: highlight_prompt(piece, instructions=None, density=5.0, source_language="de")),
    "highlighting-instructed": Asked(
        PASSAGES, lambda piece: highlight_prompt(piece, instructions="Highlight every date.", density=2.0, source_language="en")
    ),
    "commenting": Asked(
        PASSAGES,
        lambda piece: comment_prompt(
            piece, instructions="Explain who each person was.", tone="scholarly", density=4.0, language="fr", source_language="en"
        ),
    ),
    "commenting-plain": Asked(PASSAGES, commenting),
    "commenting-toned": Asked(
        PASSAGES,
        lambda piece: comment_prompt(piece, instructions=None, tone="conversational", density=6.0, language="de", source_language="fr"),
    ),
    "code-points-commenting": Asked(PASSAGES, commenting),
    "assessing": Asked(
        PASSAGES,
        lambda piece: assessment_prompt(piece, instructions=None, tone="critical", density=None, language=None, source_language=None),
    ),
    "assessing-plain": Asked(PASSAGES, assessing),
    "assessing-instructed": Asked(
        PASSAGES,
        lambda piece: assessment_prompt(
            piece, instructions="Judge the evidence.", tone="balanced", density=3.0, language="ja", source_language="en"
        ),
    ),
    "tagging-claim": Asked(PASSAGES, lambda piece: tag_prompt(piece, SCHEMA, CLAIM, source_language=None)),
    "tagging-evidence": Asked(PASSAGES, lambda piece: tag_prompt(piece, SCHEMA, EVIDENCE, source_language=None)),
    "tagging-language": Asked(PASSAGES, lambda piece: tag_prompt(piece, SCHEMA, CLAIM, source_language="en")),
    "linking-person": Asked(
        MENTIONS, lambda piece: mention_prompt(piece, ["Person"], include_descriptive_references=False, source_language=None)
    ),
    "linking-place": Asked(
        MENTIONS, lambda piece: mention_prompt(piece, ["Place"], include_descriptive_references=False, source_language=None)
    ),
    "linking-descriptive": Asked(
        MENTIONS, lambda piece: mention_prompt(piece, ["Person"], include_descriptive_references=True, source_language="en")
    ),
    "linking-person-count": Asked(COUNT, lambda piece: count_prompt(piece, ["Person"])),
    "linking-place-count": Asked(COUNT, lambda piece: count_prompt(piece, ["Place"])),
    # The pieces of a long text, each asked about as a highlighting job with nothing else stated asks.
    **{f"chunks-{n}": Asked(PASSAGES, highlighting) for n in range(1, 5)},
    **{f"code-points-{n}": Asked(PASSAGES, highlighting) for n in range(1, 5)},
    **{f"halved-half-{n}": Asked(PASSAGES, highlighting) for n in range(1, 4)},
    **{f"halved-rest-{n}": Asked(PASSAGES, highlighting) for n in range(1, 7)},
    **{f"resume-{n}": Asked(PASSAGES, highlighting) for n in range(1, 5)},
}


def stated(name: str) -> str:
    """A prompt of the suite: its file's text, less its one final line end."""
    text = (PROMPTS / f"{name}.txt").read_text(encoding="utf-8")
    assert text.endswith("\n"), f"{name}.txt does not end with the one line end the suite takes off"
    return text[:-1]


def piece_of(prompt: str, around: tuple[str, str]) -> str:
    """The piece of text `prompt` carries: what stands between the first of the one mark and the last of the other."""
    before, after = around
    assert before in prompt, f"the prompt does not have {before!r}"
    start = prompt.index(before) + len(before)
    assert after in prompt[start:], f"the prompt does not have {after!r} after its text"
    return prompt[start : prompt.rindex(after)]


def test_every_prompt_of_the_suite_that_a_mark_job_sends_is_built_here() -> None:
    # A `yield` job's prompts are generation's. Every other file is one a detection sends, and a file added to the suite fails here.
    of_a_mark_job = {path.stem for path in PROMPTS.glob("*.txt") if not path.stem.startswith("yield-")}
    assert of_a_mark_job == set(ASKED)
    assert len(of_a_mark_job) >= 39


@pytest.mark.parametrize("name", sorted(ASKED))
def test_a_prompt_is_word_for_word_the_one_the_suite_holds_a_worker_to(name: str) -> None:
    prompt = stated(name)
    asked = ASKED[name]
    assert asked.build(piece_of(prompt, asked.around)) == prompt


PIECE: Final = "  Ada wrote the first program.\n\nBabbage built nothing.  \n"


# A prompt of every kind, and of each of the two ways a kind that takes instructions is asked.
CARRIERS: Final[list[tuple[Callable[[str], str], tuple[str, str]]]] = [
    (highlighting, PASSAGES),
    (lambda piece: highlight_prompt(piece, instructions="Highlight every date.", density=None, source_language=None), PASSAGES),
    (commenting, PASSAGES),
    (lambda piece: comment_prompt(piece, instructions="Explain.", tone=None, density=None, language=None, source_language=None), PASSAGES),
    (assessing, PASSAGES),
    (lambda piece: assessment_prompt(piece, instructions="Judge.", tone=None, density=None, language=None, source_language=None), PASSAGES),
    (lambda piece: tag_prompt(piece, SCHEMA, CLAIM, source_language=None), PASSAGES),
    (lambda piece: mention_prompt(piece, ["Person"], include_descriptive_references=False, source_language=None), MENTIONS),
    (lambda piece: count_prompt(piece, ["Person"]), COUNT),
]


@pytest.mark.parametrize(("build", "around"), CARRIERS)
def test_a_prompt_carries_its_piece_as_it_was_given(build: Callable[[str], str], around: tuple[str, str]) -> None:
    # Whoever cuts the piece sizes it and takes the white space off its ends. A prompt that cut or trimmed it again would lose text unseen.
    long = PIECE + "x" * 100_000
    assert piece_of(build(PIECE), around) == PIECE
    assert piece_of(build(long), around) == long


def test_an_assessment_with_no_instructions_states_a_density_and_the_languages_where_the_job_has_them() -> None:
    # No file of the suite states these three of an assessing job that has no instructions. They stand where a commenting job's do.
    prompt = stated("assessing-plain")
    default = "\n- Aim for 2-6 assessments per 2000 words (focus on key passages)\n"
    assert prompt.count(default) == 1
    asked = (
        "\n- Aim for approximately 3 assessments per 2000 words\n"
        "\nSource text language: French.\n"
        "\nIMPORTANT: Write your assessments in German.\n"
    )
    assert assessment_prompt(
        piece_of(prompt, PASSAGES), instructions=None, tone=None, density=3.0, language="de", source_language="fr"
    ) == prompt.replace(default, asked)


def test_a_density_that_is_no_whole_number_is_said_with_its_fraction() -> None:
    prompt = stated("highlighting-dense")
    assert prompt.count("approximately 5 highlights") == 1
    assert highlight_prompt(piece_of(prompt, PASSAGES), instructions=None, density=2.5, source_language="de") == prompt.replace(
        "approximately 5 highlights", "approximately 2.5 highlights"
    )


def test_text_to_be_written_in_english_is_asked_for_in_no_words() -> None:
    # English is what a model writes when it is told nothing.
    prompt = stated("commenting-plain")
    piece = piece_of(prompt, PASSAGES)
    assert comment_prompt(piece, instructions=None, tone=None, density=None, language="en", source_language=None) == prompt
    prompt = stated("assessing-plain")
    piece = piece_of(prompt, PASSAGES)
    assert assessment_prompt(piece, instructions=None, tone=None, density=None, language="en", source_language=None) == prompt


def test_a_language_is_found_by_its_tag_in_whatever_case_and_one_the_registry_lacks_is_said_as_its_tag() -> None:
    prompt = stated("highlighting-dense")
    piece = piece_of(prompt, PASSAGES)
    assert prompt.count("Source text language: German.") == 1
    assert highlight_prompt(piece, instructions=None, density=5.0, source_language="DE") == prompt
    for tag in ("tlh", "de-CH"):
        assert highlight_prompt(piece, instructions=None, density=5.0, source_language=tag) == prompt.replace(
            "Source text language: German.", f"Source text language: {tag}."
        )


def test_instructions_and_a_tone_of_no_characters_are_none() -> None:
    piece = piece_of(stated("highlighting"), PASSAGES)
    assert highlight_prompt(piece, instructions="", density=None, source_language=None) == stated("highlighting")
    assert comment_prompt(piece, instructions="", tone="", density=None, language="", source_language="") == commenting(piece)
    assert assessment_prompt(piece, instructions="", tone="", density=None, language="", source_language="") == assessing(piece)


def test_several_entity_types_are_asked_for_and_counted_together() -> None:
    prompt = stated("linking-person")
    assert prompt.count("mentions of: Person.") == 1
    assert mention_prompt(
        piece_of(prompt, MENTIONS), ["Person", "Place"], include_descriptive_references=False, source_language=None
    ) == prompt.replace("mentions of: Person.", "mentions of: Person, Place.")
    count = stated("linking-person-count")
    assert count.count("mention of: Person in") == 1
    assert count_prompt(piece_of(count, COUNT), ["Person", "Place"]) == count.replace(
        "mention of: Person in", "mention of: Person, Place in"
    )


def test_a_category_with_no_examples_has_no_key_questions() -> None:
    prompt = stated("tagging-claim")
    assert prompt.count("Key questions:\n- What is being asserted?\n") == 1
    bare = TagCategory(name=CLAIM.name, description=CLAIM.description, examples=[])
    assert tag_prompt(piece_of(prompt, PASSAGES), SCHEMA, bare, source_language=None) == prompt.replace(
        "Key questions:\n- What is being asserted?\n", "Key questions:\n\n"
    )
