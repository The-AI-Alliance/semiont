"""What a client keeps of one person, and when it is read, written and deleted (`protocol/specs/src/session/persisted-cases.json`).

`keys`: the key of every persisted query, and of the stream's places, made of
a knowledge base and a person. `forget`: what forgetting a saved sign-in
deletes. A registry's sign-out, removal and new sign-in close a session of the
active knowledge base that is a stand-in whose closing writes under the
person's `resource` key when its sign-in names them, as a client closing with
a save owed could; an expiry and a refusal are those of the registry's own
session, of its HTTP factory, over a scripted gateway and issuer. `startup`: a
session of the registry's HTTP factory, over a scripted gateway that names the
person, or cannot be reached, only once the test lets it answer. `crossTab`: a
registry's session whose stored sign-in another context deletes or replaces
before the client has written what it holds. `holder`: a script's session over
a memory sign-in, keeping in a storage of its own, whose sign-in is forgotten,
replaced or renewed through the memory sign-in before the client has written
what it holds.
"""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from typing import Final, final, override

import pytest
from aio import run, soon
from gateway_server import Answer, GatewayServer
from issuer import ME, REFUSED, TOKEN, says, trusting
from pydantic import JsonValue, TypeAdapter
from spec import SPEC, JsonObject, objects, read, text
from tokens import expired, token

from semiont.cache import CacheState, Pending, Ready
from semiont.http.session import HttpSessionFactory, session_from_kept
from semiont.identifiers import ResourceId
from semiont.registry import (
    SemiontBrowser,
    SemiontBrowserConfig,
    SessionFactory,
    SessionFactoryOptions,
    kept_in,
    save_knowledge_bases,
    store_session,
    stored_session,
)
from semiont.session import HeldSignIn, MemorySignIn, SemiontSession
from semiont.session_signals import SessionSignals
from semiont.storage import MemoryStorage, SessionStorage
from semiont.stored import ACTIVE_KEY, KEPT_QUERIES, StoredSession, cache_key, last_event_id_key, person_key, session_key
from semiont.testing import FaultyTransport, ScriptedSessions, SharedStorage
from semiont.types import HttpEndpoint, KnowledgeBase, ResourceDescriptor, UserResponse
from semiont.watched import reached

_JSON: Final = TypeAdapter[JsonValue](JsonValue)

TABLE = read(SPEC / "session/persisted-cases.json")
STORED = read(SPEC / "session/stored.json")
KB: Final = "kb-a"


def object_of(value: JsonValue, what: str) -> JsonObject:
    """`value`, which is a JSON object."""
    assert isinstance(value, dict), f"{what} is not an object"
    return value


def texts(value: JsonValue, what: str) -> dict[str, str]:
    """`value`, which is an object whose every member is text, in the order it states them."""
    return {name: text(member, f"{what}'s {name}") for name, member in object_of(value, what).items()}


def why(row: JsonObject) -> str:
    return text(row["why"], "why")


PEOPLE = object_of(TABLE["people"], "people")
JO: Final = text(object_of(PEOPLE["jo"], "jo")["personKey"], "jo's key")
KEYS = objects(TABLE["keys"], "keys")
FORGET = objects(TABLE["forget"], "forget")
FORGET_STORAGE = texts(TABLE["forgetStorage"], "forgetStorage")
STARTUP = objects(TABLE["startup"], "startup")
STARTUP_STORAGE = texts(TABLE["startupStorage"], "startupStorage")
WHO_AM_I = object_of(TABLE["whoAmI"], "whoAmI")
CROSS_TAB = objects(TABLE["crossTab"], "crossTab")
HOLDER = objects(TABLE["holder"], "holder")
PREFIXES: Final = tuple(text(object_of(STORED[member], member)["prefix"], member) for member in ("lastEventIdKeyPrefix", "cacheKeyPrefix"))
"""What every key a client keeps of a person begins with."""


def kept_of(kb_id: str, person: str) -> set[str]:
    """Every key of a person on a knowledge base: the stream's, and every kept query's."""
    return {last_event_id_key(kb_id, person), *(cache_key(kb_id, person, query) for query in KEPT_QUERIES)}


def signed_in(person: str | None, n: int = 1) -> StoredSession:
    """A stored sign-in whose token is good for an hour, told from another by `n`, naming `person`, or nobody."""
    return StoredSession(
        access=token(3600, n),
        refresh=f"refresh-{n}",
        client_id="semiont-browser",
        token_endpoint="https://issuer.test/token",
        person_key=person,
    )


# ── keys ────────────────────────────────────────────────────────────────


def test_each_person_s_key_is_the_one_the_table_gives_their_did() -> None:
    assert len(PEOPLE) >= 2
    for name, entry in PEOPLE.items():
        person = object_of(entry, name)
        assert person_key(text(person["did"], f"{name}'s did")) == text(person["personKey"], f"{name}'s key"), name


@pytest.mark.parametrize("row", KEYS, ids=why)
def test_the_keys_of_a_knowledge_base_and_a_person_are_the_tables(row: JsonObject) -> None:
    kb_id, person = text(row["kbId"], "kbId"), text(row["personKey"], "personKey")
    assert person_key(text(row["did"], "did")) == person
    assert last_event_id_key(kb_id, person) == text(row["lastEventIdKey"], "lastEventIdKey")
    cache_keys = texts(row["cacheKeys"], "cacheKeys")
    # The queries kept are exactly those, in the order the refresh table lists them.
    assert list(KEPT_QUERIES) == list(cache_keys)
    assert {query: cache_key(kb_id, person, query) for query in KEPT_QUERIES} == cache_keys


# ── forget ──────────────────────────────────────────────────────────────

CLOSING_WRITE: Final = '{"version":1,"writtenAt":1700000000001,"entries":[]}'
"""What a stand-in session of kb-a writes under jo's `resource` key as it closes."""


def jo() -> UserResponse:
    return UserResponse.model_validate(WHO_AM_I)


@final
class ClosingWrites(SessionFactory):
    """Scripted sessions, each of which, when it is kb-a's on a sign-in naming jo, writes under jo's `resource` key once it has closed.

    As a client kept for jo closing with a save owed could: what a sign-out, a
    removal or a new sign-in deletes is deleted after that. A session built on
    a sign-in that names nobody keeps nothing, as a client does.
    """

    def __init__(self) -> None:
        self._sessions: Final = ScriptedSessions()
        self._sessions.says_who(jo())

    @override
    @asynccontextmanager
    async def session(self, options: SessionFactoryOptions) -> AsyncGenerator[SemiontSession[FaultyTransport]]:
        stored = stored_session(options.storage, options.kb.id)
        keeps_for_jo = options.kb.id == KB and stored is not None and stored.person_key == JO
        try:
            async with self._sessions.session(options) as session:
                yield session
        finally:
            if keeps_for_jo:
                options.storage.set(cache_key(KB, JO, "resource"), CLOSING_WRITE)

    @override
    async def revoke(self, stored: StoredSession) -> None:
        await self._sessions.revoke(stored)


def registered_at(kb_id: str, port: int) -> KnowledgeBase:
    return KnowledgeBase(
        id=kb_id,
        label=kb_id,
        did=f"did:web:example.org:{kb_id}",
        endpoint=HttpEndpoint(kind="http", host="localhost", port=port, protocol="http"),
    )


def holding_forget_storage() -> MemoryStorage:
    """A storage that holds every key of `forgetStorage`."""
    storage = MemoryStorage()
    for key, value in FORGET_STORAGE.items():
        storage.set(key, value)
    return storage


def sign_in_of(row: JsonObject, sign_in: Callable[[str | None], StoredSession]) -> StoredSession | None:
    """kb-a's stored sign-in as the row states it, made by `sign_in` for the person it names: none for `none`."""
    match row["signedIn"]:
        case "named":
            return sign_in(JO)
        case "unnamed":
            return sign_in(None)
        case "none":
            return None
        case other:
            raise AssertionError(f"a stored sign-in the table does not state: {other}")


async def forgotten_by_the_registry(row: JsonObject, new: StoredSession) -> SessionStorage:
    """What storage holds once the registry has signed out of kb-a, removed it, or signed in to it again with `new`, and has closed.

    kb-a is registered in every row, and active when the row says it is open.
    """
    storage = holding_forget_storage()
    save_knowledge_bases(storage, [registered_at(KB, 4000), registered_at("kb-b", 4001)])
    stored = sign_in_of(row, signed_in)
    if stored is not None:
        store_session(storage, KB, stored)
    active = KB if row["open"] is True else "kb-b"
    storage.set(ACTIVE_KEY, active)

    async with SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=ClosingWrites())) as browser:
        session = await soon(reached(browser.active_session, lambda session: session is not None))
        assert session is not None
        assert session.kb.id == active
        match row["by"]:
            case "signOut":
                await soon(browser.sign_out(KB))
            case "removal":
                await soon(browser.remove_kb(KB))
            case "signIn":
                await soon(browser.sign_in(KB, new))
            case other:
                raise AssertionError(f"a way the registry forgets the table does not state: {other}")
    return storage


async def forgotten_by_the_session(row: JsonObject) -> SessionStorage:
    """What storage holds once kb-a's own session, the registry's, has ended as the row says, and the registry has closed."""
    async with GatewayServer() as gateway:
        trusting(gateway)
        gateway.answers[ME] = WHO_AM_I
        match row["stored"]:
            case "expired":
                access = expired()
            case "unexpired":
                access = token(3600, 1)
            case other:
                raise AssertionError(f"a stored token the table does not state: {other}")
        match row["by"], row["stored"]:
            case "expiry", "expired":
                # Renewed before the gateway is asked, and refused.
                gateway.scripted[("POST", TOKEN)] = [says({"error": "invalid_grant"}, 400)]
                ended = None
            case "expiry", _:
                # Renewed once the gateway refuses it, and refused.
                gateway.scripted[("GET", ME)] = [REFUSED]
                gateway.scripted[("POST", TOKEN)] = [says({"error": "invalid_grant"}, 400)]
                ended = "expired"
            case "refusal", _:
                # Renewed once the gateway refuses it, and the renewed token refused too.
                gateway.scripted[("GET", ME)] = [REFUSED, REFUSED]
                renewed: JsonObject = {"access_token": token(3600, 2), "refresh_token": "r2", "token_type": "Bearer", "expires_in": 3600}
                gateway.scripted[("POST", TOKEN)] = [says(renewed)]
                ended = "refused"
            case way:
                raise AssertionError(f"a way of forgetting the table does not state: {way}")
        storage = holding_forget_storage()
        save_knowledge_bases(storage, [registered(gateway)])
        stored = sign_in_of(
            row,
            lambda person: StoredSession(
                access=access,
                refresh="r1",
                client_id="semiont-browser",
                token_endpoint=f"{gateway.origin}{TOKEN}",
                person_key=person,
            ),
        )
        if stored is not None:
            store_session(storage, KB, stored)

        async with SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=HttpSessionFactory())) as browser:
            session = await soon(reached(browser.active_session, lambda session: session is not None), within=10)
            assert session is not None
            # Ended as the row says, with its client still open.
            signals = browser.active_signals.value
            assert signals is not None
            said = signals.session_ended.value
            assert (None if said is None else said.reason) == ended
            assert len(gateway.of("POST", TOKEN)) == 1
    return storage


@pytest.mark.parametrize("row", FORGET, ids=why)
def test_forgetting_a_saved_sign_in_deletes_what_the_table_says(row: JsonObject) -> None:
    assert row["removes"] in ("person", "nothing")
    removed = kept_of(KB, JO) if row["removes"] == "person" else set[str]()
    assert removed <= set(FORGET_STORAGE)
    # A new sign-in, with other tokens, naming nobody until its gateway names them.
    new = signed_in(None, 2)
    match row["by"]:
        case "signOut" | "removal" | "signIn":
            storage = run(forgotten_by_the_registry(row, new))
        case "expiry" | "refusal":
            storage = run(forgotten_by_the_session(row))
        case other:
            raise AssertionError(f"a way of forgetting the table does not state: {other}")

    # Looked at once kb-a's client has closed. After a new sign-in, it is the one stored.
    assert stored_session(storage, KB) == (new if row["by"] == "signIn" else None)
    assert {key: storage.get(key) for key in FORGET_STORAGE} == {
        key: None if key in removed else value for key, value in FORGET_STORAGE.items()
    }


# ── startup ─────────────────────────────────────────────────────────────


@final
class Held(SessionStorage):
    """A storage in memory whose every key a test reads. No other context writes it."""

    def __init__(self, held: Mapping[str, str]) -> None:
        self.held: Final[dict[str, str]] = dict(held)

    @override
    def get(self, key: str) -> str | None:
        return self.held.get(key)

    @override
    def set(self, key: str, value: str) -> None:
        self.held[key] = value

    @override
    def delete(self, key: str) -> None:
        self.held.pop(key, None)

    @override
    def update(self, key: str, change: Callable[[str | None], str | None]) -> None:
        after = change(self.held.get(key))
        if after is None:
            self.held.pop(key, None)
        else:
            self.held[key] = after

    @override
    def subscribe(self, on_change: Callable[[str, str | None], None]) -> Callable[[], None] | None:
        return None


def described(resource: str, name: str) -> JsonObject:
    return {"@context": "https://schema.org/", "@id": resource, "name": name, "representations": []}


def answers_fresh(gateway: GatewayServer) -> None:
    """Have the gateway answer a read of any resource with that resource named `fresh`."""

    def answer(emit: JsonObject) -> None:
        payload = emit.get("payload")
        if emit.get("channel") != "browse:resource-requested" or not isinstance(payload, dict):
            return
        resource = described(text(payload["resourceId"], "a resource's id"), "fresh")
        said: JsonObject = {"response": {"resource": resource, "lastSequence": 1}}
        gateway.send(None, {"channel": "browse:resource-result", "payload": said, "correlationId": emit["correlationId"]})

    gateway.on_emit = answer


def registered(gateway: GatewayServer) -> KnowledgeBase:
    endpoint = gateway.target(KB).endpoint
    assert isinstance(endpoint, HttpEndpoint)
    return KnowledgeBase(id=KB, label="KB A", did="did:web:example.org:kb-a", endpoint=endpoint)


async def shown(live: AsyncIterator[CacheState[ResourceDescriptor]]) -> str:
    """The name of the first value a watcher is shown: `kept`, what the storage kept, or `fresh`, the gateway's answer."""
    async for state in live:
        if isinstance(state, Ready):
            return state.value.name
        assert isinstance(state, Pending), f"a read of a resource failed: {state}"
    raise AssertionError("the watcher was shown no value")


async def resumed_from(gateway: GatewayServer, scope: str) -> JsonValue:
    """Where the first subscription that names `scope` asks it to begin: none for the present."""
    while True:
        for subscription in gateway.subscriptions:
            scoped = subscription.get("scoped")
            if isinstance(scoped, list):
                for entry in scoped:
                    if isinstance(entry, dict) and entry.get("scope") == scope:
                        return entry.get("lastEventId")
        await asyncio.sleep(0.005)


def recorded(storage: SessionStorage) -> JsonValue:
    """The person's key kb-a's stored sign-in holds, as the storage holds it: none for none."""
    stored = storage.get(session_key(KB))
    assert stored is not None, "kb-a's sign-in is not stored"
    return object_of(_JSON.validate_json(stored), "a stored sign-in").get("personKey")


@pytest.mark.parametrize("row", STARTUP, ids=why)
def test_a_registrys_session_reads_and_records_what_the_table_says(row: JsonObject) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            answers_fresh(gateway)
            answering = asyncio.Event()
            match row["gateway"]:
                case "names":
                    # The first ask is answered when the test says; any after it names the same person.
                    gateway.answers[ME] = WHO_AM_I
                    gateway.scripted[("GET", ME)] = [Answer(body=_JSON.dump_json(WHO_AM_I), after=answering)]
                case "unreachable":
                    # The ask and its one retry get no answer, and an ask after them finds nobody.
                    del gateway.answers[ME]
                    gateway.scripted[("GET", ME)] = [Answer(hang_up=True, after=answering)] * 2
                case other:
                    raise AssertionError(f"a gateway the table does not state: {other}")
            storage = Held(STARTUP_STORAGE)
            match row["signedIn"]:
                case "named":
                    store_session(storage, KB, signed_in(JO))
                case "unnamed":
                    store_session(storage, KB, signed_in(None))
                case other:
                    raise AssertionError(f"a stored sign-in the table does not state at startup: {other}")
            options = SessionFactoryOptions(kb=registered(gateway), storage=storage, signals=SessionSignals(), on_error=lambda _: None)

            async with HttpSessionFactory().session(options) as session:
                client = session.client
                await soon(reached(client.transport.state, lambda state: state == "open"))
                await soon(gateway.arrived("GET", ME))
                # Asked while the gateway has not said who the token is.
                async with client.browse.resource(ResourceId("res-2")) as live:
                    assert await soon(shown(live)) == row["first"]

                answering.set()
                await soon(session.ready())
                assert recorded(storage) == row["recorded"]
                # Asked after, of a scope the stream has not held before.
                async with client.browse.resource(ResourceId("res-1")) as live:
                    assert await soon(shown(live)) == row["then"]
                    assert await soon(resumed_from(gateway, "res-1")) == row["place"]

            if "untouched" in row:
                kept = {key: value for key, value in storage.held.items() if key.startswith(PREFIXES)}
                assert (kept == STARTUP_STORAGE) is row["untouched"]

    run(scenario())


# ── crossTab ────────────────────────────────────────────────────────────


def saved(storage: SessionStorage) -> bool:
    """Whether jo's `resource` key holds res-1 as the client held it."""
    kept = storage.get(cache_key(KB, JO, "resource"))
    if kept is None:
        return False
    entries = object_of(_JSON.validate_json(kept), "a kept document")["entries"]
    assert isinstance(entries, list)
    return any(isinstance(entry, list) and entry[:2] == ["res-1", described("res-1", "fresh")] for entry in entries)


@pytest.mark.parametrize("row", CROSS_TAB, ids=why)
def test_a_session_whose_stored_sign_in_another_context_changes_writes_what_the_table_says(row: JsonObject) -> None:
    async def scenario() -> bool:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.answers[ME] = WHO_AM_I
            answers_fresh(gateway)
            storage = SharedStorage()
            elsewhere = storage.context()
            save_knowledge_bases(storage, [registered(gateway)])
            store_session(storage, KB, signed_in(JO))

            async with SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=HttpSessionFactory())) as browser:
                session = await soon(reached(browser.active_session, lambda session: session is not None), within=10)
                assert session is not None
                client = session.client
                assert (await soon(client.browse.resource(ResourceId("res-1")).fresh())).name == "fresh"
                # Held, and not yet written.
                assert not client.persistence_settled

                stored = row["stored"]
                if stored is None:
                    elsewhere.delete(session_key(KB))
                else:
                    person = object_of(stored, "stored")["personKey"]
                    assert person is None or isinstance(person, str)
                    if person == JO:
                        # Renewed in the other context: other tokens, the same person.
                        there = kept_in(elsewhere, KB)
                        read = await there.held()
                        assert read is not None
                        renewed = signed_in(JO, 2)
                        assert await there.renewed(read, renewed.access, renewed.refresh) == renewed.access
                    else:
                        store_session(elsewhere, KB, signed_in(person, 2))
            return saved(storage)

    assert run(scenario()) is row["saved"]


# ── holder ──────────────────────────────────────────────────────────────


def held_by(gateway: GatewayServer, person: str | None, n: int) -> HeldSignIn:
    """A sign-in whose token is good for an hour, told from another by `n`, naming `person`, or nobody."""
    return HeldSignIn(
        access=token(3600, n),
        refresh=f"refresh-{n}",
        client_id="semiont-browser",
        token_endpoint=f"{gateway.origin}{TOKEN}",
        person_key=person,
    )


@pytest.mark.parametrize("row", HOLDER, ids=why)
def test_a_session_whose_sign_in_what_holds_it_changes_writes_what_the_table_says(row: JsonObject) -> None:
    async def scenario() -> bool:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.answers[ME] = WHO_AM_I
            answers_fresh(gateway)
            # The client keeps in a storage of its own; the sign-in is held apart from it, in memory.
            storage = MemoryStorage()
            read = held_by(gateway, JO, 1)
            kept = MemorySignIn(read)

            async with session_from_kept(gateway.target(KB), kept=kept, storage=storage) as session:
                client = session.client
                assert (await soon(client.browse.resource(ResourceId("res-1")).fresh())).name == "fresh"
                # Held, and not yet written.
                assert not client.persistence_settled

                stored = row["stored"]
                if stored is None:
                    await kept.forget()
                else:
                    person = object_of(stored, "stored")["personKey"]
                    assert person is None or isinstance(person, str)
                    if person == JO:
                        renewed = held_by(gateway, JO, 2)
                        assert await kept.renewed(read, renewed.access, renewed.refresh) == renewed.access
                    else:
                        await kept.keep(held_by(gateway, person, 2))
            return saved(storage)

    assert run(scenario()) is row["saved"]


def test_the_table_was_read() -> None:
    assert len(KEYS) >= 2
    assert len(FORGET) >= 14
    assert len(STARTUP) >= 3
    assert len(CROSS_TAB) >= 4
    assert len(HOLDER) >= 4
