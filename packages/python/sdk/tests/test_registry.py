"""The registry of knowledge bases an application holds (`semiont.registry`).

The list, the active one and its session, a sign-in landing on the entry for
the knowledge base that answered, what is open in each, what a session's
arrival checks, what its transport fails at, and how a registry ends; and
what it keeps in its storage.

Sessions are built by `semiont.testing.ScriptedSessions`, each over a
scripted transport: a test says what each knowledge base answers when asked
who it is and what of each resource, and reads what was asked. The storage is
a `SharedStorage`, so a second context can write it as another window would.
"""

import asyncio
import dataclasses
import json
from collections.abc import Mapping
from typing import Final, final

import pytest
from aio import hurried, run, soon, turns
from pydantic import JsonValue
from spec import JsonObject
from tokens import expired, token

from semiont.errors import TransportError
from semiont.identifiers import ResourceId
from semiont.registry import (
    Expected,
    KbReadVerdict,
    OpenResource,
    SemiontBrowser,
    SemiontBrowserConfig,
    SignedIn,
    TabCheck,
    apply_tab_checks,
    kept_in,
    load_knowledge_bases,
    save_knowledge_bases,
    sort_open_resources,
    store_session,
    stored_session,
)
from semiont.session import HeldSignIn, SemiontSession
from semiont.session_signals import KbIdentityConflict, PermissionDenied, SessionEnded, SessionSignals
from semiont.storage import MemoryStorage, SessionStorage
from semiont.stored import (
    ACTIVE_KEY,
    KNOWLEDGE_BASES_KEY,
    LAST_VIEWED_RESOURCE_BY_KB_KEY,
    OPEN_RESOURCES_BY_KB_KEY,
    StoredSession,
    kb_of_session_key,
    session_key,
)
from semiont.testing import FaultyTransport, ScriptedSessions, SharedStorage
from semiont.transport import Transport
from semiont.types import HttpEndpoint, KbDescription, KbRead, KnowledgeBase, NewKnowledgeBase, UserResponse
from semiont.watched import Watched, reached

KB_A: Final = "kb-a"
KB_B: Final = "kb-b"
DID_A: Final = "did:web:example.org:kb-a"
DID_B: Final = "did:web:example.org:kb-b"

KB_REQUESTED: Final = "browse:kb-requested"
RESOURCE_REQUESTED: Final = "browse:resource-requested"


# ── The knowledge bases behind the factory ──────────────────────────────


def alice() -> UserResponse:
    return UserResponse.model_validate(
        {"did": "did:web:example.org:users:alice", "email": "alice@example.org", "name": "Alice", "image": None, "domain": "example.org"}
    )


def resource_of(payload: Mapping[str, JsonValue]) -> str:
    asked = payload.get("resourceId")
    assert isinstance(asked, str), f"a request names no resource: {payload}"
    return asked


@final
class Behind:
    """What the knowledge bases behind the factory say of themselves and of each resource."""

    def __init__(self) -> None:
        self.describes: dict[str, JsonObject] = {}
        """What each knowledge base says when it is asked who it is, by its id. One with none does not answer at all."""
        self.refusing: set[str] = set()
        """The knowledge bases that answer that they cannot say what they are."""
        self.gone: set[str] = set()
        """The resources the knowledge base says do not exist."""
        self.failing: set[str] = set()
        """The resources whose read fails some other way."""
        self.media_types: dict[str, str] = {}

    def answer(self, kb_id: str, operation: str, payload: Mapping[str, JsonValue]) -> JsonValue | None:
        if operation == KB_REQUESTED:
            said = self.describes.get(kb_id)
            if said is None or kb_id in self.refusing:
                raise TransportError("error", "the knowledge base does not answer")
            return said
        if operation == RESOURCE_REQUESTED:
            resource = resource_of(payload)
            if resource in self.failing:
                raise TransportError("error", f"{resource} could not be read")
            representations: list[JsonValue] = [{"mediaType": self.media_types[resource]}] if resource in self.media_types else []
            described: JsonObject = {
                "@context": "https://schema.org",
                "@id": resource,
                "name": f"name-{resource}",
                "representations": representations,
            }
            return {"resource": described, "lastSequence": 1}
        raise TransportError("error", f"{operation} is not answered here")

    def refuse(self, kb_id: str, operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        if operation == KB_REQUESTED and kb_id in self.refusing:
            return {"message": "this knowledge base cannot say what it is"}
        if operation == RESOURCE_REQUESTED and resource_of(payload) in self.gone:
            return {"code": "not-found", "message": "no such resource"}
        return None


@final
class Factory:
    """Scripted sessions, and what their knowledge bases say of themselves and of each resource."""

    def __init__(self) -> None:
        self.behind = Behind()
        self.sessions = ScriptedSessions(answer=self.behind.answer)
        self.sessions.refuse_when(self.behind.refuse)
        self.sessions.says_who(alice())

    def says(self, kb_id: str, said: JsonObject) -> None:
        self.behind.describes[kb_id] = said

    def asked_about(self, kb_id: str) -> list[str]:
        """The resources a knowledge base's sessions were asked about, in order."""
        return [
            resource_of(entry.payload)
            for transport in self.sessions.transports(kb_id)
            for entry in transport.request_log
            if entry.channel == RESOURCE_REQUESTED
        ]

    def asked_who(self, kb_id: str) -> int:
        """How often a knowledge base's sessions asked it who it is."""
        return sum(1 for transport in self.sessions.transports(kb_id) for entry in transport.request_log if entry.channel == KB_REQUESTED)


# ── Helpers ─────────────────────────────────────────────────────────────


def endpoint(host: str, port: int) -> HttpEndpoint:
    return HttpEndpoint(kind="http", host=host, port=port, protocol="http" if host in ("localhost", "127.0.0.1") else "https")


def kb(kb_id: str, label: str, did: str, at: HttpEndpoint, last_read: KbRead | None = None) -> KnowledgeBase:
    return KnowledgeBase(id=kb_id, label=label, did=did, endpoint=at, last_read=last_read)


def kb_of_a() -> KnowledgeBase:
    return kb(KB_A, "KB A", DID_A, endpoint("localhost", 4000))


def kb_of_b() -> KnowledgeBase:
    return kb(KB_B, "KB B", DID_B, endpoint("example.com", 443))


def tokens(refresh: str) -> StoredSession:
    return StoredSession(
        access=token(3600, 1),
        refresh=refresh,
        client_id="semiont-browser",
        token_endpoint="https://issuer.test/token",
        revocation_endpoint="https://issuer.test/revoke",
    )


def description(name: str, domain: str, branch: str | None = None) -> JsonObject:
    said: JsonObject = {"name": name, "domain": domain}
    if branch is not None:
        said["gitBranch"] = branch
    return said


@final
class World:
    """A storage and a factory, and the registries over them."""

    def __init__(self) -> None:
        self.storage = SharedStorage()
        self.factory = Factory()

    def with_(self, *kbs: KnowledgeBase) -> "World":
        """A storage that already holds these knowledge bases, signed in, with the first of them active."""
        save_knowledge_bases(self.storage, kbs)
        for each in kbs:
            store_session(self.storage, each.id, tokens("r"))
        if kbs:
            self.storage.set(ACTIVE_KEY, kbs[0].id)
        return self

    def browser(self, storage: SessionStorage | None = None) -> SemiontBrowser:
        """A registry over `storage`, or this world's."""
        return SemiontBrowser(
            SemiontBrowserConfig(storage=self.storage if storage is None else storage, session_factory=self.factory.sessions)
        )

    def stored(self, key: str) -> JsonValue:
        stored = self.storage.get(key)
        return None if stored is None else json.loads(stored)

    def stored_open(self, kb_id: str) -> list[str]:
        by_kb = self.stored(OPEN_RESOURCES_BY_KB_KEY)
        if not isinstance(by_kb, dict):
            return []
        tabs = by_kb.get(kb_id)
        assert tabs is None or isinstance(tabs, list)
        return [str(tab["id"]) for tab in tabs or [] if isinstance(tab, dict)]

    def stored_last_viewed(self) -> JsonValue:
        return self.stored(LAST_VIEWED_RESOURCE_BY_KB_KEY) or {}

    def stored_refresh(self, kb_id: str) -> str | None:
        stored = stored_session(self.storage, kb_id)
        return None if stored is None else stored.refresh

    def opened(self, kb_id: str, *ids: str) -> None:
        """Store `ids` as open in a knowledge base, each under a stale name."""
        by_kb = self.stored(OPEN_RESOURCES_BY_KB_KEY)
        written: JsonObject = by_kb if isinstance(by_kb, dict) else {}
        written[kb_id] = [{"id": each, "name": f"stale-{each}", "openedAt": place, "order": place} for place, each in enumerate(ids)]
        self.storage.set(OPEN_RESOURCES_BY_KB_KEY, json.dumps(written))


async def settle() -> None:
    """Let what is ready run, and what that makes ready."""
    await turns(200)


async def live(browser: SemiontBrowser) -> SemiontSession[Transport]:
    """The registry's live session, once it has one, with what its arrival starts let run: who it is, and what is open."""
    session = await soon(reached(browser.active_session, lambda session: session is not None))
    assert session is not None
    await settle()
    return session


# Each read of what a registry shows is a call, so a checker narrows no
# reading of it across the awaits that change it.


def kbs_of(browser: SemiontBrowser) -> tuple[KnowledgeBase, ...]:
    return browser.kbs.value


def active_of(browser: SemiontBrowser) -> str | None:
    return browser.active_kb_id.value


def activating(browser: SemiontBrowser) -> bool:
    return browser.session_activating.value


def signals_of(browser: SemiontBrowser) -> SessionSignals | None:
    return browser.active_signals.value


def viewed(browser: SemiontBrowser) -> ResourceId | None:
    return browser.last_viewed_resource.value


def identity_of(browser: SemiontBrowser) -> str | None:
    return browser.identity_token.value


def session_of(browser: SemiontBrowser) -> str | None:
    session = browser.active_session.value
    return None if session is None else session.kb.id


def shown(browser: SemiontBrowser) -> list[str]:
    return [str(tab.id) for tab in browser.open_resources.value]


def closed(transport: FaultyTransport) -> bool:
    return transport.state.value == "closed"


def signed_in(at: HttpEndpoint, said: JsonObject, refresh: str) -> SignedIn:
    return SignedIn(endpoint=at, description=KbDescription.model_validate(said), session=tokens(refresh))


def conflict(browser: SemiontBrowser) -> KbIdentityConflict | None:
    signals = signals_of(browser)
    return None if signals is None else signals.kb_identity_conflict.value


def session_ended(browser: SemiontBrowser) -> SessionEnded | None:
    signals = signals_of(browser)
    return None if signals is None else signals.session_ended.value


def denied(browser: SemiontBrowser) -> PermissionDenied | None:
    signals = signals_of(browser)
    return None if signals is None else signals.permission_denied.value


async def ended[T](watched: Watched[T]) -> bool:
    """Whether a reader of something a registry showed sees no more: its changes end once it is given the value now."""
    seen = 0
    try:
        async with asyncio.timeout(1):
            async for _ in watched:
                seen += 1
    except TimeoutError:
        return False
    return seen == 1


async def watch_sessions(browser: SemiontBrowser, seen: list[str | None]) -> None:
    """Record the knowledge base of each session the registry shows, none for none."""
    async for session in browser.active_session:
        seen.append(None if session is None else session.kb.id)


async def stopped(task: asyncio.Task[None]) -> None:
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


# ── What it keeps ───────────────────────────────────────────────────────


def test_a_stored_value_that_lacks_a_member_of_a_session_is_none() -> None:
    storage = MemoryStorage()
    storage.set(session_key(KB_A), '{"access":"a","refresh":"r","tokenEndpoint":"https://issuer.test/token"}')
    assert stored_session(storage, KB_A) is None
    storage.set(session_key(KB_A), '{"access":"a","refresh":"r","clientId":"semiont-browser","tokenEndpoint":"https://issuer.test/token"}')
    read = stored_session(storage, KB_A)
    assert read is not None
    assert read.revocation_endpoint is None


def test_a_session_key_names_its_knowledge_base() -> None:
    assert kb_of_session_key(session_key(KB_A)) == KB_A
    assert kb_of_session_key(ACTIVE_KEY) is None


def test_a_renewal_is_kept_against_what_is_stored_then() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        kept = kept_in(storage, KB_A)
        read = HeldSignIn(access="a1", refresh="r1", client_id="semiont-browser", token_endpoint="https://issuer.test/token")

        # A renewal of nothing stored is not kept, and writes nothing.
        assert await kept.renewed(read, "a2", "r2") is None
        assert stored_session(storage, KB_A) is None

        await kept.keep(read)
        assert await kept.renewed(read, "a2", "r2") == "a2"
        held = await kept.held()
        assert held is not None
        assert (held.access, held.refresh) == ("a2", "r2")

        # Renewed from what was read before: the renewal stored meanwhile stands.
        assert await kept.renewed(read, "a3", "r3") == "a2"
        held = await kept.held()
        assert held is not None
        assert held.access == "a2"

        await kept.forget()
        assert await kept.held() is None

    run(scenario())


# ── What is open, as a list ─────────────────────────────────────────────


def tab(named: str, opened_at: int, order: int) -> OpenResource:
    return OpenResource(id=ResourceId(named), name=f"name of {named}", opened_at=opened_at, order=order, media_type="text/plain")


def test_they_are_ordered_by_place_and_then_by_when_they_were_opened() -> None:
    ordered = sort_open_resources([tab("b", 20, 1), tab("a", 30, 0), tab("d", 15, 1), tab("c", 10, 2)])
    assert [str(each.id) for each in ordered] == ["a", "d", "b", "c"]


def test_only_a_resource_the_knowledge_base_says_is_gone_is_dropped() -> None:
    checks = {
        ResourceId("gone"): TabCheck(verdict="gone"),
        ResourceId("found"): TabCheck(verdict="ready", name="Its name now"),
        ResourceId("unknown"): TabCheck(verdict="unknown"),
    }
    kept = apply_tab_checks([tab("gone", 1, 0), tab("found", 2, 1), tab("unknown", 3, 2), tab("opened-meanwhile", 4, 3)], checks)
    assert [str(each.id) for each in kept] == ["found", "unknown", "opened-meanwhile"]
    assert kept[0].name == "Its name now"
    # A check that states no media type leaves the one it had.
    assert kept[0].media_type == "text/plain"
    assert kept[1].name == "name of unknown"


# ── The knowledge bases ─────────────────────────────────────────────────


def test_a_knowledge_base_that_is_added_is_kept_signed_in_and_made_active() -> None:
    async def scenario() -> None:
        world = World()
        read = KbRead(at="2027-01-15T08:00:00.000Z", git_branch="main")
        async with world.browser() as browser:
            assert kbs_of(browser) == ()
            assert active_of(browser) is None
            added = await browser.add_kb(
                NewKnowledgeBase(label="KB A", did=DID_A, endpoint=endpoint("localhost", 4000), last_read=read), tokens("r")
            )

            assert kbs_of(browser) == (added,)
            assert active_of(browser) == added.id
            assert session_of(browser) == added.id
            assert world.storage.get(ACTIVE_KEY) == added.id
            assert stored_session(world.storage, added.id) is not None

        # Its identity and what it last said survive a new registry on the storage.
        async with world.browser() as reopened:
            kbs = reopened.kbs.value
            assert kbs == (added,)
            assert kbs[0].did == DID_A
            assert kbs[0].last_read == read
            assert (await live(reopened)).kb.id == added.id

    run(scenario())


def test_an_entry_that_is_not_a_knowledge_base_with_a_did_is_dropped_from_the_storage_too() -> None:
    async def scenario() -> None:
        world = World()
        world.storage.set(
            KNOWLEDGE_BASES_KEY,
            """[
                {"id":"old","label":"No did","endpoint":{"kind":"http","host":"localhost","port":4000,"protocol":"http"}},
                {"id":"kb-a","label":"KB A","did":"did:web:example.org:kb-a","email":"someone@example.org",
                 "endpoint":{"kind":"http","host":"localhost","port":4000,"protocol":"http"}},
                "not an entry"
            ]""",
        )
        world.storage.set(ACTIVE_KEY, "old")
        async with world.browser() as browser:
            assert kbs_of(browser) == (kb_of_a(),)
            # The active one was the one dropped: the first that is left takes over.
            assert active_of(browser) == KB_A
            # What is written back is what was read, and nothing else an entry carried.
            assert world.stored(KNOWLEDGE_BASES_KEY) == [
                {
                    "id": "kb-a",
                    "label": "KB A",
                    "did": "did:web:example.org:kb-a",
                    "endpoint": {"kind": "http", "host": "localhost", "port": 4000, "protocol": "http"},
                }
            ]

    run(scenario())


def test_removing_a_knowledge_base_forgets_it_and_the_next_one_takes_over() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a(), kb_of_b())
        async with world.browser() as browser:
            await live(browser)
            browser.add_open_resource(ResourceId("res-1"), "One")
            browser.set_last_viewed_resource(ResourceId("res-1"))
            assert world.stored_open(KB_A) == ["res-1"]

            await browser.remove_kb(KB_A)
            assert kbs_of(browser) == (kb_of_b(),)
            assert session_of(browser) == KB_B
            assert stored_session(world.storage, KB_A) is None
            assert world.stored_open(KB_A) == []
            last_viewed = world.stored_last_viewed()
            assert isinstance(last_viewed, dict)
            assert KB_A not in last_viewed
            assert closed(world.factory.sessions.transports(KB_A)[0])

            await browser.remove_kb(KB_B)
            assert kbs_of(browser) == ()
            assert active_of(browser) is None
            assert session_of(browser) is None
            assert world.storage.get(ACTIVE_KEY) is None

    run(scenario())


def test_an_entry_takes_what_its_knowledge_base_last_said_and_keeps_its_did() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a(), kb_of_b())
        async with world.browser() as browser:
            browser.update_kb(KB_B, label="Renamed", last_read=KbRead(at="2026-10-15T08:00:00.000Z"))

            kbs = kbs_of(browser)
            assert kbs[0] == kb_of_a()
            assert kbs[1].label == "Renamed"
            assert kbs[1].did == DID_B
            assert kbs[1].last_read is not None
            assert kbs[1].last_read.git_branch is None
            assert load_knowledge_bases(world.storage) == list(kbs)

    run(scenario())


def test_a_stored_credential_says_whether_it_is_good_expired_or_not_there() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a(), kb_of_b())
        store_session(world.storage, KB_B, tokens("r").model_copy(update={"access": expired()}))
        async with world.browser() as browser:
            assert browser.kb_session_status(KB_A) == "authenticated"
            assert browser.kb_session_status(KB_B) == "expired"
            assert browser.kb_session_status("another") == "signed-out"

    run(scenario())


def test_the_identity_token_is_what_it_was_last_set_to() -> None:
    async def scenario() -> None:
        async with World().browser() as browser:
            assert identity_of(browser) is None
            browser.set_identity_token("an-identity-token")
            assert identity_of(browser) == "an-identity-token"
            browser.set_identity_token(None)
            assert identity_of(browser) is None

    run(scenario())


# ── The active session ──────────────────────────────────────────────────


def test_making_another_knowledge_base_active_shows_no_session_and_then_the_new_one() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a(), kb_of_b())
        async with world.browser() as browser:
            await live(browser)
            # B's session takes a moment to come up: a reader that is behind is
            # given the latest value, and one that came up at once could be
            # given it before "no session".
            world.factory.sessions.answers_after(2.0)
            seen: list[str | None] = []
            watching = asyncio.create_task(watch_sessions(browser, seen))
            await turns()

            await hurried(browser.set_active_kb(KB_B))
            await settle()
            await stopped(watching)

            assert seen == [KB_A, None, KB_B]
            assert world.storage.get(ACTIVE_KEY) == KB_B
            # The session it replaced is closed, and its client with it.
            assert closed(world.factory.sessions.transports(KB_A)[0])
            assert not closed(world.factory.sessions.transports(KB_B)[0])

    run(scenario())


def test_making_none_active_closes_the_session_and_leaves_none() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        async with world.browser() as browser:
            await live(browser)

            await browser.set_active_kb(None)

            assert session_of(browser) is None
            assert active_of(browser) is None
            assert signals_of(browser) is None
            assert not activating(browser)
            assert closed(world.factory.sessions.transports(KB_A)[0])
            assert world.storage.get(ACTIVE_KEY) is None

    run(scenario())


def test_making_the_active_one_active_again_changes_nothing() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        async with world.browser() as browser:
            session = await live(browser)

            await browser.set_active_kb(KB_A)

            assert (await live(browser)).id == session.id
            assert len(world.factory.sessions.transports(KB_A)) == 1

    run(scenario())


def test_of_two_activations_asked_for_together_the_last_one_asked_for_stands() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a(), kb_of_b())
        async with world.browser() as browser:
            await live(browser)

            # Asked one after another, without waiting for any: what stands is the last one asked for.
            asked: list[asyncio.Task[None]] = []
            for kb_id in (KB_B, KB_A, KB_B):
                asked.append(asyncio.create_task(browser.set_active_kb(kb_id)))
                await turns()
            await soon(asyncio.gather(*asked))

            assert session_of(browser) == KB_B
            assert active_of(browser) == KB_B
            assert not activating(browser)
            # Every session but the one that stands is closed.
            running = [
                transport for kb_id in (KB_A, KB_B) for transport in world.factory.sessions.transports(kb_id) if not closed(transport)
            ]
            assert len(running) == 1

    run(scenario())


def test_an_activation_overtaken_while_it_waited_its_turn_builds_no_session() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a(), kb_of_b())
        async with world.browser() as browser:
            await live(browser)
            # The first activation holds the turn while its session comes up, and the other two are asked for behind it.
            world.factory.sessions.answers_after(2.0)

            asked: list[asyncio.Task[None]] = []
            for kb_id in (KB_B, KB_A, KB_B):
                asked.append(asyncio.create_task(browser.set_active_kb(kb_id)))
                await turns()
            await hurried(asyncio.gather(*asked))

            assert session_of(browser) == KB_B
            # A had the session it started with, and no other was built for it.
            assert len(world.factory.sessions.transports(KB_A)) == 1

    run(scenario())


def test_a_session_that_comes_up_after_its_knowledge_base_stopped_being_active_is_never_shown() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a(), kb_of_b())
        async with world.browser() as browser:
            await live(browser)
            world.factory.sessions.answers_after(2.0)

            # Every session shown after the first: the knowledge base that was active then, and the session's own.
            seen: list[tuple[str | None, str]] = []

            async def watch() -> None:
                changes = aiter(browser.active_session)
                await anext(changes)
                async for session in changes:
                    if session is not None:
                        seen.append((active_of(browser), session.kb.id))

            watching = asyncio.create_task(watch())
            await turns()

            to_b = asyncio.create_task(browser.set_active_kb(KB_B))
            # B's session is still coming up when A is asked for again.
            await settle()
            to_a = asyncio.create_task(browser.set_active_kb(KB_A))
            await hurried(asyncio.gather(to_b, to_a))
            await settle()
            await stopped(watching)

            assert seen == [(KB_A, KB_A)]
            # The session that came up too late was closed, and not left running.
            assert closed(world.factory.sessions.transports(KB_B)[0])

    run(scenario())


def test_a_session_being_brought_up_is_said_to_be_on_its_way() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        # A session that takes a moment to come up: one that is up at once is
        # up before anyone could be told it was coming.
        world.factory.sessions.answers_after(2.0)
        async with world.browser() as browser:
            await soon(reached(browser.session_activating, lambda activating: activating))
            assert session_of(browser) is None

            await hurried(reached(browser.active_session, lambda session: session is not None))
            await settle()
            assert not activating(browser)

    run(scenario())


def test_a_session_that_cannot_be_built_is_said_and_there_is_none() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        world.factory.sessions.refuse_to_build("this factory builds nothing")
        browser = world.browser()
        # Heard from before the registry begins its first activation.
        errors = browser.errors()
        async with browser:
            refused = await soon(anext(errors))
            await settle()

            assert refused.code == "session.construct-failed"
            assert refused.kb_id == KB_A
            assert session_of(browser) is None
            assert signals_of(browser) is None
            assert not activating(browser)

    run(scenario())


def test_what_a_host_shows_about_a_session_is_there_exactly_when_the_session_is() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        async with world.browser() as browser:
            assert signals_of(browser) is None

            await live(browser)
            first = signals_of(browser)
            assert first is not None
            assert first.session_ended.value is None

            # A sign-in on the active knowledge base replaces both together.
            await browser.sign_in(KB_A, tokens("r2"))
            await live(browser)
            second = signals_of(browser)
            assert second is not None
            assert second is not first
            assert await ended(first.session_ended)

            await browser.sign_out(KB_A)
            assert signals_of(browser) is None
            assert session_of(browser) is None

    run(scenario())


# ── Signing in ──────────────────────────────────────────────────────────


def test_new_tokens_for_the_active_knowledge_base_replace_its_session() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        async with world.browser() as browser:
            first = await live(browser)

            await browser.sign_in(KB_A, tokens("renewed"))
            second = await live(browser)

            assert first.id != second.id
            assert closed(world.factory.sessions.transports(KB_A)[0])
            assert world.stored_refresh(KB_A) == "renewed"

    run(scenario())


def test_a_sign_in_at_a_new_address_registers_the_knowledge_base_under_what_it_says_it_is() -> None:
    async def scenario() -> None:
        world = World()
        async with world.browser() as browser:
            outcome = await browser.signed_in(signed_in(endpoint("localhost", 4000), description("KB A", "example.org:kb-a", "main"), "r"))

            assert outcome.expected is None
            assert outcome.kb.did == DID_A
            assert outcome.kb.label == "KB A"
            assert outcome.kb.last_read is not None
            assert outcome.kb.last_read.git_branch == "main"
            assert kbs_of(browser) == (outcome.kb,)
            assert session_of(browser) == outcome.kb.id
            assert world.stored_refresh(outcome.kb.id) == "r"

    run(scenario())


def test_a_sign_in_reports_what_the_person_believed_they_clicked() -> None:
    async def scenario() -> None:
        async with World().browser() as browser:
            believed = signed_in(endpoint("localhost", 4000), description("KB A", "example.org:kb-a"), "r")
            outcome = await browser.signed_in(dataclasses.replace(believed, expected_did=DID_B, expected_name="KB B"))

            # The knowledge base that answered is the one registered. What was believed is said back, for a host to set against it.
            assert outcome.kb.did == DID_A
            assert outcome.expected == Expected(did=DID_B, name="KB B")

    run(scenario())


@pytest.mark.parametrize("by_id", [True, False])
def test_a_sign_in_to_a_registered_knowledge_base_takes_what_it_and_the_issuer_now_say(by_id: bool) -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        async with world.browser() as browser:
            first = await live(browser)
            again = signed_in(endpoint("localhost", 4000), description("KB A, renamed", "example.org:kb-a", "feature"), "r2")
            if by_id:
                again = dataclasses.replace(again, kb_id=KB_A)

            outcome = await browser.signed_in(again)

            # The same entry, under the name it gives itself now.
            assert outcome.kb.id == KB_A
            assert outcome.kb.label == "KB A, renamed"
            assert kbs_of(browser) == (outcome.kb,)
            # What was believed is the entry as it was, under the label it had.
            assert outcome.expected == Expected(did=DID_A, name="KB A")
            assert world.stored_refresh(KB_A) == "r2"
            assert (await live(browser)).id != first.id

    run(scenario())


def test_a_sign_in_a_different_knowledge_base_answers_leaves_the_entry_and_lands_on_a_new_one() -> None:
    async def scenario() -> None:
        believed = kb(KB_A, "KB A", DID_A, endpoint("localhost", 4000), KbRead(at="2027-01-15T08:00:00.000Z", git_branch="main"))
        world = World().with_(believed)
        before = stored_session(world.storage, KB_A)
        async with world.browser() as browser:
            await live(browser)
            landing = signed_in(endpoint("localhost", 4000), description("KB B", "example.org:kb-b", "other"), "for-b")

            outcome = await browser.signed_in(dataclasses.replace(landing, kb_id=KB_A))

            # The entry the person believed they were signing in to is as it
            # was: its did, its name, what it last said, and its credentials.
            kbs = kbs_of(browser)
            assert kbs[0] == believed
            assert stored_session(world.storage, KB_A) == before
            # The knowledge base that answered has an entry of its own, at the
            # same address, and it is the one signed in and active.
            assert len(kbs) == 2
            assert kbs[1] == outcome.kb
            assert outcome.kb.did == DID_B
            assert outcome.kb.label == "KB B"
            assert outcome.kb.id != KB_A
            assert outcome.kb.endpoint == believed.endpoint
            assert session_of(browser) == outcome.kb.id
            assert world.stored_refresh(outcome.kb.id) == "for-b"
            assert outcome.expected == Expected(did=DID_A, name="KB A")

    run(scenario())


def test_of_two_entries_at_one_address_a_sign_in_lands_on_the_one_whose_did_answered() -> None:
    async def scenario() -> None:
        twin = kb("kb-a2", "KB B here", DID_B, endpoint("localhost", 4000))
        world = World().with_(kb_of_a(), twin)
        async with world.browser() as browser:
            await live(browser)

            outcome = await browser.signed_in(signed_in(endpoint("localhost", 4000), description("KB B", "example.org:kb-b"), "for-b"))

            kbs = kbs_of(browser)
            assert outcome.kb.id == twin.id
            assert len(kbs) == 2
            assert kbs[0] == kb_of_a()
            assert session_of(browser) == "kb-a2"
            # An address with two entries singles out no belief.
            assert outcome.expected is None

    run(scenario())


def test_an_entry_at_another_address_with_the_same_did_is_not_the_one_signed_in() -> None:
    async def scenario() -> None:
        # One knowledge base in two places is two entries.
        world = World().with_(kb_of_a())
        async with world.browser() as browser:
            await live(browser)

            outcome = await browser.signed_in(signed_in(endpoint("localhost", 4100), description("KB A", "example.org:kb-a"), "r"))

            assert outcome.kb.id != KB_A
            assert outcome.kb.did == DID_A
            assert len(kbs_of(browser)) == 2
            assert outcome.expected is None

    run(scenario())


def test_signing_out_forgets_the_tokens_closes_the_session_and_has_the_issuer_told() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        before = stored_session(world.storage, KB_A)
        async with world.browser() as browser:
            await live(browser)
            told: list[tuple[KnowledgeBase, ...]] = []

            async def listen() -> None:
                changes = aiter(browser.kbs)
                await anext(changes)
                async for kbs in changes:
                    told.append(kbs)

            listening = asyncio.create_task(listen())
            await turns()

            await browser.sign_out(KB_A)
            await settle()

            assert stored_session(world.storage, KB_A) is None
            assert session_of(browser) is None
            assert closed(world.factory.sessions.transports(KB_A)[0])
            assert list(world.factory.sessions.revoked) == [before]
            # Still registered, and still the active one: only signed out.
            assert kbs_of(browser) == (kb_of_a(),)
            assert active_of(browser) == KB_A
            # The list is said again, so whoever shows its status reads it anew.
            assert told != []
            assert browser.kb_session_status(KB_A) == "signed-out"

            # Signing out of what is not signed in tells the issuer nothing.
            await browser.sign_out(KB_A)
            await settle()
            assert len(world.factory.sessions.revoked) == 1
            await stopped(listening)

    run(scenario())


# ── What is open ────────────────────────────────────────────────────────


def test_resources_are_opened_renamed_closed_and_moved_in_the_active_knowledge_base() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        async with world.browser() as browser:
            await live(browser)

            browser.add_open_resource(ResourceId("r1"), "One", media_type="text/plain")
            browser.add_open_resource(ResourceId("r2"), "Two", storage_uri="file://two.md")
            browser.add_open_resource(ResourceId("r3"), "Three")
            assert shown(browser) == ["r1", "r2", "r3"]

            # Opening what is open already takes what is stated of it, in place.
            browser.add_open_resource(ResourceId("r1"), "One, renamed")
            browser.update_open_resource_name(ResourceId("r2"), "Two, renamed")
            tabs = browser.open_resources.value
            assert shown(browser) == ["r1", "r2", "r3"]
            assert (tabs[0].name, tabs[0].media_type) == ("One, renamed", "text/plain")
            assert (tabs[1].name, tabs[1].storage_uri) == ("Two, renamed", "file://two.md")

            browser.reorder_open_resources(0, 2)
            assert shown(browser) == ["r2", "r3", "r1"]
            # A place that is not in the list moves nothing.
            browser.reorder_open_resources(0, 3)
            browser.reorder_open_resources(7, 0)
            assert shown(browser) == ["r2", "r3", "r1"]

            browser.remove_open_resource(ResourceId("r3"))
            assert shown(browser) == ["r2", "r1"]
            assert len(world.stored_open(KB_A)) == 2

    run(scenario())


def test_a_resource_opened_after_a_removal_does_not_take_a_place_that_is_taken() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        async with world.browser() as browser:
            await live(browser)
            for each in ("r1", "r2", "r3"):
                browser.add_open_resource(ResourceId(each), each)

            browser.remove_open_resource(ResourceId("r2"))
            browser.add_open_resource(ResourceId("r4"), "r4")

            assert shown(browser) == ["r1", "r3", "r4"]
            assert [each.order for each in browser.open_resources.value] == [0, 2, 3]

    run(scenario())


def test_nothing_is_open_or_opened_or_viewed_without_a_live_session() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        world.storage.set(OPEN_RESOURCES_BY_KB_KEY, '{"kb-a":[{"id":"r1","name":"One","openedAt":1,"order":0}]}')
        world.storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, '{"kb-a":"r1"}')
        async with world.browser() as browser:
            await live(browser)
            assert shown(browser) == ["r1"]
            assert viewed(browser) == "r1"

            await browser.sign_out(KB_A)
            assert shown(browser) == []
            assert viewed(browser) is None
            browser.add_open_resource(ResourceId("r2"), "Two")
            browser.set_last_viewed_resource(ResourceId("r2"))
            browser.remove_open_resource(ResourceId("r1"))
            # Hidden, not forgotten: the storage holds what it held.
            assert world.stored_open(KB_A) == ["r1"]
            assert world.stored_last_viewed() == {KB_A: "r1"}

            await browser.sign_in(KB_A, tokens("r"))
            await live(browser)
            assert shown(browser) == ["r1"]
            assert viewed(browser) == "r1"

    run(scenario())


def test_each_knowledge_base_keeps_what_is_open_in_it_and_where_the_person_was() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a(), kb_of_b())
        async with world.browser() as browser:
            await live(browser)
            browser.add_open_resource(ResourceId("in-a"), "In A")
            browser.set_last_viewed_resource(ResourceId("in-a"))

            await browser.set_active_kb(KB_B)
            await live(browser)
            assert shown(browser) == []
            assert viewed(browser) is None
            browser.add_open_resource(ResourceId("in-b"), "In B")
            browser.set_last_viewed_resource(ResourceId("in-b"))

            await browser.set_active_kb(KB_A)
            await live(browser)
            assert shown(browser) == ["in-a"]
            assert viewed(browser) == "in-a"
            assert world.stored_open(KB_B) == ["in-b"]
            assert world.stored_last_viewed() == {KB_A: "in-a", KB_B: "in-b"}

    run(scenario())


def test_what_another_context_opens_or_views_is_shown_and_neither_loses_the_others() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        async with world.browser() as here, world.browser(world.storage.context()) as there:
            await live(here)
            await live(there)

            here.add_open_resource(ResourceId("from-here"), "Here")
            there.add_open_resource(ResourceId("from-there"), "There")
            there.set_last_viewed_resource(ResourceId("from-there"))

            # Each wrote against what the storage held, so both are there, in both.
            both = ["from-here", "from-there"]
            assert world.stored_open(KB_A) == both
            assert shown(here) == both
            assert shown(there) == both
            assert viewed(here) == "from-there"

    run(scenario())


def test_a_change_to_what_is_open_is_made_against_what_the_storage_holds() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        async with world.browser() as browser:
            await live(browser)
            browser.add_open_resource(ResourceId("mine"), "Mine")

            # Written to the storage with nobody told: a context does not hear
            # what it writes itself, so what the registry has in memory is
            # behind, and what it writes next must not put it back.
            world.storage.set(
                OPEN_RESOURCES_BY_KB_KEY,
                '{"kb-a":[{"id":"mine","name":"Mine","openedAt":1,"order":0},{"id":"theirs","name":"Theirs","openedAt":2,"order":1}]}',
            )
            world.storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, '{"kb-b":"in-b"}')
            browser.add_open_resource(ResourceId("another"), "Another")
            browser.set_last_viewed_resource(ResourceId("mine"))

            want = ["mine", "theirs", "another"]
            assert world.stored_open(KB_A) == want
            assert shown(browser) == want
            assert world.stored_last_viewed() == {KB_A: "mine", KB_B: "in-b"}

    run(scenario())


# ── What a session's arrival checks ─────────────────────────────────────


def test_only_a_resource_the_knowledge_base_says_is_gone_is_closed() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        world.opened(KB_A, "kept", "gone", "unreadable")
        world.factory.behind.gone.add("gone")
        world.factory.behind.failing.add("unreadable")
        world.factory.behind.media_types["kept"] = "application/pdf"
        async with world.browser() as browser:
            await live(browser)

            assert shown(browser) == ["kept", "unreadable"]
            assert world.stored_open(KB_A) == ["kept", "unreadable"]
            tabs = browser.open_resources.value
            # What was found is shown under the name and type it has now.
            assert (tabs[0].name, tabs[0].media_type) == ("name-kept", "application/pdf")
            # What could not be read is left exactly as it was.
            assert tabs[1].name == "stale-unreadable"

    run(scenario())


def test_what_is_open_is_checked_once_per_session_and_again_for_the_next() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a(), kb_of_b())
        world.opened(KB_A, "a1", "a2", "a3", "a4", "a5", "a6")
        world.opened(KB_B, "b1")
        async with world.browser() as browser:
            await live(browser)
            assert len(world.factory.asked_about(KB_A)) == 6

            # Changing what is open shows the list again, and checks nothing.
            browser.add_open_resource(ResourceId("a7"), "Seven")
            browser.reorder_open_resources(0, 1)
            await settle()
            assert len(world.factory.asked_about(KB_A)) == 6

            await browser.set_active_kb(KB_B)
            await live(browser)
            assert world.factory.asked_about(KB_B) == ["b1"]

    run(scenario())


def test_a_resource_another_context_opened_while_the_checks_ran_is_left_open() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        world.opened(KB_A, "gone")
        world.factory.behind.gone.add("gone")
        # The session takes a moment to come up, so the other context writes before it is up.
        world.factory.sessions.answers_after(2.0)
        elsewhere = world.storage.context()
        async with world.browser() as browser:
            await turns()
            elsewhere.set(
                OPEN_RESOURCES_BY_KB_KEY,
                '{"kb-a":[{"id":"gone","name":"stale-gone","openedAt":0,"order":0},{"id":"sibling","name":"Sibling","openedAt":9,"order":9}]}',
            )
            await hurried(reached(browser.active_session, lambda session: session is not None))
            await settle()

            assert shown(browser) == ["sibling"]
            assert world.stored_open(KB_A) == ["sibling"]

    run(scenario())


def test_a_different_knowledge_base_answering_voids_what_was_open_and_is_raised() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a(), kb_of_b())
        world.opened(KB_A, "a1", "a2")
        world.opened(KB_B, "b1")
        world.storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, '{"kb-a":"a1","kb-b":"b1"}')
        world.factory.says(KB_A, description("KB B", "example.org:kb-b", "main"))
        async with world.browser() as browser:
            await live(browser)

            assert shown(browser) == []
            assert world.stored_open(KB_A) == []
            assert viewed(browser) is None
            # Only the active one's: the other keeps both.
            assert world.stored_open(KB_B) == ["b1"]
            assert world.stored_last_viewed() == {KB_B: "b1"}
            assert conflict(browser) == KbIdentityConflict(expected_did=DID_A, observed_did=DID_B)
            # The entry is as it was written: nothing of the other is put on it.
            assert kbs_of(browser)[0] == kb_of_a()
            # And no resource was asked about: those answers would be the wrong one's.
            assert world.factory.asked_about(KB_A) == []

    run(scenario())


def test_the_knowledge_base_answering_as_itself_changes_nothing_and_is_recorded() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        world.opened(KB_A, "a1")
        world.factory.says(KB_A, description("KB A, as it says", "example.org:kb-a", "main"))
        async with world.browser() as browser:
            await live(browser)

            assert shown(browser) == ["a1"]
            assert conflict(browser) is None
            entry = kbs_of(browser)[0]
            assert entry.label == "KB A, as it says"
            assert entry.last_read is not None
            assert entry.last_read.git_branch == "main"

        # And a new registry on the storage reads what was recorded.
        async with world.browser() as reopened:
            assert reopened.kbs.value[0] == entry

    run(scenario())


@pytest.mark.parametrize("refusing", [False, True])
def test_no_answer_and_a_refusal_to_say_are_no_verdict_and_void_nothing(refusing: bool) -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        world.opened(KB_A, "a1")
        if refusing:
            world.factory.behind.refusing.add(KB_A)
        async with world.browser() as browser:
            await live(browser)

            assert shown(browser) == ["a1"]
            assert conflict(browser) is None
            assert kbs_of(browser)[0] == kb_of_a()
            # The resources were checked all the same.
            assert world.factory.asked_about(KB_A) == ["a1"]
            assert await browser.read_active_kb() == KbReadVerdict(kind="no-verdict")

    run(scenario())


def test_asking_the_active_knowledge_base_again_records_what_it_says_now() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        world.factory.says(KB_A, description("KB A", "example.org:kb-a", "main"))
        async with world.browser() as browser:
            await live(browser)
            asked = world.factory.asked_who(KB_A)

            world.factory.says(KB_A, description("KB A", "example.org:kb-a"))
            assert await browser.read_active_kb() == KbReadVerdict(kind="recorded")

            assert world.factory.asked_who(KB_A) == asked + 1
            # A tree that is on no branch is recorded as on none.
            read = kbs_of(browser)[0].last_read
            assert read is not None
            assert read.git_branch is None

    run(scenario())


def test_asking_again_reports_a_different_knowledge_base_and_acts_on_nothing() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        world.opened(KB_A, "a1")
        world.factory.says(KB_A, description("KB A", "example.org:kb-a"))
        async with world.browser() as browser:
            await live(browser)
            browser.set_last_viewed_resource(ResourceId("a1"))

            world.factory.says(KB_A, description("KB B", "example.org:kb-b"))
            verdict = await browser.read_active_kb()

            assert verdict == KbReadVerdict(kind="conflict", observed_did=DID_B, observed_name="KB B")
            # Asking is not activating: nothing is voided, and nothing is raised.
            assert shown(browser) == ["a1"]
            assert viewed(browser) == "a1"
            assert conflict(browser) is None
            assert kbs_of(browser)[0].label == "KB A"

    run(scenario())


def test_asking_again_does_not_raise_a_conflict_that_was_acknowledged() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        world.factory.says(KB_A, description("KB B", "example.org:kb-b"))
        async with world.browser() as browser:
            await live(browser)
            signals = signals_of(browser)
            assert signals is not None
            assert conflict(browser) is not None
            signals.acknowledge_kb_identity_conflict()

            assert (await browser.read_active_kb()).kind == "conflict"
            assert conflict(browser) is None

    run(scenario())


def test_with_no_session_there_is_nothing_to_ask() -> None:
    async def scenario() -> None:
        async with World().browser() as browser:
            assert await browser.read_active_kb() == KbReadVerdict(kind="no-verdict")

    run(scenario())


# ── What the session's transport fails at ───────────────────────────────


def test_a_refusal_for_want_of_a_token_renews_the_session_quietly_when_it_can() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        renewed = token(7200, 2)
        world.factory.sessions.queue_renewals(renewed)
        async with world.browser() as browser:
            session = await live(browser)

            world.factory.sessions.transports(KB_A)[0].fail(TransportError.of_status("HTTP 401", 401, None))
            await settle()

            assert world.factory.sessions.renewed == 1
            assert session.token.value == renewed
            assert session_ended(browser) is None
            assert stored_session(world.storage, KB_A) is not None

    run(scenario())


def test_a_session_that_cannot_be_renewed_is_said_to_have_expired_and_its_credential_is_gone() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        # The issuer has nothing to renew it with.
        world.factory.sessions.queue_renewals(None)
        browser = world.browser()
        errors = browser.errors()
        async with browser:
            await live(browser)

            world.factory.sessions.transports(KB_A)[0].fail(TransportError.of_status("HTTP 401", 401, None))
            await settle()

            assert session_ended(browser) == SessionEnded(reason="expired")
            assert stored_session(world.storage, KB_A) is None
            said = await soon(anext(errors))
            assert said.code == "session.refresh-exhausted"

            # The refusals that follow find nothing stored, and say nothing more.
            signals = signals_of(browser)
            assert signals is not None
            signals.acknowledge_session_ended()
            world.factory.sessions.transports(KB_A)[0].fail(TransportError.of_status("HTTP 401", 401, None))
            await settle()
            assert session_ended(browser) is None

    run(scenario())


def test_a_refusal_with_nothing_stored_is_being_signed_out_and_not_an_expiry() -> None:
    async def scenario() -> None:
        world = World()
        save_knowledge_bases(world.storage, [kb_of_a()])
        async with world.browser() as browser:
            await live(browser)

            world.factory.sessions.transports(KB_A)[0].fail(TransportError.of_status("HTTP 401", 401, None))
            await settle()

            assert session_ended(browser) is None

    run(scenario())


def test_a_refusal_for_lack_of_permission_is_said_and_any_other_failure_is_not() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        async with world.browser() as browser:
            await live(browser)
            transport = world.factory.sessions.transports(KB_A)[0]

            for status in (404, 409, 500, 503):
                transport.fail(TransportError.of_status(f"HTTP {status}", status, None))
            await settle()
            assert denied(browser) is None
            assert session_ended(browser) is None
            assert world.factory.sessions.renewed == 0

            transport.fail(TransportError.of_status("HTTP 403", 403, None))
            await settle()
            assert denied(browser) == PermissionDenied(detail="HTTP 403")
            assert session_ended(browser) is None

    run(scenario())


# ── How it ends ─────────────────────────────────────────────────────────


def test_closing_the_registry_closes_its_session_and_ends_what_it_holds() -> None:
    async def scenario() -> None:
        world = World().with_(kb_of_a())
        browser = world.browser()
        errors = browser.errors()
        async with browser:
            await live(browser)

        await browser.close()

        assert closed(world.factory.sessions.transports(KB_A)[0])
        assert await ended(browser.kbs)
        assert await ended(browser.active_session)
        assert await ended(browser.active_signals)
        assert browser.bus.destroyed
        assert [error async for error in errors] == []
        # Nothing it is told afterwards does anything, and what is stored stays.
        await browser.set_active_kb(None)
        await browser.sign_in(KB_A, tokens("late"))
        assert world.storage.get(ACTIVE_KEY) == KB_A
        assert world.stored_refresh(KB_A) == "r"

    run(scenario())
