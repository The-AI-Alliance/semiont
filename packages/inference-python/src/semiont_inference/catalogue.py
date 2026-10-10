"""A model catalogue: what models.dev says of a model, read from a file this package is pointed to.

Some providers' APIs do not state what a model can take. OpenAI's states no
limits, and OpenAI's, Google's and Together's do not say whether a model
holds a reply to a schema, which reasoning efforts it takes, or whether it
takes a temperature. models.dev (https://models.dev) is an open database
that does, kept by its maintainers from each provider's documentation.

This package carries no copy of it and downloads nothing. A catalogue file
holds the part of the database a driver reads. It is made by
`scripts/inference/generate-model-catalogue.mjs` of the repository, from the
npm package `@opencode-ai/models` at the version the repository pins, when an
image is built. Whoever runs a driver whose provider is silent reads that
file with `read_catalogue`, at the path it was given, and looks its model up
with `catalogue_facts`. There is no path this module reads on its own.

**Whose word a fact from a catalogue is.** The catalogue's, and never the
provider's: a third party's reading of the provider's documentation, as old
as the file. A driver takes it only for what its provider's own API does not
state, and says of what it learned this way that it learned it this way.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Final, Literal, final

from pydantic import ConfigDict, Field, PositiveInt, TypeAdapter, ValidationError

__all__ = [
    "BudgetTokensOption",
    "Catalogue",
    "CatalogueFacts",
    "CatalogueLimit",
    "CatalogueProvider",
    "EffortOption",
    "ModelStatus",
    "ReasoningEffort",
    "ReasoningOption",
    "ToggleOption",
    "catalogue_facts",
    "read_catalogue",
]

type CatalogueProvider = Literal["google", "openai", "together"]
"""A provider whose models a catalogue file has, by this package's name for it."""

type ReasoningEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]
"""A reasoning effort, by the word the provider's API takes. A catalogue file that holds another is refused."""

type ModelStatus = Literal["alpha", "beta", "deprecated"]
"""Where a model is in its life. `deprecated` is one the provider's public API no longer serves."""

# How every part of a catalogue file is read: a member that is not known is refused, and no value is made into another.
_AS_WRITTEN: Final = ConfigDict(extra="forbid", strict=True)


@final
@dataclass(frozen=True, slots=True)
class EffortOption:
    """Reasoning set by a named effort.

    `values` are the efforts the provider takes for the model, in the order
    the catalogue lists them, which is not from least to most for every
    model.
    """

    __pydantic_config__ = _AS_WRITTEN

    type: Literal["effort"]
    values: tuple[ReasoningEffort, ...]


@final
@dataclass(frozen=True, slots=True)
class ToggleOption:
    """Reasoning that is turned on or off."""

    __pydantic_config__ = _AS_WRITTEN

    type: Literal["toggle"]


@final
@dataclass(frozen=True, slots=True)
class BudgetTokensOption:
    """Reasoning set by a budget of tokens, from `min` to `max`, each where the catalogue states it.

    The catalogue writes a `min` of -1 for a budget the model sets itself.
    """

    __pydantic_config__ = _AS_WRITTEN

    type: Literal["budget_tokens"]
    min: int | None
    max: int | None


type ReasoningOption = EffortOption | ToggleOption | BudgetTokensOption
"""One way a model's reasoning is set, as the catalogue describes it."""


@final
@dataclass(frozen=True, slots=True)
class CatalogueLimit:
    """A model's limits, in tokens, as the catalogue states them.

    `context` is the whole window, shared by what the model reads and what it
    writes. It is not the most the model reads: that is `input`, where the
    catalogue states one, and otherwise the window less what is written.
    `output` is the most the model writes.

    The numbers are the catalogue's as they stand. They are not checked
    against each other here.
    """

    __pydantic_config__ = _AS_WRITTEN

    context: PositiveInt
    input: PositiveInt | None
    output: PositiveInt


@final
@dataclass(frozen=True, slots=True)
class CatalogueFacts:
    """What the catalogue says of one model as one provider serves it. It is not the provider's own word.

    A fact the catalogue does not state is `None`, and never a value in its
    place: `None` is not `False`, and no limit is zero.

    `structured_output` is whether the model holds a reply to a JSON Schema.
    `temperature` is whether it takes one. `reasoning` is whether it reasons
    before it answers, which the catalogue states of every model, and
    `reasoning_options` the ways that reasoning is set: `None` where the
    catalogue lists none, which is every model that does not reason, and
    empty for a model that reasons with no way stated to set how much.
    `status` is `None` for a model in general use.
    """

    __pydantic_config__ = _AS_WRITTEN

    limit: CatalogueLimit
    reasoning: bool
    reasoning_options: tuple[ReasoningOption, ...] | None
    status: ModelStatus | None
    structured_output: bool | None
    temperature: bool | None


@final
@dataclass(frozen=True, slots=True)
class _Models:
    """One provider's models, each by the id the provider's API takes."""

    __pydantic_config__ = _AS_WRITTEN

    models: dict[str, CatalogueFacts]


@final
@dataclass(frozen=True, slots=True)
class _Providers:
    """The providers a catalogue file has, by the catalogue's names for them."""

    __pydantic_config__ = _AS_WRITTEN

    google: _Models
    openai: _Models
    togetherai: _Models


@final
@dataclass(frozen=True, slots=True)
class Catalogue:
    """A catalogue file, read.

    `package` and `version` are the npm package the file was made from,
    `generated_at` is when that package's snapshot of the database was made,
    which is how old the facts are, and `license` is the licence the package
    is distributed under. A model's facts are asked of it with
    `catalogue_facts`.
    """

    __pydantic_config__ = _AS_WRITTEN

    package: str
    version: str
    generated_at: Annotated[str, Field(alias="generatedAt")]
    license: str
    providers: _Providers


_CATALOGUE: Final = TypeAdapter(Catalogue)


def read_catalogue(path: Path) -> Catalogue:
    """The catalogue in the file at `path`, which is the JSON the generator writes.

    Nothing is filled in, and nothing is read from anywhere else. A file that
    is not there raises as the system says it, an `OSError` that names the
    path. A file that is not a catalogue raises a `ValueError` that names the
    path and says what in it is not one: a member missing, a member or a word
    this module does not know, a limit that is not above zero.
    """
    try:
        return _CATALOGUE.validate_json(path.read_bytes())
    except ValidationError as invalid:
        first, *others = invalid.errors()
        where = ".".join(str(step) for step in first["loc"])
        raise ValueError(
            f"{path} is not a model catalogue: {f'at {where}, ' if where else ''}{first['msg']}"
            f"{f' (and {len(others)} more of the kind)' if others else ''}"
        ) from invalid


def catalogue_facts(catalogue: Catalogue, provider: CatalogueProvider, model_id: str) -> CatalogueFacts | None:
    """What `catalogue` says of `model_id` as `provider` serves it, or `None` for a model it does not have.

    A model is looked for under its provider alone. The same model served by
    another provider is another entry, with that provider's numbers.

    A dated snapshot of a model (`gpt-5-2025-08-07`) is an id of its own, and
    the catalogue has few of them: the facts of the alias are not answered
    for it.
    """
    match provider:
        case "google":
            return catalogue.providers.google.models.get(model_id)
        case "openai":
            return catalogue.providers.openai.models.get(model_id)
        case "together":
            return catalogue.providers.togetherai.models.get(model_id)
