"""Naming the persons a reply mentions, over one read of their profiles.

No stored thing carries a person's name (`docs/protocol/LIBRARIAN.md` §
Names). A person is identified by an id, and what it last said it is called
is its profile, in the profiles projection, which the Archivist keeps and is
asked, on the bus, for the profiles of the persons a reply mentions. A reply
is named as it goes out: every person in it, wherever it is, is given the
name the projection states for its id. `specs/src/librarian/naming-cases.json`
states the rule, and the tests run every case of it.

A reply is read here as the wire carries it: objects, lists, text, numbers
and nothing. So a person is found by what it says of itself (`@type`), in
whatever shape of reply holds it, and no list of the places a person may be
is kept.
"""

from collections.abc import Mapping

from pydantic import JsonValue
from semiont.types import Profile

from semiont_librarian.log import LOG
from semiont_librarian.reads import Profiles, ProfilesUnread

__all__ = ["name", "named"]


def _person(said: Mapping[str, JsonValue]) -> str | None:
    """The id an object states, where it is a person: its `@type` is `Person` and its `@id` is text. `None` for any other object."""
    identity = said.get("@id")
    return identity if said.get("@type") == "Person" and isinstance(identity, str) else None


def named(reply: JsonValue, profiles: Mapping[str, Profile]) -> JsonValue:
    """`reply` with its persons named: a copy, in which every person `profiles` has a profile of states that profile's name.

    A person is an object whose `@type` is `Person`, wherever in the reply
    it is: the reply itself, a member of an object, an item of a list, or a
    member of another person. Its `name` is set to the name `profiles` states
    for its `@id`, in place of any it carried. A person `profiles` has no
    profile of is left as it is, with the name it carried or with none, and
    so is every object of another type, an agent that is software among
    them. Nothing else of the reply changes.

    A profile is looked up by key in a mapping. Only a profile the
    projection states can answer, whatever text a person's `@id` is.
    """
    if isinstance(reply, list):
        items: list[JsonValue] = [named(item, profiles) for item in reply]
        return items
    if not isinstance(reply, dict):
        return reply
    said: dict[str, JsonValue] = {key: named(member, profiles) for key, member in reply.items()}
    identity = _person(reply)
    if identity is not None:
        profile = profiles.get(identity)
        if profile is not None:
            said["name"] = profile.name
    return said


def _persons_of(reply: JsonValue, found: dict[str, None]) -> None:
    """Add to `found` the id of every person in `reply`, wherever it is, in the order each first appears: the walk `named` makes."""
    if isinstance(reply, list):
        for item in reply:
            _persons_of(item, found)
        return
    if not isinstance(reply, dict):
        return
    identity = _person(reply)
    if identity is not None:
        found[identity] = None
    for member in reply.values():
        _persons_of(member, found)


async def name(reply: JsonValue, profiles: Profiles) -> JsonValue:
    """`reply` with its persons named, over one read of the profiles of the persons in it.

    Each person the reply mentions is asked after once, in the order they
    first appear, and a reply that mentions no one asks nothing. A name is
    added to an answer and is none itself: where the profiles cannot be read,
    a warning is logged and the reply is sent as it is, which is how a reply
    reads where nobody has a profile.
    """
    found: dict[str, None] = {}
    _persons_of(reply, found)
    if not found:
        return reply
    try:
        known = await profiles.of([*found])
    except ProfilesUnread as unread:
        LOG.warning("Profiles projection unreadable: this reply names no one", extra={"error": str(unread)})
        return reply
    return named(reply, known)
