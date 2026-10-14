"""What is written by hand here, and what is generated, each held to its rule.

Generated modules are marked as such on their first line, and are the ones the
formatter is told to leave alone. Hand-written code states no type by force: it
has no `cast` and silences no checker. The one place a checker is silenced is
`tests/refusals`, where each silenced line is a program that must not
type-check, and a line that no longer needs silencing fails the checker.

Every state unit (a class of `src` that names `StateUnit` as its base) has a
test that runs the axioms against it, and nothing in `src` holds state outside
an instance (axiom X3): a module states constants marked `Final`, type
aliases, `__all__`, its imports and its definitions, and nothing else.
"""

import ast
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


def _base_names(node: ast.ClassDef) -> list[str]:
    """The names a class's bases are written with: `StateUnit`, and `AxiomSubject` of `AxiomSubject[Cache[str, int]]`."""
    return [ast.unparse(base.value if isinstance(base, ast.Subscript) else base) for base in node.bases]


def state_units(source: str) -> list[str]:
    """The classes `source` makes state units: each that names `StateUnit` as a base."""
    return [node.name for node in ast.walk(ast.parse(source)) if isinstance(node, ast.ClassDef) and "StateUnit" in _base_names(node)]


def units_held_to_the_axioms(source: str) -> list[str]:
    """The units whose axioms `source` runs: for each subject it hands to `assert_state_unit_axioms`, the unit that subject is of."""
    tree = ast.parse(source)
    handed = {
        ast.unparse(node.args[0].func)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and ast.unparse(node.func) == "assert_state_unit_axioms"
        and node.args
        and isinstance(node.args[0], ast.Call)
    }
    held: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name in handed:
            for base in node.bases:
                if isinstance(base, ast.Subscript) and ast.unparse(base.value) == "AxiomSubject":
                    unit = base.slice.value if isinstance(base.slice, ast.Subscript) else base.slice
                    held.append(ast.unparse(unit))
    return held


def test_the_census_reads_what_it_is_shown() -> None:
    source = (
        "class Cache[K, V](StateUnit):\n    pass\n"
        "class Probe(StateUnit, Given):\n    pass\n"
        "class Other(Thing):\n    pass\n"
        "# a StateUnit for nothing\n"
    )
    assert state_units(source) == ["Cache", "Probe"]
    tests = (
        "class Caches(AxiomSubject[Cache[str, int]]):\n    pass\n"
        "class Idle(AxiomSubject[Probe]):\n    pass\n"
        "def test_it() -> None:\n    assert_state_unit_axioms(Caches())\n"
    )
    assert units_held_to_the_axioms(tests) == ["Cache"]


def test_every_state_unit_has_a_test_that_runs_the_axioms_against_it() -> None:
    testing = PACKAGE / "src/semiont/testing"
    units = [
        (unit, path.relative_to(PACKAGE))
        for path in SOURCES
        if path.is_relative_to(PACKAGE / "src") and not path.is_relative_to(testing)
        for unit in state_units(path.read_text(encoding="utf-8"))
    ]
    assert any(unit == "Cache" for unit, _ in units), f"the census found no cache among the package's state units: {units}"
    # This file shows the census a subject of its own, which holds nothing.
    held = {
        unit
        for path in SOURCES
        if path.is_relative_to(PACKAGE / "tests") and path.name != "test_census.py"
        for unit in units_held_to_the_axioms(path.read_text(encoding="utf-8"))
    }
    unheld = [f"{unit} ({path})" for unit, path in units if unit not in held]
    assert unheld == [], f"state units with no test that runs assert_state_unit_axioms against them: {unheld}"


def statics(source: str) -> list[str]:
    """The statements of `source`, at its top and in a top-level `if`, that keep state.

    That is anything but a constant marked `Final`, a type alias, `__all__`, an import or a definition.
    """

    def kept(body: list[ast.stmt]) -> list[str]:
        found: list[str] = []
        for node in body:
            match node:
                case ast.Import() | ast.ImportFrom() | ast.FunctionDef() | ast.AsyncFunctionDef() | ast.ClassDef() | ast.TypeAlias():
                    continue
                case ast.Expr(value=ast.Constant()):
                    continue
                case ast.AnnAssign(annotation=annotation) if ast.unparse(annotation).startswith(("Final", "TypeAlias")):
                    continue
                case ast.Assign(targets=[ast.Name(id="__all__")]):
                    continue
                case ast.If(body=then, orelse=otherwise):
                    found.extend(kept(then) + kept(otherwise))
                case _:
                    found.append(ast.unparse(node).splitlines()[0])
        return found

    return kept(ast.parse(source).body)


def test_the_static_gate_reads_what_it_is_shown() -> None:
    source = (
        '"""A module."""\nimport sys\n__all__ = ["x"]\nLIMIT: Final = 3\ntype Name = str\n_seen: dict[str, int] = {}\n'
        "if sys.platform == 'win32':\n    import ctypes\n    _handles = []\ncount = 0\n"
    )
    assert statics(source) == ["_seen: dict[str, int] = {}", "_handles = []", "count = 0"]


def test_nothing_in_the_package_holds_state_outside_an_instance() -> None:
    found = [
        f"{path.relative_to(PACKAGE)}: {line}"
        for path in SOURCES
        if path.is_relative_to(PACKAGE / "src")
        for line in statics(path.read_text(encoding="utf-8"))
    ]
    assert found == [], f"state outside any instance (X3): {found}"


def raw_states(source: str) -> list[str]:
    """The members `source` hands a state out of without a view.

    Each is typed `Watched[…]` and returns an attribute whose name begins with an underscore.

    A state is held in a `Variable` and handed out as a read-only view of it
    (`semiont._reading.Reading`), or as another member's state; the `Variable`
    itself would let a reader write past what holds it.
    """
    return [
        node.name
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
        and node.returns is not None
        and ast.unparse(node.returns).startswith("Watched[")
        for returned in ast.walk(node)
        if isinstance(returned, ast.Return) and isinstance(returned.value, ast.Attribute) and returned.value.attr.startswith("_")
    ]


def test_the_view_gate_reads_what_it_is_shown() -> None:
    sample = (
        "class A:\n"
        "    @property\n    def raw(self) -> Watched[int]:\n        return self._raw\n"
        "    @property\n    def seen(self) -> Watched[int]:\n        return Reading(self._raw)\n"
        "    @property\n    def passed_on(self) -> Watched[int]:\n        return self._stream.state\n"
        "    def count(self) -> int:\n        return self._count\n"
    )
    assert raw_states(sample) == ["raw"]


def test_every_state_the_package_hands_out_is_read_only() -> None:
    found = [
        f"{path.relative_to(PACKAGE)}: {name}"
        for path in SOURCES
        if path.is_relative_to(PACKAGE / "src") and not generated(path.read_text(encoding="utf-8"))
        for name in raw_states(path.read_text(encoding="utf-8"))
    ]
    assert found == [], f"a state handed out as the Variable that holds it, which a reader could write: {found}"
