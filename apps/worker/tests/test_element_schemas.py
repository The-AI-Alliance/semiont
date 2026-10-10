"""What a detection asks to be answered in, held to the schemas the worker service's suite holds a detection to.

A provider that holds a reply to a schema writes an element's members in the
order the schema states its properties, so that order is part of what is
asked, and is compared here.
"""

import json
import re
from typing import Final

from pydantic import JsonValue
from semiont_inference.interface import ElementSchema
from spec import ROOT

from semiont_worker.detection.entity_extractor import ENTITY_ELEMENT_SCHEMA
from semiont_worker.detection.parsers import (
    ASSESSMENT_ELEMENT_SCHEMA,
    COMMENT_ELEMENT_SCHEMA,
    HIGHLIGHT_ELEMENT_SCHEMA,
    TAG_ELEMENT_SCHEMA,
)

SUITE: Final = ROOT / "tests/conformance/worker-service/support.ts"

# What the suite states a detection's answer is an array of, word for word.
SPAN: Final = """const span = (extra: Record<string, { type: 'string' }>, required: string[]) => ({
  type: 'array',
  items: {
    type: 'object',
    properties: { exact: { type: 'string' }, ...extra, prefix: { type: 'string' }, suffix: { type: 'string' } },
    required,
    additionalProperties: false,
  },
});
"""

ASKED: Final[dict[str, ElementSchema]] = {
    "highlighting": HIGHLIGHT_ELEMENT_SCHEMA,
    "commenting": COMMENT_ELEMENT_SCHEMA,
    "assessing": ASSESSMENT_ELEMENT_SCHEMA,
    "tagging": TAG_ELEMENT_SCHEMA,
    "linking": ENTITY_ELEMENT_SCHEMA,
}


def written(value: JsonValue | ElementSchema) -> str:
    """`value` as JSON, its members in the order they are in."""
    return json.dumps(value)


def elements_of_the_suite() -> dict[str, dict[str, JsonValue]]:
    """What `FORMATS` of the suite states one element of each kind of detection's answer is, read from its source."""
    suite = SUITE.read_text(encoding="utf-8")
    assert SPAN in suite, "the suite no longer states what a detection's answer is an array of as it did"
    stated = re.search(r"^export const FORMATS = \{\n(.*?)^\} as const;$", suite, re.DOTALL | re.MULTILINE)
    assert stated is not None, "the suite no longer states its formats as it did"
    elements: dict[str, dict[str, JsonValue]] = {}
    for line in stated.group(1).splitlines():
        entry = re.fullmatch(r"  (\w+): span\(\{(.*)\}, \[(.*)\]\),", line)
        assert entry is not None, f"a format of the suite is not written as the others were: {line}"
        kind, extra, required = entry.groups()
        added = re.findall(r"(\w+): \{ type: 'string' \}", extra)
        assert extra == (" " + ", ".join(f"{one}: {{ type: 'string' }}" for one in added) + " " if added else ""), line
        names = re.findall(r"'(\w+)'", required)
        assert required == ", ".join(f"'{one}'" for one in names), line
        properties: dict[str, JsonValue] = {one: {"type": "string"} for one in ("exact", *added, "prefix", "suffix")}
        asked: list[JsonValue] = [*names]
        elements[kind] = {"type": "object", "properties": properties, "required": asked, "additionalProperties": False}
    return elements


def test_every_kind_of_detection_asks_for_the_element_the_suite_holds_it_to() -> None:
    elements = elements_of_the_suite()
    assert sorted(elements) == sorted(ASKED)
    for kind, schema in ASKED.items():
        # As written: the members of the schema, and of its properties, in the suite's order.
        assert written(schema) == written(elements[kind]), kind
