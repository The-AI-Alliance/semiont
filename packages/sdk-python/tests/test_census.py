"""What is written by hand here, and what is generated, each held to its rule.

Generated modules are marked as such on their first line, and are the ones the
formatter is told to leave alone. Hand-written code states no type by force: it
has no `cast` and silences no checker. The one place a checker is silenced is
`tests/refusals`, where each silenced line is a program that must not
type-check, and a line that no longer needs silencing fails the checker.
"""

import re
import tomllib

from spec import PACKAGE

GENERATED = "# Generated from "
SOURCES = sorted(path for top in ("src", "tests", "conformance", "scripts") for path in (PACKAGE / top).rglob("*.py"))
REFUSALS = PACKAGE / "tests/refusals"

# What mypy refuses and pyright has no rule for.
MYPY_ALONE = ("explicit-any",)

FORCED = re.compile(r"\bcast\(|#\s*type:\s*ignore|#\s*pyright:\s*ignore|#\s*noqa\b")


def generated(source: str) -> bool:
    """Whether a module says, on its first line, that it is generated."""
    return source.startswith(GENERATED)


def test_the_walk_found_the_package() -> None:
    assert len(SOURCES) > 15


def test_the_generated_modules_are_the_ones_the_formatter_leaves_alone() -> None:
    marked = sorted(str(path.relative_to(PACKAGE)) for path in SOURCES if generated(path.read_text(encoding="utf-8")))
    with (PACKAGE / "pyproject.toml").open("rb") as file:
        excluded = tomllib.load(file)["tool"]["ruff"]["extend-exclude"]
    assert marked == sorted(excluded)


def test_no_hand_written_line_forces_a_type_or_silences_a_checker() -> None:
    forced = [
        f"{path.relative_to(PACKAGE)}:{number}: {line.strip()}"
        for path in SOURCES
        if not path.is_relative_to(REFUSALS) and path.name != "test_census.py" and not generated(path.read_text(encoding="utf-8"))
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if FORCED.search(line)
    ]
    assert forced == []


def test_every_refusal_is_silenced_for_both_checkers_on_the_line_it_is_made() -> None:
    programs = sorted(REFUSALS.glob("*.py"))
    assert len(programs) >= 6
    for program in programs:
        lines = program.read_text(encoding="utf-8").splitlines()
        refused = [line for line in lines if "# type: ignore[" in line or "# pyright: ignore[" in line]
        assert refused, f"{program.name} refuses nothing"
        for line in refused:
            assert "# type: ignore[" in line, f"{program.name}: mypy is not held on: {line.strip()}"
            if not any(f"# type: ignore[{rule}]" in line for rule in MYPY_ALONE):
                assert "# pyright: ignore[" in line, f"{program.name}: pyright is not held on: {line.strip()}"


def test_only_the_http_layer_imports_an_http_library() -> None:
    # The seam the layers keep: what a client is built from above its transport
    # never names what carries it, so another transport can stand in.
    http = PACKAGE / "src/semiont/http"
    names_it = re.compile(r"^\s*(import|from)\s+httpx\b", re.MULTILINE)
    importing = sorted(
        path for path in SOURCES if path.is_relative_to(PACKAGE / "src") and names_it.search(path.read_text(encoding="utf-8"))
    )
    assert importing, "nothing here imports httpx: this gate reads nothing"
    assert [str(path.relative_to(PACKAGE)) for path in importing if not path.is_relative_to(http)] == []


def test_only_the_telemetry_module_names_opentelemetry() -> None:
    # One module tells OpenTelemetry what the table lists. Nothing else here knows it is there.
    names_it = re.compile(r"^\s*(import|from)\s+opentelemetry\b", re.MULTILINE)
    importing = sorted(
        path for path in SOURCES if path.is_relative_to(PACKAGE / "src") and names_it.search(path.read_text(encoding="utf-8"))
    )
    assert [str(path.relative_to(PACKAGE)) for path in importing] == ["src/semiont/telemetry.py"]
