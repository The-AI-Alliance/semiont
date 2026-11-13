"""What the runners of the registry's tables share: its knowledge bases, a sign-in kept for each, and a client left owing its save.

A registry's knowledge base is registered at an address nobody is asked at,
for a factory that builds over a transport of its own or refuses, or at the
tests' gateway server, which is asked who every token is and names Alice.
"""

from collections.abc import Sequence
from typing import Final

from aio import soon
from gateway_server import GatewayServer
from issuer import ALICE
from spec import JsonObject, text
from tokens import token

from semiont.registry import SemiontBrowser, save_knowledge_bases, store_session
from semiont.session import SemiontSession
from semiont.storage import SessionStorage
from semiont.stored import ACTIVE_KEY, StoredSession, person_key
from semiont.transport import Transport
from semiont.types import HttpEndpoint, KnowledgeBase
from semiont.watched import reached

KB_A: Final = "kb-a"
"""The knowledge base a registry has active first."""

ALICE_KEY: Final = person_key(text(ALICE["did"], "Alice's did"))
"""The key of the person the gateway server names for every token: what a client keeps hers under."""

UNREACHED_ISSUER: Final = "https://issuer.test/token"
"""The token endpoint of a sign-in kept for a knowledge base nobody is asked at: none of its rows renews."""


def unreached(kb_id: str, label: str) -> KnowledgeBase:
    """A knowledge base registered at an address nobody is asked at."""
    return _kb(kb_id, label, HttpEndpoint(kind="http", host="localhost", port=4000, protocol="http"))


def registered(gateway: GatewayServer, kb_id: str, label: str) -> KnowledgeBase:
    """A knowledge base registered at `gateway`."""
    endpoint = gateway.target(kb_id).endpoint
    assert isinstance(endpoint, HttpEndpoint)
    return _kb(kb_id, label, endpoint)


def _kb(kb_id: str, label: str, endpoint: HttpEndpoint) -> KnowledgeBase:
    return KnowledgeBase(id=kb_id, label=label, did=f"did:web:example.org:{kb_id}", endpoint=endpoint)


def signed_in(token_endpoint: str) -> StoredSession:
    """A stored sign-in whose token is good for an hour, naming nobody until a gateway names them."""
    return StoredSession(access=token(3600, 1), refresh="refresh-1", client_id="semiont-browser", token_endpoint=token_endpoint)


def holding_signed_in(storage: SessionStorage, kbs: Sequence[KnowledgeBase], token_endpoint: str) -> SessionStorage:
    """`storage`, holding each of `kbs`, signed in, and the first of them as the active one: the one a registry over it activates."""
    save_knowledge_bases(storage, kbs)
    for kb in kbs:
        store_session(storage, kb.id, signed_in(token_endpoint))
    storage.set(ACTIVE_KEY, kbs[0].id)
    return storage


def answering_entity_types(gateway: GatewayServer) -> None:
    """Have the gateway answer a read of the entity types, which a client keeps."""

    def answer(emit: JsonObject) -> None:
        if emit["channel"] == "browse:entity-types-requested":
            said: JsonObject = {"response": {"entityTypes": ["Person", "Place"]}}
            gateway.send(None, {"channel": "browse:entity-types-result", "payload": said, "correlationId": emit["correlationId"]})

    gateway.on_emit = answer


async def active_session(browser: SemiontBrowser) -> SemiontSession[Transport]:
    session = await soon(reached(browser.active_session, lambda session: session is not None), within=10)
    assert session is not None
    return session


async def ready_owing(session: SemiontSession[Transport], *, a_save: bool) -> None:
    """Until `session` is ready, its client then owing a save, still waiting out its debounce, or owing nothing.

    Ready once the gateway has named the person: what the client holds is kept
    for her from then on. The save is a read of the entity types, which the
    client keeps; on a loop whose clock does not move (`aio.run_still`), its
    debounce never ends, so the client's close is the first to make it.
    """
    await soon(session.ready())
    client = session.client
    if a_save:
        await soon(client.browse.entity_types().fresh())
    assert client.persistence_settled is not a_save
