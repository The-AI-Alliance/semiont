"""The words of a generation, held to the TypeScript worker's source for as long as there is one.

The Python worker asks its model as the TypeScript worker does, word for
word, until that worker is deleted. The worker service's suite states four
whole prompts, and `test_generation_prompts.py` holds those. Of every other
word nothing in the repository states it but
`packages/jobs/src/workers/generation/resource-generation.ts`. So this reads
that file. Every piece of text the Python module's code holds is found in
it as it is written, line ends and all; and the numbers the two workers keep
are the same numbers.

It holds one direction: a word the TypeScript source gains is not missed
here. When the TypeScript worker goes, this file goes with it, and the
Python module's words are then its own.
"""

import ast
import re
from collections.abc import Iterator
from typing import Final

from spec import PROJECT, ROOT

from semiont_worker.generation.resource_generation import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_TEMPERATURE,
    RESOURCE_CONTENT_CAP,
    SEMANTIC_MATCH_CODE_POINTS,
    SEMANTIC_MATCH_LIMIT,
)
from semiont_worker.generation.typst import MAX_COMPILE_REPAIRS, PINNED_CREATION_TIMESTAMP

TYPESCRIPT: Final = ROOT / "packages/jobs/src/workers/generation"
BUILDER: Final = (TYPESCRIPT / "resource-generation.ts").read_text(encoding="utf-8")
COMPILER: Final = (TYPESCRIPT / "typst-compiler.ts").read_text(encoding="utf-8")

# TypeScript writes a line end inside a quoted string as `\n`, and inside a template as the line end itself.
WRITTEN: Final = BUILDER.replace("\\n", "\n")

MODULE: Final = PROJECT / "src/semiont_worker/generation/resource_generation.py"

OWN: Final = {
    # A length that is no whole number is refused here in words of this module's own. TypeScript asks for it,
    # and its provider refuses it.
    "tokens_asked",
    # The place a score is rounded to is written out here. TypeScript names a count of places.
    "_two_places",
}
"""The functions of the Python module whose text is not TypeScript's, each with why."""


def said_under(node: ast.AST) -> Iterator[str]:
    """Every piece of text the code under `node` holds, but what documents the code and what is the Python module's own."""
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.Expr) and isinstance(child.value, ast.Constant) and isinstance(child.value.value, str):
            continue
        if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef) and child.name in OWN:
            continue
        if isinstance(child, ast.Constant) and isinstance(child.value, str):
            yield child.value
        yield from said_under(child)


TREE: Final = ast.parse(MODULE.read_text(encoding="utf-8"))
SAID: Final = list(said_under(TREE))


def number(name: str, source: str) -> int:
    """The whole number TypeScript's `source` keeps as the constant `name`."""
    kept = re.findall(rf"\bconst {name} = (\d+);", source)
    assert len(kept) == 1, f"TypeScript states {name} {len(kept)} times"
    return int(kept[0])


def test_the_walk_found_the_module_s_text() -> None:
    # The text of a prompt is in pieces, around what a job puts into it.
    assert "\n\nRequirements:\n- Aim for approximately " in SAID
    assert len(SAID) > 100
    # And every function named as the module's own is one it has.
    functions = {node.name for node in ast.walk(TREE) if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)}
    assert functions >= OWN


def test_every_piece_of_text_the_python_module_holds_is_in_the_typescript_source_as_written() -> None:
    assert [text for text in SAID if text not in WRITTEN] == []


def test_the_numbers_of_a_prompt_are_typescript_s() -> None:
    assert number("RESOURCE_CONTENT_CAP", BUILDER) == RESOURCE_CONTENT_CAP
    assert number("SEMANTIC_MATCH_LIMIT", BUILDER) == SEMANTIC_MATCH_LIMIT
    assert number("SEMANTIC_MATCH_CODE_POINTS", BUILDER) == SEMANTIC_MATCH_CODE_POINTS
    assert number("DEFAULT_MAX_TOKENS", BUILDER) == DEFAULT_MAX_TOKENS
    # The temperature is written where TypeScript falls back to it, and nowhere else.
    assert re.findall(r"temperature \?\? ([0-9.]+);", BUILDER) == [str(DEFAULT_TEMPERATURE)]


def test_the_numbers_of_a_compile_are_typescript_s() -> None:
    assert number("PINNED_CREATION_TIMESTAMP", COMPILER) == PINNED_CREATION_TIMESTAMP
    assert number("MAX_COMPILE_REPAIRS", COMPILER) == MAX_COMPILE_REPAIRS
