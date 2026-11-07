# Generated from protocol/specs/src/session/stored.json; do not edit.
# Regenerate: node packages/codegen/schemas/generate-stored-python.mjs

"""What a registry of knowledge bases keeps in a `SessionStorage` (`protocol/specs/src/session/stored.json`):
the key each thing it keeps is kept under, the shape of a knowledge base's
stored session, and the shape of a resource open in one.
"""

from typing import Annotated, Final, final

from pydantic import Field

from semiont.identifiers import ResourceId
from semiont.model import WireModel

__all__ = [
    "ACTIVE_KEY",
    "KNOWLEDGE_BASES_KEY",
    "LAST_VIEWED_RESOURCE_BY_KB_KEY",
    "OPEN_RESOURCES_BY_KB_KEY",
    "PENDING_AUTHORIZATION_KEY",
    "OpenResource",
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
# its open resources, each an `openResource`.
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


# Where a knowledge base's stream was is kept under this followed by the knowledge base's id: a
# JSON object from a scope, a resource's id, to the id of the last recorded event delivered on
# it. It is written only with a write of the caches kept beside it, so it never leads them.
_LAST_EVENT_ID_KEY_PREFIX: Final = "semiont.lastEventId."


def last_event_id_key(kb_id: str) -> str:
    """The key a knowledge base's stream's places are kept under."""
    return f"{_LAST_EVENT_ID_KEY_PREFIX}{kb_id}"


# What a client keeps of a query is kept under this followed by its persistence's key prefix, a
# dot and the query's name. A registry's session takes the knowledge base's id for its key
# prefix.
_CACHE_KEY_PREFIX: Final = "semiont.cache."


def cache_key(key_prefix: str, name: str) -> str:
    """The key the query `name` is kept under, by a persistence whose key prefix is `key_prefix`."""
    return f"{_CACHE_KEY_PREFIX}{key_prefix}.{name}"


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


@final
class OpenResource(WireModel, frozen=True):
    """A resource open in a knowledge base: which resource, the name it is shown by, when it was
    opened and its place among the others open there. A registry shows them by their places, and
    two in one place by when each was opened, first first.
    """

    # The resource.
    id: ResourceId

    # The name the resource is shown by.
    name: str

    # When the resource was opened, in milliseconds since the Unix epoch. Opening it again while
    # it is open changes neither this nor its place.
    opened_at: Annotated[int, Field(alias="openedAt", ge=0)]

    # The resource's place among those open in the knowledge base. One opened is given the place
    # after the last taken, so a place freed by closing one is not given twice; a move gives
    # each its place in the new order, counted from 0.
    order: Annotated[int, Field(ge=0)]

    # The resource's media type, which its icon is chosen by. Absent when it is not known.
    media_type: Annotated[str | None, Field(alias="mediaType")] = None

    # Where the resource is in the knowledge base's working tree, as a URI
    # (file://docs/overview.md). Absent when it is not known.
    storage_uri: Annotated[str | None, Field(alias="storageUri")] = None
