"""What this package is made of, each part held to its rule.

Its public names are the ones its design lists, and no others. Hand-written
code states no type by force: it has no `cast`, names no `Any`, and silences
no checker, but in `tests/refusals`, where each silenced line is a program
that must not type-check. A provider's library is named by its driver alone,
is an extra and not a requirement, and is imported only when that driver is.
And what this package's manifest says a second time, after the SDK's, says
the same.
"""

import importlib
import re
import tomllib
from pathlib import Path

from spec import PACKAGE, SDK, JsonObject

from semiont_inference.anthropic import AnthropicInferenceClient
from semiont_inference.interface import InferenceClient, InferenceLimits
from semiont_inference.mock import MockInferenceClient
from semiont_inference.ollama import OllamaInferenceClient

SRC = PACKAGE / "src/semiont_inference"
SOURCES = sorted(path for top in ("src", "tests") for path in (PACKAGE / top).rglob("*.py"))
REFUSALS = PACKAGE / "tests/refusals"

# The public names, by the module that has each.
SURFACE = {
    "interface": [
        "ElementSchema",
        "InferenceClient",
        "InferenceLimits",
        "InferenceResponse",
        "ProviderStatusError",
        "ProviderWithheldError",
        "StructuredReadError",
        "StructuredResponse",
        "TokenUsage",
    ],
    "anthropic": ["AnthropicInferenceClient"],
    "ollama": ["OllamaInferenceClient"],
    "mock": ["MockInferenceClient"],
    "factory": ["create_inference_client"],
    "limits_report": ["report_limits"],
}

# What mypy refuses and pyright has no rule for.
MYPY_ALONE = ("explicit-any",)

FORCED = re.compile(r"\bcast\(|#\s*type:\s*ignore|#\s*pyright:\s*ignore|#\s*noqa\b|\btyping\.Any\b|^\s*from typing import [^\n]*\bAny\b")


def manifest(package: Path) -> dict[str, JsonObject]:
    with (package / "pyproject.toml").open("rb") as file:
        return tomllib.load(file)


def importing(library: str) -> list[str]:
    """The modules of this package that import `library`, by their paths in it."""
    names_it = re.compile(rf"^\s*(import|from)\s+{library}\b", re.MULTILINE)
    return sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if names_it.search(path.read_text(encoding="utf-8")))


def public(thing: object) -> set[str]:
    return {name for name in dir(thing) if not name.startswith("_")}


def test_the_walk_found_the_package() -> None:
    assert len(SOURCES) > 15


def test_the_public_modules_and_their_names_are_the_ones_the_design_lists() -> None:
    modules = sorted(path.stem for path in SRC.glob("*.py") if not path.stem.startswith("_"))
    assert modules == sorted(SURFACE)
    for module, names in SURFACE.items():
        assert sorted(importlib.import_module(f"semiont_inference.{module}").__all__) == sorted(names), f"semiont_inference.{module}"


def test_a_public_name_is_imported_from_its_module_and_not_from_the_packages_root() -> None:
    # One path to each name, as the SDK has it. It is also why importing the package imports no provider's library.
    root_source = (SRC / "__init__.py").read_text(encoding="utf-8")
    assert not re.search(r"^\s*(import|from)\s", root_source, re.MULTILINE), "the package's root imports something"
    root = importlib.import_module("semiont_inference")
    assert not hasattr(root, "__all__")
    for module, names in SURFACE.items():
        for name in names:
            assert not hasattr(root, name), f"{name} can be imported from the package's root as well as from semiont_inference.{module}"
    assert (SRC / "py.typed").read_bytes() == b""


def test_a_driver_has_the_members_of_a_client_and_no_others() -> None:
    members = public(InferenceClient)
    limits = InferenceLimits(context_tokens=1, max_output_tokens=1, output_tokens_per_hour=None, accepts_temperature=None)
    assert public(AnthropicInferenceClient(api_key="k", model="m", base_url="http://127.0.0.1:1")) == members
    assert public(OllamaInferenceClient(model="m", base_url="http://127.0.0.1:1")) == members
    # The mock has, beside them, what a test reads and resets.
    assert public(MockInferenceClient(["[]"], stop_reasons=["end_turn"], limits=limits)) == members | {"calls", "reset", "set_responses"}


def test_no_hand_written_line_forces_a_type_or_silences_a_checker() -> None:
    forced = [
        f"{path.relative_to(PACKAGE)}:{number}: {line.strip()}"
        for path in SOURCES
        if not path.is_relative_to(REFUSALS) and path.name != "test_census.py"
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if FORCED.search(line)
    ]
    assert forced == []


def test_every_refusal_is_silenced_for_both_checkers_on_the_line_it_is_made() -> None:
    programs = sorted(path for path in REFUSALS.glob("*.py") if path.stem != "__init__")
    assert programs, "tests/refusals holds no program"
    for program in programs:
        lines = program.read_text(encoding="utf-8").splitlines()
        refused = [line for line in lines if "# type: ignore[" in line or "# pyright: ignore[" in line]
        assert refused, f"{program.name} refuses nothing"
        for line in refused:
            assert "# type: ignore[" in line, f"{program.name}: mypy is not held on: {line.strip()}"
            if not any(f"# type: ignore[{rule}]" in line for rule in MYPY_ALONE):
                assert "# pyright: ignore[" in line, f"{program.name}: pyright is not held on: {line.strip()}"


def test_a_providers_library_is_named_by_its_driver_alone() -> None:
    # What stands between a caller and a provider's library is the interface: nothing else here knows which library a driver uses.
    assert importing("anthropic") == ["anthropic.py"]
    assert importing("httpx") == ["ollama.py"]
    assert importing("httpx2") == []


def test_one_module_names_opentelemetry_and_one_names_the_logger() -> None:
    assert importing("opentelemetry") == ["_telemetry.py"]
    naming = sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if "getLogger(" in path.read_text(encoding="utf-8"))
    assert naming == ["_log.py"]
    assert (SRC / "_log.py").read_text(encoding="utf-8").count('getLogger("semiont_inference")') == 1


def test_the_checkers_and_their_strictness_are_the_sdks() -> None:
    # This package's manifest states them a second time. A pin or a setting moved in one and not the other fails here.
    ours, theirs = manifest(PACKAGE), manifest(SDK)

    def tools(of: dict[str, JsonObject]) -> dict[str, str]:
        dev = of["dependency-groups"]["dev"]
        assert isinstance(dev, list)
        return {re.split(r"[=<>!~ ]", requirement, maxsplit=1)[0]: requirement for requirement in dev if isinstance(requirement, str)}

    shared = set(tools(ours)) & set(tools(theirs))
    assert shared >= {"mypy", "pyright", "pytest", "ruff"}
    assert {name: tools(ours)[name] for name in shared} == {name: tools(theirs)[name] for name in shared}

    def settings(of: dict[str, JsonObject], tool: str, *, but: tuple[str, ...]) -> JsonObject:
        stated = of["tool"][tool]
        assert isinstance(stated, dict)
        return {key: value for key, value in stated.items() if key not in but}

    # What each reads is its own package's; everything else is the same.
    assert settings(ours, "mypy", but=("files",)) == settings(theirs, "mypy", but=("files",))
    assert settings(ours, "pyright", but=("include",)) == settings(theirs, "pyright", but=("include",))
    assert settings(ours, "pydantic-mypy", but=()) == settings(theirs, "pydantic-mypy", but=())
    assert settings(ours, "pytest", but=()) == settings(theirs, "pytest", but=())
    # The SDK's formatter is told which of its modules are generated. This package has none.
    assert settings(ours, "ruff", but=()) == settings(theirs, "ruff", but=("extend-exclude",))
    # Which Pythons the two run on is lint:python-version's to hold: it is the one gate that reads that line.
    assert ours["build-system"] == theirs["build-system"]


def name_of(requirement: object) -> str:
    """The distribution a requirement names, without its extras and its versions."""
    assert isinstance(requirement, str)
    return re.split(r"[\[=<>!~ ]", requirement, maxsplit=1)[0]


def test_a_dependency_the_sdk_bounds_is_named_here_without_a_bound_of_its_own() -> None:
    ours, theirs = manifest(PACKAGE)["project"]["dependencies"], manifest(SDK)["project"]["dependencies"]
    assert isinstance(ours, list)
    assert isinstance(theirs, list)
    bounded_by_the_sdk = {name_of(requirement) for requirement in theirs}
    assert bounded_by_the_sdk >= {"httpx", "opentelemetry-api", "pydantic"}
    for requirement in ours:
        if name_of(requirement) in bounded_by_the_sdk:
            assert requirement == name_of(requirement), f"{requirement}: the SDK states the versions of {name_of(requirement)}"


def test_what_every_install_has_is_what_the_package_imports_without_a_providers_library() -> None:
    project = manifest(PACKAGE)["project"]
    required, extras = project["dependencies"], project["optional-dependencies"]
    assert isinstance(required, list)
    assert isinstance(extras, dict)
    # Every module imported from outside the standard library is declared, and nothing declared goes unused.
    assert {name_of(requirement) for requirement in required} == {"httpx", "opentelemetry-api", "pydantic", "semiont"}
    for library in ("httpx", "opentelemetry", "pydantic", "semiont"):
        assert importing(library), f"{library} is required and nothing imports it"

    # A provider's own library is an extra named for the provider, imported by that provider's driver and by nothing else.
    assert {
        extra: [name_of(requirement) for requirement in requirements]
        for extra, requirements in extras.items()
        if isinstance(requirements, list)
    } == {"anthropic": ["anthropic"]}
    assert set(extras) == {"anthropic"}
    for extra in extras:
        assert importing(extra) == [f"{extra}.py"]
        assert extra not in {name_of(requirement) for requirement in required}

    # The checkers and the tests read every driver: the environment they run in has every extra.
    dev = manifest(PACKAGE)["dependency-groups"]["dev"]
    assert isinstance(dev, list)
    assert f"semiont-inference[{','.join(sorted(extras))}]" in dev
