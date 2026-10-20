"""Naming the people a reply mentions, over one read of what the knowledge base calls them.

No stored thing carries a person's name (`docs/protocol/LIBRARIAN.md` §
Names). A person is identified by an id, and what the knowledge base calls
them is in the people projection, which the Archivist keeps and is asked, on
the bus, for the people a reply mentions. A reply is named as it goes out:
every person in it, wherever it is, is given the name the projection states
for its id. `specs/src/librarian/naming-cases.json`
states the rule, and the tests run every case of it.

A reply is read here as the wire carries it: objects, lists, text, numbers
and nothing. So a person is found by what it says of itself (`@type`), in
whatever shape of reply holds it, and no list of the places a person may be
is kept.
"""

from collections.abc import Mapping

from pydantic import JsonValue
from semiont.types import PersonProfile

from semiont_librarian.log import LOG
from semiont_librarian.reads import People, PeopleUnread

__all__ = ["name", "named"]


def _person(said: Mapping[str, JsonValue]) -> str | None:
    """The id an object states, where it is a person: its `@type` is `Person` and its `@id` is text. `None` for any other object."""
    identity = said.get("@id")
    return identity if said.get("@type") == "Person" and isinstance(identity, str) else None


def named(reply: JsonValue, people: Mapping[str, PersonProfile]) -> JsonValue:
    """`reply` with its people named: a copy, in which every person `people` has a profile of states that profile's name.

    A person is an object whose `@type` is `Person`, wherever in the reply
    it is: the reply itself, a member of an object, an item of a list, or a
    member of another person. Its `name` is set to the name `people` states
    for its `@id`, in place of any it carried. A person `people` has no
    profile of is left as it is, with the name it carried or with none, and
    so is every object of another type, an agent that is software among
    them. Nothing else of the reply changes.

    A profile is looked up by key in a mapping. Only a profile the
    projection states can answer, whatever text a person's `@id` is.
    """
    if isinstance(reply, list):
        items: list[JsonValue] = [named(item, people) for item in reply]
        return items
    if not isinstance(reply, dict):
        return reply
    said: dict[str, JsonValue] = {key: named(member, people) for key, member in reply.items()}
    identity = _person(reply)
    if identity is not None:
        profile = people.get(identity)
        if profile is not None:
            said["name"] = profile.name
    return said


def _people_of(reply: JsonValue, found: dict[str, None]) -> None:
    """Add to `found` the id of every person in `reply`, wherever it is, in the order each first appears: the walk `named` makes."""
    if isinstance(reply, list):
        for item in reply:
            _people_of(item, found)
        return
    if not isinstance(reply, dict):
        return
    identity = _person(reply)
    if identity is not None:
        found[identity] = None
    for member in reply.values():
        _people_of(member, found)


async def name(reply: JsonValue, people: People) -> JsonValue:
    """`reply` with its people named, over one read of what the knowledge base calls the people in it.

    Each person the reply mentions is asked after once, in the order they
    first appear, and a reply that mentions no one asks nothing. A name is
    added to an answer and is none itself: where the people cannot be read,
    a warning is logged and the reply is sent as it is, which is how a reply
    reads where nobody has a profile.
    """
    found: dict[str, None] = {}
    _people_of(reply, found)
    if not found:
        return reply
    try:
        profiles = await people.of([*found])
    except PeopleUnread as unread:
        LOG.warning("People projection unreadable: this reply names no one", extra={"error": str(unread)})
        return reply
    return named(reply, profiles)
