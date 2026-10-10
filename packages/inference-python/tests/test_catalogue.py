"""A model catalogue file, and what reads one: `semiont_inference.catalogue`.

The package carries no catalogue. It reads a file it is pointed to, which an
image's build makes with `scripts/inference/generate-model-catalogue.mjs`
from the npm package the repository pins. `tests/catalogue` holds one such
file, made by that script: real data at the pin. CI's drift job holds it to
the script and the pin. What is held here is what that check cannot say: that
the file is the shape the reader takes, that the reader answers what a file
has and nothing it does not, and that neither a wheel nor a source
distribution of the package holds any of the catalogue.
"""

import dataclasses
import json
import re
import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest
from pydantic import JsonValue
from refusals.a_provider_the_catalogue_lacks import facts_under_an_unknown_provider
from spec import PACKAGE, ROOT, JsonObject, read, text, thing

from semiont_inference.catalogue import (
    BudgetTokensOption,
    CatalogueFacts,
    CatalogueProvider,
    EffortOption,
    ReasoningOption,
    ToggleOption,
    catalogue_facts,
    read_catalogue,
)

FIXTURE = PACKAGE / "tests/catalogue"
FILE = FIXTURE / "model-catalogue.json"
NOTICE = FIXTURE / "model-catalogue.LICENSE"
WRITTEN = read(FILE)
CATALOGUE = read_catalogue(FILE)
NPM_PACKAGE = "@opencode-ai/models"

# The catalogue's name for each provider, by this package's name for it.
NAMES: dict[CatalogueProvider, str] = {"google": "google", "openai": "openai", "together": "togetherai"}

# An entry as the generator writes one, with every fact stated.
ENTRY: JsonObject = {
    "limit": {"context": 400000, "input": 272000, "output": 128000},
    "reasoning": True,
    "reasoning_options": [
        {"type": "effort", "values": ["minimal", "low", "medium", "high"]},
        {"type": "toggle"},
        {"type": "budget_tokens", "min": 0, "max": 24576},
    ],
    "status": "deprecated",
    "structured_output": True,
    "temperature": False,
}

# The same model with nothing stated but what the catalogue states of every model.
UNSTATED: JsonObject = {
    "limit": {"context": 128000, "input": None, "output": 16384},
    "reasoning": False,
    "reasoning_options": None,
    "status": None,
    "structured_output": None,
    "temperature": None,
}


def document(entry: JsonObject, *, providers: tuple[str, ...] = ("google", "openai", "togetherai")) -> bytes:
    """A catalogue file whose one model, `m` of `openai`, is `entry`."""
    held: JsonObject = {provider: {"models": {"m": entry} if provider == "openai" else {}} for provider in providers}
    whole: JsonObject = {
        "package": NPM_PACKAGE,
        "version": "0.0.1",
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "license": "MIT",
        "providers": held,
    }
    return json.dumps(whole).encode()


def kept(directory: Path, data: bytes) -> Path:
    """The path of a file of `directory` that holds `data`."""
    path = directory / "model-catalogue.json"
    path.write_bytes(data)
    return path


def model_of(directory: Path, entry: JsonObject) -> CatalogueFacts:
    """What is read of `entry`, as the one model of a catalogue file."""
    facts = catalogue_facts(read_catalogue(kept(directory, document(entry))), "openai", "m")
    assert facts is not None
    return facts


def models(provider: str) -> dict[str, JsonObject]:
    """The entries the fixture has under `provider`, the catalogue's name for it."""
    held = thing(thing(thing(WRITTEN["providers"], "providers")[provider], provider)["models"], f"the models of {provider}")
    return {model: thing(entry, f"{provider}/{model}") for model, entry in held.items()}


def above_zero(value: JsonValue) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def option_as_written(option: ReasoningOption) -> JsonObject:
    match option:
        case EffortOption():
            values: list[JsonValue] = [*option.values]
            return {"type": "effort", "values": values}
        case ToggleOption():
            return {"type": "toggle"}
        case BudgetTokensOption():
            return {"type": "budget_tokens", "min": option.min, "max": option.max}


def as_written(facts: CatalogueFacts) -> JsonObject:
    """`facts` as the entry it was read from, each member put back by name."""
    options: list[JsonValue] | None = None if facts.reasoning_options is None else [option_as_written(o) for o in facts.reasoning_options]
    return {
        "limit": {"context": facts.limit.context, "input": facts.limit.input, "output": facts.limit.output},
        "reasoning": facts.reasoning,
        "reasoning_options": options,
        "status": facts.status,
        "structured_output": facts.structured_output,
        "temperature": facts.temperature,
    }


def test_the_fixture_says_which_package_it_was_made_from_at_the_version_the_repository_pins() -> None:
    pinned = thing(read(ROOT / "package.json")["devDependencies"], "the repository's devDependencies")[NPM_PACKAGE]
    assert isinstance(pinned, str)
    assert re.fullmatch(r"\d+\.\d+\.\d+", pinned), f"{NPM_PACKAGE} is pinned as {pinned}, which is not one version"
    assert list(WRITTEN) == ["package", "version", "generatedAt", "license", "providers"]
    assert (WRITTEN["package"], WRITTEN["version"], WRITTEN["license"]) == (NPM_PACKAGE, pinned, "MIT")
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", text(WRITTEN["generatedAt"], "generatedAt"))
    # And the reader says the same of it.
    assert (CATALOGUE.package, CATALOGUE.version, CATALOGUE.license) == (NPM_PACKAGE, pinned, "MIT")
    assert CATALOGUE.generated_at == WRITTEN["generatedAt"]


def test_the_fixture_is_where_the_repositorys_scripts_write_and_check_it() -> None:
    # CI's drift job runs the second of these: it is this directory that is held to the generator and the pin.
    scripts = thing(read(ROOT / "package.json")["scripts"], "the repository's scripts")
    generator, directory = "node scripts/inference/generate-model-catalogue.mjs", FIXTURE.relative_to(ROOT).as_posix()
    assert scripts["generate:model-catalogue"] == f"{generator} --out {directory}"
    assert scripts["generate:model-catalogue:check"] == f"{generator} --check {directory}"
    assert sorted(path.name for path in FIXTURE.iterdir()) == ["model-catalogue.LICENSE", "model-catalogue.json"]


def test_the_fixture_holds_the_providers_whose_apis_do_not_state_a_models_facts_and_no_other() -> None:
    providers = thing(WRITTEN["providers"], "providers")
    assert list(providers) == ["google", "openai", "togetherai"]
    assert sorted(NAMES.values()) == list(providers)
    for provider in providers:
        assert list(thing(providers[provider], provider)) == ["models"]
        assert models(provider), f"the fixture holds no model of {provider}"


def test_every_entry_states_each_fact_or_null_and_a_window_and_an_output_ceiling_above_zero() -> None:
    for provider in NAMES.values():
        for model, entry in models(provider).items():
            where = f"{provider}/{model}"
            assert list(entry) == ["limit", "reasoning", "reasoning_options", "status", "structured_output", "temperature"], where
            limit = thing(entry["limit"], where)
            assert list(limit) == ["context", "input", "output"], where
            assert above_zero(limit["context"]), where
            assert above_zero(limit["output"]), where
            assert limit["input"] is None or above_zero(limit["input"]), where


def test_the_fixture_is_in_order_with_a_model_to_a_line() -> None:
    # A bump's diff is then one line for each model whose facts moved, with the model's name on it.
    written = FILE.read_text(encoding="utf-8")
    assert written.endswith("\n}\n")
    held = 0
    for provider in NAMES.values():
        assert list(models(provider)) == sorted(models(provider)), provider
        held += len(models(provider))
    assert len(re.findall(r'^ {8}"[^"]+": \{.*\},?$', written, re.MULTILINE)) == held
    assert written.count('"limit"') == held


def test_the_reader_answers_each_entry_as_the_file_has_it() -> None:
    answered = 0
    for ours, theirs in NAMES.items():
        for model, entry in models(theirs).items():
            facts = catalogue_facts(CATALOGUE, ours, model)
            assert facts is not None, f"{theirs}/{model}"
            assert as_written(facts) == entry, f"{theirs}/{model}"
            answered += 1
    assert answered > 50


def test_a_model_a_catalogue_does_not_have_is_none_and_a_model_is_looked_for_under_its_own_provider() -> None:
    assert catalogue_facts(CATALOGUE, "openai", "no-such-model") is None
    # The same model served by another provider is another entry, with that provider's numbers: a name is never looked for across them.
    of_together_alone = sorted(set(models("togetherai")) - set(models("openai")) - set(models("google")))
    assert of_together_alone
    assert catalogue_facts(CATALOGUE, "together", of_together_alone[0]) is not None
    assert catalogue_facts(CATALOGUE, "openai", of_together_alone[0]) is None
    assert catalogue_facts(CATALOGUE, "google", of_together_alone[0]) is None


def test_a_provider_a_catalogue_does_not_have_is_refused_when_run_as_it_is_by_both_checkers() -> None:
    # `None` is the answer for a model the catalogue lacks. Answered for a provider it lacks, it would say the same
    # of a name that was never one of the catalogue's: that is refused, by the name.
    with pytest.raises(ValueError, match=re.escape("A model catalogue has no provider 'mistral'")):
        facts_under_an_unknown_provider(CATALOGUE)


def test_a_fact_the_fixture_does_not_state_is_none() -> None:
    unstated = {"limit.input": 0, "structured_output": 0, "status": 0, "reasoning_options": 0}
    for ours, theirs in NAMES.items():
        for model, entry in models(theirs).items():
            facts = catalogue_facts(CATALOGUE, ours, model)
            assert facts is not None
            if thing(entry["limit"], model)["input"] is None:
                assert facts.limit.input is None
                unstated["limit.input"] += 1
            if entry["structured_output"] is None:
                assert facts.structured_output is None
                unstated["structured_output"] += 1
            if entry["status"] is None:
                assert facts.status is None
                unstated["status"] += 1
            if entry["reasoning_options"] is None:
                assert facts.reasoning_options is None
                unstated["reasoning_options"] += 1
    assert all(unstated.values()), f"the fixture states one of these of every model, and this read nothing of it: {unstated}"


def test_what_a_file_states_is_read_as_it_is_and_what_it_does_not_is_none(tmp_path: Path) -> None:
    stated = model_of(tmp_path, ENTRY)
    assert (stated.limit.context, stated.limit.input, stated.limit.output) == (400000, 272000, 128000)
    assert (stated.structured_output, stated.temperature, stated.reasoning, stated.status) == (True, False, True, "deprecated")
    assert stated.reasoning_options == (
        EffortOption(type="effort", values=("minimal", "low", "medium", "high")),
        ToggleOption(type="toggle"),
        BudgetTokensOption(type="budget_tokens", min=0, max=24576),
    )

    unstated = model_of(tmp_path, UNSTATED)
    assert (unstated.limit.context, unstated.limit.input, unstated.limit.output) == (128000, None, 16384)
    assert (unstated.structured_output, unstated.temperature, unstated.status, unstated.reasoning_options) == (None, None, None, None)
    # A model that does not reason is said so: that much the catalogue states of every model.
    assert unstated.reasoning is False


def test_a_catalogue_says_what_it_was_made_from_and_when(tmp_path: Path) -> None:
    catalogue = read_catalogue(kept(tmp_path, document(ENTRY)))
    assert (catalogue.package, catalogue.version, catalogue.license) == (NPM_PACKAGE, "0.0.1", "MIT")
    assert catalogue.generated_at == "2026-01-01T00:00:00.000Z"


def test_a_file_that_is_not_there_fails_naming_the_path(tmp_path: Path) -> None:
    # There is no other place a catalogue is looked for, and none is made up.
    absent = tmp_path / "model-catalogue.json"
    with pytest.raises(FileNotFoundError, match=re.escape(str(absent))):
        read_catalogue(absent)


def without(entry: JsonObject, member: str) -> JsonObject:
    return {name: value for name, value in entry.items() if name != member}


# Files that are not catalogues, each with where the reader says it is not one.
NOT_CATALOGUES: dict[str, tuple[bytes, str]] = {
    "a window of nothing": (
        document({**ENTRY, "limit": {"context": 0, "input": None, "output": 128000}}),
        "at providers.openai.models.m.limit.context, ",
    ),
    "an output ceiling of nothing": (
        document({**ENTRY, "limit": {"context": 400000, "input": None, "output": 0}}),
        "at providers.openai.models.m.limit.output, ",
    ),
    "an input ceiling of nothing": (
        document({**ENTRY, "limit": {"context": 400000, "input": 0, "output": 128000}}),
        "at providers.openai.models.m.limit.input, ",
    ),
    "a window that is not a whole number": (
        document({**ENTRY, "limit": {"context": 400000.5, "input": None, "output": 128000}}),
        "at providers.openai.models.m.limit.context, ",
    ),
    "no input ceiling at all, where null says none is stated": (
        document({**ENTRY, "limit": {"context": 400000, "output": 128000}}),
        "at providers.openai.models.m.limit.input, ",
    ),
    "no `structured_output` at all": (document(without(ENTRY, "structured_output")), "at providers.openai.models.m.structured_output, "),
    "no `temperature` at all": (document(without(ENTRY, "temperature")), "at providers.openai.models.m.temperature, "),
    "no `status` at all": (document(without(ENTRY, "status")), "at providers.openai.models.m.status, "),
    "no `reasoning_options` at all": (document(without(ENTRY, "reasoning_options")), "at providers.openai.models.m.reasoning_options, "),
    "a `structured_output` that is a number": (
        document({**ENTRY, "structured_output": 1}),
        "at providers.openai.models.m.structured_output, ",
    ),
    "a fact the reader does not know": (document({**ENTRY, "tool_call": True}), "at providers.openai.models.m.tool_call, "),
    "a limit the reader does not know": (
        document({**ENTRY, "limit": {"context": 400000, "input": None, "output": 128000, "reasoning": 1}}),
        "at providers.openai.models.m.limit.reasoning, ",
    ),
    "a status the reader does not know": (document({**ENTRY, "status": "retired"}), "at providers.openai.models.m.status, "),
    "a reasoning effort the reader does not know": (
        document({**ENTRY, "reasoning_options": [{"type": "effort", "values": ["low", "ultra"]}]}),
        "at providers.openai.models.m.reasoning_options.0.",
    ),
    "a reasoning effort that is null": (
        document({**ENTRY, "reasoning_options": [{"type": "effort", "values": [None, "low"]}]}),
        "at providers.openai.models.m.reasoning_options.0.",
    ),
    "a kind of reasoning option the reader does not know": (
        document({**ENTRY, "reasoning_options": [{"type": "schedule"}]}),
        "at providers.openai.models.m.reasoning_options.0.",
    ),
    "a budget with no `max` member": (
        document({**ENTRY, "reasoning_options": [{"type": "budget_tokens", "min": 0}]}),
        "at providers.openai.models.m.reasoning_options.0.",
    ),
    "a toggle with a member of its own": (
        document({**ENTRY, "reasoning_options": [{"type": "toggle", "values": ["on"]}]}),
        "at providers.openai.models.m.reasoning_options.0.",
    ),
    "a provider the reader does not know": (
        document(ENTRY, providers=("google", "mistral", "openai", "togetherai")),
        "at providers.mistral, ",
    ),
    "a provider missing": (document(ENTRY, providers=("google", "openai")), "at providers.togetherai, "),
    "the catalogue's own file, which is not this one": (json.dumps({"openai": {"id": "openai", "models": {}}}).encode(), "at "),
    "text that is not JSON": (b'{"package": "@opencode-ai/models", "vers', "is not a model catalogue: "),
    "nothing": (b"", "is not a model catalogue: "),
}


@pytest.mark.parametrize(("data", "where"), list(NOT_CATALOGUES.values()), ids=list(NOT_CATALOGUES))
def test_a_file_that_is_not_a_catalogue_fails_naming_the_path_and_no_value_is_put_in_its_place(
    tmp_path: Path, data: bytes, where: str
) -> None:
    path = kept(tmp_path, data)
    with pytest.raises(ValueError, match=re.escape(f"{path} is not a model catalogue: ")) as refusal:
        read_catalogue(path)
    assert where in str(refusal.value)


def test_what_the_reader_answers_cannot_be_changed_and_no_member_of_it_has_a_default(tmp_path: Path) -> None:
    catalogue = read_catalogue(kept(tmp_path, document(ENTRY)))
    facts = catalogue_facts(catalogue, "openai", "m")
    assert facts is not None
    assert facts.reasoning_options is not None
    for answer in (catalogue, facts, facts.limit, *facts.reasoning_options):
        for made in dataclasses.fields(answer):
            assert made.default is dataclasses.MISSING, f"{type(answer).__name__}.{made.name} has a default"
            assert made.default_factory is dataclasses.MISSING, f"{type(answer).__name__}.{made.name} has a default"
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(answer, dataclasses.fields(answer)[0].name, None)
        assert not hasattr(answer, "__dict__"), f"{type(answer).__name__} has no slots"


def test_the_notice_that_goes_with_a_catalogue_file_is_the_catalogues_mit_licence() -> None:
    notice = NOTICE.read_text(encoding="utf-8")
    assert "model-catalogue.json" in notice
    assert "\nMIT License\n\nCopyright (c) " in notice
    assert "The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions" in notice


def test_the_readme_says_what_a_catalogue_file_is_whose_it_is_and_that_the_package_carries_none() -> None:
    readme = (PACKAGE / "README.md").read_text(encoding="utf-8")
    for said in (
        "models.dev",
        f"`{NPM_PACKAGE}`",
        "`semiont_inference.catalogue`",
        "`read_catalogue`",
        "`catalogue_facts`",
        "`model-catalogue.json`",
        "`model-catalogue.LICENSE`",
        "MIT",
        "carries no copy",
        "downloads nothing",
    ):
        assert said in readme, f"the README does not say {said}"


def test_neither_a_wheel_nor_a_source_distribution_holds_any_of_the_catalogue(tmp_path: Path) -> None:
    # Both are built here, as `uv build` builds them, and what each holds is read from it.
    uv = shutil.which("uv")
    assert uv is not None, "uv, which builds the distributions, is not on the path"
    built = subprocess.run([uv, "build", "--out-dir", str(tmp_path), str(PACKAGE)], capture_output=True, text=True, check=False)
    assert built.returncode == 0, built.stderr
    (wheel,) = tmp_path.glob("*.whl")
    (sdist,) = tmp_path.glob("*.tar.gz")
    with zipfile.ZipFile(wheel) as held:
        in_the_wheel = held.namelist()
    with tarfile.open(sdist) as held:
        in_the_sdist = held.getnames()

    # The reader is in both, and it is all of the catalogue that is.
    assert "semiont_inference/catalogue.py" in in_the_wheel
    assert any(name.endswith("/src/semiont_inference/catalogue.py") for name in in_the_sdist)
    for names in (in_the_wheel, in_the_sdist):
        assert [name for name in names if "model-catalogue" in name or name.endswith((".json", ".LICENSE"))] == []
        assert [name for name in names if "/tests/" in name or name.startswith("tests/")] == []
    # What a wheel holds of the package beside its modules is the marker that says it is typed.
    beside = [name for name in in_the_wheel if name.startswith("semiont_inference/") and not name.endswith(".py")]
    assert beside == ["semiont_inference/py.typed"]
