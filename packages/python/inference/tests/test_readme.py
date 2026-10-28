"""The README's programs: each Python block it shows is a file of `tests/readme`, word for word, and each is run here.

Both type checkers check those files with the rest of the package. What asks
a model asks the Ollama this package's tests play, on this machine.
"""

import re
import tomllib

from aio import run
from provider import Ollama, generated
from readme import a_first_call
from spec import PACKAGE

from semiont_inference.interface import InferenceClient

README = (PACKAGE / "README.md").read_text(encoding="utf-8")
PROGRAMS = {
    path.stem: path.read_text(encoding="utf-8") for path in sorted((PACKAGE / "tests/readme").glob("*.py")) if path.stem != "__init__"
}


def python_blocks(markdown: str) -> list[str]:
    """The fenced Python blocks of a Markdown document, in order."""
    return re.findall(r"^```python\n(.*?)^```$", markdown, re.DOTALL | re.MULTILINE)


def test_every_python_block_of_the_readme_is_a_program_here_word_for_word_and_every_program_is_shown() -> None:
    shown = python_blocks(README)
    assert PROGRAMS, "tests/readme holds no program"
    for block in shown:
        assert block in PROGRAMS.values(), f"a Python block of the README is not a program that is checked and run:\n{block}"
    for name, program in PROGRAMS.items():
        assert shown.count(program) == 1, f"tests/readme/{name}.py is not shown in the README, once, as it is"


def test_every_program_is_run_by_a_test_named_for_it() -> None:
    tests = [name for name in globals() if name.startswith("test_")]
    for name in PROGRAMS:
        assert any(test.startswith(f"test_{name}_") for test in tests), f"nothing here runs tests/readme/{name}.py"


def test_a_first_call_asks_the_model_at_the_address_it_is_given_and_returns_its_text() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated("The Loire."))
            assert await a_first_call.ask(ollama.origin) == "The Loire."
            assert ollama.shows == [{"model": "gemma2:27b"}]
            (generation,) = ollama.generations
            assert (generation["model"], generation["prompt"]) == ("gemma2:27b", "Name one river of France.")
            assert generation["options"] == {"num_predict": 200, "num_ctx": 273, "temperature": 0.0}

    run(scenario())


def test_the_readme_names_the_extra_of_every_provider_that_has_one() -> None:
    with (PACKAGE / "pyproject.toml").open("rb") as file:
        extras = tomllib.load(file)["project"]["optional-dependencies"]
    assert extras, "the package has no extra: this gate reads nothing"
    for extra in extras:
        assert f"`semiont-inference[{extra}]`" in README, f"the README does not say how the {extra} driver's library is installed"


def test_the_readme_names_every_member_of_a_client() -> None:
    members = {name for name in vars(InferenceClient) if not name.startswith("_")}
    assert len(members) >= 7
    for member in members:
        assert f"`{member}" in README, f"the README does not name {member}"
