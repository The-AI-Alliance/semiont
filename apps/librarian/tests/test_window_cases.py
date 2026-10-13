"""The text around a selection, held to `specs/src/librarian/window-cases.json`.

It is the table every Librarian runs, so that a window is cut at the same
code points whoever cuts it. A case has one of two parts. An `around` case is
the cut a summary makes, at an annotation's position: it is run through
`annotation_context`, and through `text_around` beside it where the target
states a position selector alone. A `gathered` case is the cut a gather
makes: it is run through `selection_of`, which is the gather's rule of which
selector is read and of what window is taken. No store is read here, and no
gather is made.

A member of the table or of a case that nothing here reads fails.

After the table's cases comes what no case of it rests on.
"""

import pytest
from pydantic import JsonValue
from semiont.types import Annotation
from spec import ROOT, JsonObject, objects, only, read, text, thing, whole, why

from semiont_librarian.window import (
    LARGEST_WINDOW,
    LEAST_WINDOW,
    Unplaced,
    Window,
    WindowRefused,
    annotation_context,
    selection_of,
    text_around,
)

TABLE = read(ROOT / "specs/src/librarian/window-cases.json")
CASES = objects(TABLE["cases"], "cases")
AROUND = [thing(case["around"], "around") | {"why": case["why"]} for case in CASES if "around" in case]
GATHERED = [thing(case["gathered"], "gathered") | {"why": case["why"]} for case in CASES if "gathered" in case]

SOURCE = "res-1"
QUICK = "The quick brown fox jumps"

# Every member each thing the table states may have. A member that is none of these is one nothing here would read.
TABLE_MEMBERS = ("$comment", "cases")
CASE_MEMBERS = ("why", "around", "gathered")
PART_MEMBERS = ("why", "text", "selector", "window", "context", "refused")
WINDOW_MEMBERS = ("before", "after")
CONTEXT_MEMBERS = ("before", "selected", "after")


def annotation_with(selector: JsonValue) -> Annotation:
    """The annotation a case is about: one on the text, whose target states the case's selector, or none where the case states none."""
    target: JsonObject = {"source": SOURCE} if selector is None else {"source": SOURCE, "selector": selector}
    return Annotation.model_validate(
        {
            "@context": "http://www.w3.org/ns/anno.jsonld",
            "id": "ann-1",
            "type": "Annotation",
            "motivation": "highlighting",
            "created": "2026-01-01T00:00:00.000Z",
            "target": target,
        }
    )


def stated_context(stated: JsonValue, what: str) -> Window:
    """The cut a case states."""
    context = thing(stated, what)
    only(context, CONTEXT_MEMBERS, what)
    return Window(
        before=text(context["before"], "before"), selected=text(context["selected"], "selected"), after=text(context["after"], "after")
    )


def refused(case: JsonObject) -> bool:
    """Whether a case states that the cut is refused. One that does states no context."""
    if "refused" not in case:
        return False
    assert case["refused"] is True, why(case)
    assert "context" not in case, why(case)
    return True


# ── The table's cases ─────────────────────────────────────────────────


def test_the_table_has_a_case_of_each_of_its_two_parts_and_no_case_of_none() -> None:
    only(TABLE, TABLE_MEMBERS, "the table")
    assert AROUND, "the table has no `around` case"
    assert GATHERED, "the table has no `gathered` case"
    for case in CASES:
        only(case, CASE_MEMBERS, why(case))
        assert ("around" in case) != ("gathered" in case), why(case)
    for part in (*AROUND, *GATHERED):
        only(part, PART_MEMBERS, why(part))


def test_each_case_is_told_from_the_others_by_its_why() -> None:
    told = [why(case) for case in CASES]
    assert len(set(told)) == len(told)


@pytest.mark.parametrize("case", AROUND, ids=[why(case) for case in AROUND])
def test_the_text_a_summary_cuts_around_an_annotation_is_the_table_s(case: JsonObject) -> None:
    annotation = annotation_with(case.get("selector"))
    content = text(case["text"], "text")
    window = thing(case["window"], "window")
    only(window, WINDOW_MEMBERS, "window")
    before, after = whole(window["before"], "before"), whole(window["after"], "after")

    if refused(case):
        with pytest.raises(Unplaced, match=r"^No selector of the annotation's target places it in the text$"):
            annotation_context(annotation, content, before, after)
        return

    cut = stated_context(case["context"], "context")
    assert annotation_context(annotation, content, before, after) == cut

    selector = case.get("selector")
    if isinstance(selector, dict) and selector["type"] == "TextPositionSelector":
        assert text_around(content, whole(selector["start"], "start"), whole(selector["end"], "end"), before, after) == cut


@pytest.mark.parametrize("case", GATHERED, ids=[why(case) for case in GATHERED])
def test_the_text_a_gather_cuts_around_an_annotation_is_the_table_s(case: JsonObject) -> None:
    annotation = annotation_with(case.get("selector"))
    content = text(case["text"], "text")
    window = whole(case["window"], "window")

    if refused(case):
        with pytest.raises(WindowRefused, match=r"contextWindow must be between 100 and 5000"):
            selection_of(annotation, content, window)
        return

    # A case that is not refused states its context, which is null where the gathered context states no selection.
    assert "context" in case, why(case)
    stated = case["context"]
    cut = None if stated is None else stated_context(stated, "context")
    assert selection_of(annotation, content, window) == cut


# ── What no case of the table rests on ────────────────────────────────


def test_a_window_is_refused_before_anything_is_read_of_the_annotation() -> None:
    # A target that selects nothing is no selection, and a window out of bounds is refused all the same.
    whole_resource = annotation_with(None)
    assert selection_of(whole_resource, QUICK, LEAST_WINDOW) is None
    with pytest.raises(WindowRefused):
        selection_of(whole_resource, QUICK, LEAST_WINDOW - 1)
    with pytest.raises(WindowRefused):
        selection_of(whole_resource, QUICK, LARGEST_WINDOW + 1)


def test_a_target_that_is_a_resource_s_id_states_no_selector() -> None:
    bare = Annotation.model_validate(
        {
            "@context": "http://www.w3.org/ns/anno.jsonld",
            "id": "ann-1",
            "type": "Annotation",
            "motivation": "highlighting",
            "created": "2026-01-01T00:00:00.000Z",
            "target": SOURCE,
        }
    )
    assert selection_of(bare, QUICK, LEAST_WINDOW) is None
    with pytest.raises(Unplaced):
        annotation_context(bare, QUICK, 5, 5)


def test_an_offset_past_the_end_of_a_text_is_its_end() -> None:
    assert text_around(QUICK, 20, 99, 4, 5) == Window(before="fox ", selected="jumps", after="")
    assert text_around(QUICK, 99, 120, 5, 5) == Window(before="jumps", selected="", after="")


def test_a_window_counts_code_points_on_each_side_of_a_position() -> None:
    # Two hundred books, then a word, then two hundred more: each book is one code point and two UTF-16 code units.
    books = "\U0001f4da" * 200
    cut = text_around(f"{books}Ada{books}", 200, 203, 150, 120)
    assert cut == Window(before="\U0001f4da" * 150, selected="Ada", after="\U0001f4da" * 120)
