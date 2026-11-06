# Generated from protocol/specs/src/session/stored.json; do not edit.
# Regenerate: node packages/codegen/schemas/generate-stored-python.mjs

"""What a registry of knowledge bases keeps in a `SessionStorage` (`protocol/specs/src/session/stored.json`):
the key each thing it keeps is kept under, and the shape of a knowledge base's
stored session.
"""

from typing import Annotated, Final, final

from pydantic import Field

from semiont._digest import base64url_sha256
from semiont.model import WireModel

__all__ = [
    "ACTIVE_KEY",
    "KNOWLEDGE_BASES_KEY",
    "LAST_VIEWED_RESOURCE_BY_KB_KEY",
    "OPEN_RESOURCES_BY_KB_KEY",
    "PENDING_AUTHORIZATION_KEY",
    "StoredSession",
    "kb_of_session_key",
    "session_key",
]

# The registered knowledge bases: a JSON list of KnowledgeBase
# (components/schemas/KnowledgeBase.json).
KNOWLEDGE_BASES_KEY: Final = "semiont.knowledgeBases"

# The id of the active knowledge base. Nothing is kept under it while none is active.
ACTIVE_KEY: Final = "semiont.activeKnowledgeBaseId"

# What is open in each knowledge base: a JSON object from a knowledge base's id to the list of
# its open resources.
OPEN_RESOURCES_BY_KB_KEY: Final = "semiont.openResourcesByKb"

# Where the person was in each knowledge base: a JSON object from a knowledge base's id to the
# id of the resource last viewed in it.
LAST_VIEWED_RESOURCE_BY_KB_KEY: Final = "semiont.lastViewedResourceByKb"

# A sign-in by a page redirect that is under way: what it remembers across the trip to the
# issuer and back. It is taken when the sign-in completes, so a callback that is replayed finds
# nothing to complete.
PENDING_AUTHORIZATION_KEY: Final = "semiont.pendingAuthorization"

# A knowledge base's stored session is kept under this followed by the knowledge base's id.
_SESSION_KEY_PREFIX: Final = "semiont.session."


def session_key(kb_id: str) -> str:
    """The key a knowledge base's session is kept under."""
    return f"{_SESSION_KEY_PREFIX}{kb_id}"


def kb_of_session_key(key: str) -> str | None:
    """The knowledge base a key is the session of; nothing when it is no session's key."""
    return key.removeprefix(_SESSION_KEY_PREFIX) if key.startswith(_SESSION_KEY_PREFIX) else None


# Where a knowledge base's stream was, for one person, is kept under this followed by the
# knowledge base's id, a dot and the person's key: the unpadded base64url SHA-256 of the UTF-8
# of the did the gateway answers for the person's token (components/schemas/UserResponse.json),
# never the did itself. What is kept is a JSON object from a scope, a resource's id, to the id
# of the last recorded event delivered on it. It is written only with a write of the caches kept
# beside it, so it never leads them. Nothing is kept for a token whose person the gateway has
# not named, and signing out of the knowledge base deletes it.
_LAST_EVENT_ID_KEY_PREFIX: Final = "semiont.lastEventId."


def person_key(did: str) -> str:
    """The key of the person whose did the gateway answered: what their caches and stream's places are kept under."""
    return base64url_sha256(did)


def last_event_id_key(kb_id: str, person_key: str) -> str:
    """The key a person's stream's places in a knowledge base are kept under."""
    return f"{_LAST_EVENT_ID_KEY_PREFIX}{kb_id}.{person_key}"


# What a client keeps of a query, for one person, is kept under this followed by the knowledge
# base's id, a dot, the person's key as `lastEventIdKeyPrefix` makes it, a dot and the query's
# name. The queries kept are those protocol/specs/src/client/refresh.json marks `persisted`,
# each under its name there, and each as one JSON document, `{"version": 1, "writtenAt": …,
# "entries": [[key, value, writtenAt], …]}`: an entry's key as JSON, its value, and when the
# value was last written, in milliseconds since the Unix epoch
# (protocol/contract/CACHE-SEMANTICS.md, B17). Nothing is kept for a token whose person the
# gateway has not named, and signing out of the knowledge base deletes the key of every
# persisted query.
_CACHE_KEY_PREFIX: Final = "semiont.cache."


def cache_key(kb_id: str, person_key: str, query: str) -> str:
    """The key what a person's client keeps of the query `query` in a knowledge base is kept under."""
    return f"{_CACHE_KEY_PREFIX}{kb_id}.{person_key}.{query}"


@final
class StoredSession(WireModel, frozen=True):
    """What is kept of a sign-in: the tokens an issuer issued, the client they were issued to, and
    the issuer's endpoints a renewal and a sign-out need, learned once at sign-in so no session
    asks again. TOKENS, never a password. A stored value that lacks a member it requires is no
    session.
    """

    # The access token: short-lived, sent as a Bearer token.
    access: str

    # The refresh token: what renews the access token at the issuer without another sign-in.
    refresh: str

    # The client the tokens were issued to, which a renewal and a revocation name.
    client_id: Annotated[str, Field(alias="clientId")]

    # The issuer's token endpoint, where the refresh grant is made.
    token_endpoint: Annotated[str, Field(alias="tokenEndpoint")]

    # The issuer's revocation endpoint (RFC 7009), where a sign-out tells it to forget the
    # refresh token. Absent when the issuer has none.
    revocation_endpoint: Annotated[str | None, Field(alias="revocationEndpoint")] = None

    # Who the gateway said the sign-in's person is, as the key their caches and stream position
    # are kept under (`lastEventIdKeyPrefix`), never the did itself. Written once the gateway
    # names the person, on the sign-in whose token it was asked about; a renewal keeps it, a new
    # sign-in starts without it, and a sign-out reads it to delete what is kept under it. Absent
    # for a sign-in whose gateway has not yet named its person.
    person_key: Annotated[str | None, Field(alias="personKey")] = None
