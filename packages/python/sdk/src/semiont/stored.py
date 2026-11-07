# Generated from protocol/specs/src/session/stored.json; do not edit.
# Regenerate: node packages/codegen/schemas/generate-stored-python.mjs

"""What a registry of knowledge bases keeps in a `SessionStorage` (`protocol/specs/src/session/stored.json`):
the key each thing it keeps is kept under, the shape of a knowledge base's
stored session, and the shape of a resource open in one. And what the
sessions it makes keep there: which queries, and the stream's places.
"""

from typing import Annotated, Final, Literal, final

from pydantic import Field

from semiont._digest import base64url_sha256
from semiont.identifiers import ResourceId
from semiont.model import WireModel
from semiont.types import PersistedEventId

__all__ = [
    "ACTIVE_KEY",
    "CACHE_DOCUMENT_VERSION",
    "KEPT_QUERIES",
    "KNOWLEDGE_BASES_KEY",
    "LAST_VIEWED_RESOURCE_BY_KB_KEY",
    "OPEN_RESOURCES_BY_KB_KEY",
    "PENDING_AUTHORIZATION_KEY",
    "WHOLE_KEY",
    "KeptQuery",
    "LastEventIds",
    "OpenResource",
    "StoredSession",
    "WholeKey",
    "cache_key",
    "kb_of_session_key",
    "last_event_id_key",
    "person_key",
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


# Where a knowledge base's stream was, for one person, is kept under this followed by the
# knowledge base's id, a dot and the person's key: the unpadded base64url SHA-256 of the UTF-8
# of the did the gateway answers for the person's token (components/schemas/UserResponse.json),
# never the did itself. What is kept is `lastEventIds`. It is written in the same call as a
# write of one of the caches kept beside it, and only while every kept cache has no fetch in
# flight and owes no save, and the refresher owes no refetch (a window of B19,
# protocol/contract/CACHE-SEMANTICS.md, that holds an invalidation it has not yet run); so it
# never leads them. Its own write is never a reason to write a cache. At disposal this is read
# once, before any kept cache or the refresher is disposed. Nothing is kept for a token whose
# person the gateway has not named, and forgetting the knowledge base's stored sign-in, however
# it is forgotten, deletes it.
_LAST_EVENT_ID_KEY_PREFIX: Final = "semiont.lastEventId."


def person_key(did: str) -> str:
    """The key of the person whose did the gateway answered: what their caches and stream's places are kept under."""
    return base64url_sha256(did)


def last_event_id_key(kb_id: str, person_key: str) -> str:
    """The key a person's stream's places in a knowledge base are kept under, as `LastEventIds`."""
    return f"{_LAST_EVENT_ID_KEY_PREFIX}{kb_id}.{person_key}"


# Where a knowledge base's stream was: for each scope, a resource's id, the id of the last
# recorded event delivered on it.
type LastEventIds = dict[ResourceId, PersistedEventId]


# What a client keeps of a query, for one person, is kept under this followed by the knowledge
# base's id, a dot, the person's key as `lastEventIdKeyPrefix` makes it, a dot and the query's
# name: one `cacheDocument` for each query protocol/specs/src/client/refresh.json marks
# `persisted`. Nothing is kept for a token whose person the gateway has not named, and
# forgetting the knowledge base's stored sign-in, however it is forgotten, deletes the key of
# every kept query.
_CACHE_KEY_PREFIX: Final = "semiont.cache."

# The queries a client keeps across a restart, each by its name in
# protocol/specs/src/client/refresh.json, and each as one document under `cache_key`.
type KeptQuery = Literal[
    # Keyed by ResourceId; its value is ResourceDescriptor.
    "resource",
    # Keyed by ResourceId; its value is GetAnnotationsResponse.
    "annotations",
    # Keyed by AnnotationId; its value is Annotation.
    "annotation",
    # Keyed by WHOLE_KEY alone; its value is GetEntityTypesResponse's `entityTypes`.
    "entityTypes",
    # Keyed by WHOLE_KEY alone; its value is GetTagSchemasResponse's `tagSchemas`.
    "tagSchemas",
]

KEPT_QUERIES: Final[tuple[KeptQuery, ...]] = (
    "resource",
    "annotations",
    "annotation",
    "entityTypes",
    "tagSchemas",
)


def cache_key(kb_id: str, person_key: str, query: KeptQuery) -> str:
    """The key what a person's client keeps of `query` in a knowledge base is kept under."""
    return f"{_CACHE_KEY_PREFIX}{kb_id}.{person_key}.{query}"


# The key a kept query that is per nothing (a `queries` row of
# protocol/specs/src/client/refresh.json with no `per`) keeps its one entry under.
type WholeKey = Literal["_"]
WHOLE_KEY: Final[WholeKey] = "_"

# The form of the document. A document of another version is read as none.
CACHE_DOCUMENT_VERSION: Final = 1


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
    # sign-in starts without it, and forgetting the sign-in, however it is forgotten, reads it
    # first to delete what is kept under it. Absent for a sign-in whose gateway has not yet
    # named its person.
    person_key: Annotated[str | None, Field(alias="personKey")] = None


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
