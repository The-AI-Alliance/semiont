"""A provider a model catalogue has no entries of is not one a model's facts can be asked under."""

from semiont_inference.catalogue import Catalogue, CatalogueFacts, catalogue_facts


def facts_under_an_unknown_provider(catalogue: Catalogue) -> CatalogueFacts | None:
    return catalogue_facts(catalogue, "mistral", "mistral-large")  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
