"""Naming the people a reply mentions, over one read of what the knowledge base calls them.

No stored thing carries a person's name (`docs/protocol/LIBRARIAN.md` §
Names). A person is identified by an id, and what the knowledge base calls
them is in the people projection, which the Archivist keeps. A reply is
named as it goes out: every person in it, wherever it is, is given the name
the projection states for its id. `specs/src/librarian/naming-cases.json`
states the rule, and the tests run every case of it.

A reply is read here as the wire carries it: objects, lists, text, numbers
and nothing. So a person is found by what it says of itself (`@type`), in
whatever shape of reply holds it, and no list of the places a person may be
is kept.
"""

from collections.abc import Callable, Mapping

from pydantic import JsonValue
from semiont.types import PeopleProjectionPeopleValue

from semiont_librarian.log import LOG
from semiont_librarian.reads import People, PeopleUnread

__all__ = ["named", "namer"]


def named(reply: JsonValue, people: Mapping[str, PeopleProjectionPeopleValue]) -> JsonValue:
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
    identity = reply.get("@id")
    if reply.get("@type") == "Person" and isinstance(identity, str):
        profile = people.get(identity)
        if profile is not None:
            said["name"] = profile.name
    return said


def _as_it_is(reply: JsonValue) -> JsonValue:
    """A reply with no one named."""
    return reply


async def namer(people: People) -> Callable[[JsonValue], JsonValue]:
    """What names the people of one reply, over one read of the projection: one read for each reply, and not one for each person.

    A name is added to an answer and is none itself. A projection that
    cannot be read is logged as a warning, and the reply is then sent with
    no one named, which is how a reply reads where nobody has a profile.
    """
    try:
        profiles = await people.read()
    except PeopleUnread as unread:
        LOG.warning("People projection unreadable: this reply names no one", extra={"error": str(unread)})
        return _as_it_is

    def name(reply: JsonValue) -> JsonValue:
        return named(reply, profiles)

    return name
