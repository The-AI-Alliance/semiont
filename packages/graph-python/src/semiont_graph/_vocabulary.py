"""The entity types every knowledge base starts with."""

from typing import Final

# `specs/src/graph/default-entity-types.json` is where this list is stated. tests/test_census.py holds this
# copy to it, and `@semiont/ontology`'s tests hold TypeScript's.
DEFAULT_ENTITY_TYPES: Final = (
    "Person",
    "Organization",
    "Location",
    "Event",
    "Concept",
    "Product",
    "Technology",
    "Date",
    "Author",
)
