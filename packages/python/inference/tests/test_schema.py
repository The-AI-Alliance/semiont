"""An element schema rewritten for a provider, and the provider's answer read back: every case of `schema-cases.json`.

The table is the statement of what the rewriting does. Each case is a schema
and a dialect, with either the schema a provider is then sent, an answer and
what is read from it, or the words the schema is refused in.
"""

import copy
import json
import re
from typing import get_args

import pytest
from pydantic import JsonValue
from spec import PACKAGE, WORKER_SERVICE_SUITE, JsonObject, objects, read, text, thing

from semiont_inference._schema import WRAPPER, Dialect, array_schema
from semiont_inference.interface import StructuredReadError

TABLE = read(PACKAGE / "tests/schema-cases.json")
CASES = objects(TABLE["cases"], "the cases")

# A dialect by its name in the table. Each is stated here, so that a name the table has is one the type has.
DIALECTS: dict[str, Dialect] = {
    "as-written": "as-written",
    "as-written-plain-enums": "as-written-plain-enums",
    "object-root-all-required": "object-root-all-required",
}

# The dialects that send a schema as it is written.
AS_WRITTEN = ("as-written", "as-written-plain-enums")

# The one case of the table that is taken as written and refused where a reply is held to plain enums alone.
ANY_SCALAR = "as written, a `const` and an `enum` of any scalar are sent as they are"

# What a case holds, by how it ends: its schema is refused, its answer is read, or its answer cannot be read.
REFUSED = {"name", "dialect", "schema", "refused"}
READ = {"name", "dialect", "schema", "sent", "stopReason", "items"}
UNREAD = {"name", "dialect", "schema", "sent", "stopReason", "failure"}

# What the worker service's suite states a detection's answer is an array of, word for word.
SPAN = """const span = (extra: Record<string, { type: 'string' }>, required: string[]) => ({
  type: 'array',
  items: {
    type: 'object',
    properties: { exact: { type: 'string' }, ...extra, prefix: { type: 'string' }, suffix: { type: 'string' } },
    required,
    additionalProperties: false,
  },
});
"""


def name(case: JsonObject) -> str:
    return text(case["name"], "a case's name")


def dialect(case: JsonObject) -> Dialect:
    return DIALECTS[text(case["dialect"], f"the dialect of {name(case)}")]


def written(value: JsonValue) -> str:
    """`value` as JSON, its members in the order they are in: the order of a schema's properties is part of what is sent."""
    return json.dumps(value)


def reply(case: JsonObject) -> str:
    """The text of the provider's reply in `case`."""
    if "answerText" in case:
        return text(case["answerText"], f"the reply of {name(case)}")
    return json.dumps(case["answer"])


def scrub(value: JsonValue) -> None:
    """Empty every object and list in `value`."""
    if isinstance(value, dict):
        for member in value.values():
            scrub(member)
        value.clear()
    if isinstance(value, list):
        for member in value:
            scrub(member)
        value.clear()


def formats_of_the_suite() -> dict[str, JsonObject]:
    """`FORMATS` of the worker service's suite, read from its source: what a detection of each kind asks to be answered in."""
    suite = (WORKER_SERVICE_SUITE / "support.ts").read_text(encoding="utf-8")
    assert SPAN in suite, "the suite no longer states what a detection's answer is an array of as it did"
    stated = re.search(r"^export const FORMATS = \{\n(.*?)^\} as const;$", suite, re.DOTALL | re.MULTILINE)
    assert stated is not None, "the suite no longer states its formats as it did"
    formats: dict[str, JsonObject] = {}
    for line in stated.group(1).splitlines():
        entry = re.fullmatch(r"  (\w+): span\(\{(.*)\}, \[(.*)\]\),", line)
        assert entry is not None, f"a format of the suite is not written as the others were: {line}"
        kind, extra, required = entry.groups()
        added = re.findall(r"(\w+): \{ type: 'string' \}", extra)
        assert extra == (" " + ", ".join(f"{one}: {{ type: 'string' }}" for one in added) + " " if added else ""), line
        names = re.findall(r"'(\w+)'", required)
        assert required == ", ".join(f"'{one}'" for one in names), line
        properties: JsonObject = {one: {"type": "string"} for one in ("exact", *added, "prefix", "suffix")}
        asked: list[JsonValue] = [*names]
        formats[kind] = {
            "type": "array",
            "items": {"type": "object", "properties": properties, "required": asked, "additionalProperties": False},
        }
    return formats


def test_the_table_is_made_of_cases_this_file_runs() -> None:
    assert TABLE["wrapper"] == WRAPPER
    names = [name(case) for case in CASES]
    assert len(set(names)) == len(names), "two cases have one name"
    for case in CASES:
        members = set(case) - {"format"}
        if "refused" in case:
            assert members == REFUSED, name(case)
            continue
        assert len(members & {"answer", "answerText"}) == 1, f"{name(case)} has no one answer"
        assert members - {"answer", "answerText"} in (READ, UNREAD), name(case)


def test_every_dialect_has_a_case_of_each_kind() -> None:
    # A dialect added to the type and not to the table fails here.
    assert set(DIALECTS) == set(get_args(Dialect.__value__))
    for stated in DIALECTS:
        of_it = [case for case in CASES if case["dialect"] == stated]
        for kind in ("items", "failure", "refused"):
            assert any(kind in case for case in of_it), f"no case of {stated} has `{kind}`"


@pytest.mark.parametrize("case", [case for case in CASES if "refused" not in case], ids=name)
def test_a_schema_is_rewritten_as_the_table_says_and_its_answer_is_read_back(case: JsonObject) -> None:
    schema = thing(case["schema"], "a schema")
    before = copy.deepcopy(schema)
    made = array_schema(schema, dialect(case))
    assert written(made.sent) == written(case["sent"])
    assert written(schema) == written(before), "the schema it was given was changed"

    stop_reason = text(case["stopReason"], "a stop reason")
    if "failure" not in case:
        assert made.read(reply(case), stop_reason) == case["items"]
        return
    with pytest.raises(StructuredReadError) as unread:
        made.read(reply(case), stop_reason)
    assert str(unread.value) == str(StructuredReadError(text(case["failure"], "a failure"), stop_reason))
    assert unread.value.stop_reason == stop_reason


@pytest.mark.parametrize("case", [case for case in CASES if "refused" in case], ids=name)
def test_a_schema_that_is_not_rewritten_is_refused_in_the_tables_words(case: JsonObject) -> None:
    refused = text(case["refused"], "a refusal")
    with pytest.raises(ValueError, match=re.escape(refused)) as refusal:
        array_schema(thing(case["schema"], "a schema"), dialect(case))
    assert str(refusal.value) == refused


def test_what_is_refused_as_written_is_refused_in_the_same_words_in_every_dialect() -> None:
    # Which schemas are taken does not depend on the provider, but for two things one dialect refuses and another
    # takes: an optional property that takes null of its own, and a `const` or an `enum` of more than text and
    # numbers. The table says each in a case of each dialect.
    refused_as_written = [case for case in CASES if "refused" in case and case["dialect"] == "as-written"]
    assert len(refused_as_written) > 20
    for case in refused_as_written:
        for stated in DIALECTS.values():
            with pytest.raises(ValueError, match=re.escape(text(case["refused"], "a refusal"))):
                array_schema(thing(case["schema"], "a schema"), stated)


def test_a_provider_of_plain_enums_is_sent_what_is_sent_as_written_or_nothing() -> None:
    # The dialect rewrites nothing. Whatever it does not refuse it sends as the schema is written, and what it
    # refuses of all the table takes as written is the one case the table states for it.
    taken_as_written = [case for case in CASES if "refused" not in case and case["dialect"] == "as-written"]
    assert len(taken_as_written) > 10
    refused: list[str] = []
    for case in taken_as_written:
        try:
            made = array_schema(thing(case["schema"], "a schema"), "as-written-plain-enums")
        except ValueError:
            refused.append(name(case))
            continue
        assert written(made.sent) == written(case["sent"]), name(case)
    assert refused == [ANY_SCALAR]


def test_the_five_formats_of_the_table_are_the_ones_the_worker_services_suite_holds_a_detection_to() -> None:
    formats = formats_of_the_suite()
    assert sorted(formats) == ["assessing", "commenting", "highlighting", "linking", "tagging"]
    assert {text(case["format"], "a format") for case in CASES if "format" in case} == set(formats)
    for kind, asked in formats.items():
        for stated in DIALECTS:
            (case,) = [case for case in CASES if case.get("format") == kind and case["dialect"] == stated]
            assert written(case["schema"]) == written(asked["items"]), name(case)
        for stated in AS_WRITTEN:
            (as_written,) = [case for case in CASES if case.get("format") == kind and case["dialect"] == stated]
            assert written(as_written["sent"]) == written(asked), name(as_written)


def test_what_is_sent_shares_nothing_with_the_schema_it_was_made_from() -> None:
    schema: JsonObject = {
        "type": "object",
        "properties": {"exact": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string", "enum": ["a", "b"]}}},
        "required": ["exact"],
        "additionalProperties": False,
    }
    before = written(schema)
    for stated in DIALECTS.values():
        scrub(array_schema(schema, stated).sent)
        assert written(schema) == before, stated
