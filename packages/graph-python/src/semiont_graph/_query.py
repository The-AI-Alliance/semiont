"""A listing of resources (filtering, ranking and paging), for a store whose database does not express it.

The in-memory store and the two Gremlin stores answer a listing from here,
so the three cannot drift apart. Neo4j expresses the same in Cypher, and the
contract tests hold both to one behaviour.
"""

from collections.abc import Iterable
from datetime import datetime

from semiont.resources import primary_representation
from semiont.types import ResourceDescriptor

from semiont_graph.interface import ResourceListing, ResourceQuery


def search_terms(search: str) -> list[str]:
    """The words every match must have. None for a search of only white space, which is then no search at all."""
    return search.lower().split()


def _name(resource: ResourceDescriptor) -> str:
    return resource.name.lower()


def search_rank(resource: ResourceDescriptor, search: str) -> int:
    """How directly a resource answers a search: 0 named exactly that, 1 its name begins with it, 2 its name has every word, 3 the rest.

    The rest are those whose storage location or entity types had to supply
    a word, and they rank last on purpose: whoever searches for "Marathon"
    wants the document called Marathon before every file under a folder of
    that name.
    """
    whole, name = search.strip().lower(), _name(resource)
    if name == whole:
        return 0
    if name.startswith(whole):
        return 1
    if all(term in name for term in search_terms(search)):
        return 2
    return 3


def _matches(resource: ResourceDescriptor, terms: list[str]) -> bool:
    """Whether every word appears, each in the name, the storage location or an entity type."""
    name = _name(resource)
    representation = primary_representation(resource)
    location = ((representation.storage_uri if representation is not None else None) or "").lower()
    types = [entity_type.lower() for entity_type in resource.entity_types or ()]
    return all(term in name or term in location or any(term in entity_type for entity_type in types) for term in terms)


def _created(resource: ResourceDescriptor) -> float:
    """When a resource was created, as a number to order by. The earliest of all for one with no date."""
    if not resource.date_created:
        return 0.0
    return datetime.fromisoformat(resource.date_created).timestamp()


def query_resources(resources: Iterable[ResourceDescriptor], query: ResourceQuery) -> ResourceListing:
    """The page of `resources` a query answers. Filters run before paging, so the total is of every match and not of the page."""
    matches = list(resources)
    if query.entity_types:
        matches = [resource for resource in matches if any(wanted in (resource.entity_types or ()) for wanted in query.entity_types)]
    terms = search_terms(query.search) if query.search else []
    if terms:
        matches = [resource for resource in matches if _matches(resource, terms)]
    if query.archived is not None:
        matches = [resource for resource in matches if (resource.archived or False) == query.archived]

    search = query.search if terms and query.search else None

    def order(resource: ResourceDescriptor) -> tuple[int, float, str]:
        return (0 if search is None else search_rank(resource, search), -_created(resource), resource.id)

    ordered = sorted(matches, key=order)
    return ResourceListing(resources=ordered[query.offset : query.offset + query.limit], total=len(ordered))
