"""The sign-ins `semiont login` keeps (`specs/src/sign-in-store/README.md`), as this package reads and writes them.

Where the file is, is `test_state_dir.py`'s. Here: what an entry holds, what
a renewal keeps while other programs renew and sign out (every renewal of
`specs/src/sign-in-store/cases.json`), what is written back untouched, and the
lock every writer of the file takes.
"""

import asyncio
import json
import os
import stat
import subprocess
import sys
import threading
import time
from collections.abc import Awaitable, Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from typing import final, override
from urllib.parse import parse_qs

import pytest
from aio import run, soon
from gateway_server import GatewayServer
from issuer import TOKEN, says
from pydantic import JsonValue
from spec import SPEC, JsonObject, objects, read, strings, text
from tokens import jwt, token

from semiont.errors import SignInError
from semiont.http.oauth import renew_kept
from semiont.session import HeldSignIn, MemorySignIn, SignInKept
from semiont.sign_in import SignIn
from semiont.sign_in_store import FILE_NAME, SignInStore

SCHEMA = read(SPEC / "sign-in-store/SignIn.json")
RENEWALS = objects(read(SPEC / "sign-in-store/cases.json")["renewals"], "renewals")
ISSUER = "https://issuer.test/realms/semiont"


def signed_in(n: int, *, email: str = "alice@example.org") -> str:
    return token(3600, n, email=email, iss=ISSUER)


def held(access: str, refresh: str = "refresh-1", *, revocation: str | None = f"{ISSUER}/revoke") -> HeldSignIn:
    return HeldSignIn(
        access=access, refresh=refresh, client_id="semiont-cli", token_endpoint=f"{ISSUER}/token", revocation_endpoint=revocation
    )


def document(path: Path) -> JsonObject:
    return read(path)


def entry(path: Path, key: str) -> JsonObject:
    found = document(path)[key]
    assert isinstance(found, dict)
    return found


def test_the_entry_this_package_writes_is_the_schemas() -> None:
    properties = SCHEMA["properties"]
    assert isinstance(properties, dict)
    written = {field.alias or name for name, field in SignIn.model_fields.items()}
    assert written == set(properties)
    required = {field.alias or name for name, field in SignIn.model_fields.items() if field.is_required()}
    assert required == set(strings(SCHEMA["required"], "required"))


def test_a_store_whose_file_is_not_there_holds_nothing_and_reading_it_makes_nothing(tmp_path: Path) -> None:
    path = tmp_path / "state" / FILE_NAME
    store = SignInStore(path)

    assert store.read() == {}
    assert run(store.entry("local").held()) is None
    assert not path.parent.exists(), "a reader that only reads writes nothing, and takes no lock"


def test_a_sign_in_is_kept_as_the_launcher_keeps_one(tmp_path: Path) -> None:
    path = tmp_path / "state" / FILE_NAME
    store = SignInStore(path)
    access = signed_in(1)

    run(store.entry("local").keep(held(access)))

    kept = entry(path, "local")
    assert kept["token"] == access
    assert kept["refreshToken"] == "refresh-1"
    # Who signed in, and at which issuer, as the access token names them.
    assert (kept["email"], kept["issuer"]) == ("alice@example.org", ISSUER)
    assert (kept["tokenEndpoint"], kept["revocationEndpoint"]) == (f"{ISSUER}/token", f"{ISSUER}/revoke")
    # RFC 3339 in UTC, to the second.
    for name in ("obtainedAt", "expiresAt"):
        stated = kept[name]
        assert isinstance(stated, str)
        assert len(stated) == 20, stated
        assert stated.endswith("Z"), stated
    assert set(kept) <= {field.alias or name for name, field in SignIn.model_fields.items()}
    assert run(store.entry("local").held()) == held(access)
    # The file holds bearer credentials: it is its owner's alone, and so is its lock. Nothing else is left beside it.
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE((path.parent / "tokens.lock").stat().st_mode) == 0o600
    assert sorted(found.name for found in path.parent.iterdir()) == ["tokens.json", "tokens.lock"]
    assert path.read_bytes().endswith(b"}\n")


def test_an_issuer_with_no_revocation_endpoint_and_a_token_with_no_expiry_leave_those_out(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    access = jwt({"email": "alice@example.org", "iss": ISSUER})

    run(SignInStore(path).entry("local").keep(held(access, revocation=None)))

    assert "revocationEndpoint" not in entry(path, "local")
    assert "expiresAt" not in entry(path, "local")


def test_what_is_no_sign_in_is_not_kept(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    kept = SignInStore(path).entry("local")

    # What another client was issued would be renewed here as the wrong client.
    with pytest.raises(ValueError, match="semiont-browser"):
        run(kept.keep(HeldSignIn(access=signed_in(1), refresh="r", client_id="semiont-browser", token_endpoint=f"{ISSUER}/token")))
    # A gateway admits no token from an issuer it does not trust.
    with pytest.raises(SignInError, match="names no issuer") as lacking:
        run(kept.keep(held(jwt({"email": "alice@example.org"}))))
    assert lacking.value.code == "exchange"
    assert not path.exists()


def test_a_token_that_names_no_address_is_kept_without_one(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    kept = SignInStore(path).entry("local")
    unaddressed = held(jwt({"iss": ISSUER, "sub": "an-account"}))

    run(kept.keep(unaddressed))

    assert entry(path, "local")["issuer"] == ISSUER
    assert "email" not in entry(path, "local")
    assert run(kept.held()) == unaddressed
    # A renewal whose token names an address keeps none: the sign-in learned none.
    renewed = signed_in(2)
    assert run(kept.renewed(unaddressed, renewed, "refresh-2")) == renewed
    assert "email" not in entry(path, "local")


def test_a_renewal_keeps_who_signed_in_and_where_and_changes_the_tokens(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    kept = SignInStore(path).entry("local")
    first = held(signed_in(1))
    run(kept.keep(first))
    before = entry(path, "local")
    # The renewed token names another address: the entry keeps the one the sign-in learned.
    renewed = signed_in(2, email="alice@elsewhere.example")

    assert run(kept.renewed(first, renewed, "refresh-2")) == renewed

    after = entry(path, "local")
    assert (after["token"], after["refreshToken"]) == (renewed, "refresh-2")
    for name in ("email", "issuer", "tokenEndpoint", "revocationEndpoint"):
        assert after[name] == before[name], name
    assert run(kept.held()) == held(renewed, "refresh-2")


def test_forgetting_what_is_not_kept_changes_nothing(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    kept = SignInStore(path).entry("local")
    run(kept.keep(held(signed_in(1))))
    run(kept.forget())

    assert document(path) == {}
    wrote = path.stat().st_mtime_ns
    run(kept.forget())
    assert path.stat().st_mtime_ns == wrote


def test_an_entry_with_no_refresh_token_is_no_sign_in_to_hold(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    path.write_text(
        json.dumps({"local": {"token": signed_in(1), "email": "a@example.org", "obtainedAt": "x", "issuer": ISSUER, "tokenEndpoint": "t"}})
    )

    assert run(SignInStore(path).entry("local").held()) is None


def test_what_the_file_holds_that_is_not_this_sign_in_is_written_back_as_it_was(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    store = SignInStore(path)
    run(store.entry("codespace:owner/name").keep(held(signed_in(7))))
    others: JsonObject = {
        "codespace:owner/name": entry(path, "codespace:owner/name"),
        # What a later release wrote, and this one does not understand.
        "later": {"shape": ["unknown", 1, None], "nested": {"deep": True}},
        "not-even-an-object": 3,
    }
    path.write_text(json.dumps(others))

    first = held(signed_in(1))
    run(store.entry("local").keep(first))
    renewed = signed_in(2)
    assert run(store.entry("local").renewed(first, renewed, "refresh-2")) == renewed
    assert {key: value for key, value in document(path).items() if key != "local"} == others
    # What is not a sign-in is none to hold, and is not renewed into one.
    assert run(store.entry("later").held()) is None
    assert run(store.entry("later").renewed(held(signed_in(3)), signed_in(3), "refresh-3")) is None

    run(store.entry("local").forget())
    assert document(path) == others


# ── What a renewal keeps while other programs renew and sign out ────────

RENEWAL_MEMBERS = {"why", "kept", "holding", "meanwhile", "expired", "issues", "spends", "leaves", "gives"}

type Holds = Callable[[], Awaitable[tuple[str, str] | None]]
"""The tokens a store holds for the stack: its access token and its refresh token, when it holds a sign-in."""


def file_store(directory: Path) -> tuple[SignInKept, SignInKept, Holds]:
    """The renewer's entry, another program's, and what the file holds."""
    path = directory / "state" / FILE_NAME

    async def holds() -> tuple[str, str] | None:
        found = SignInStore(path).read().get("local")
        if found is None:
            return None
        assert isinstance(found, dict)
        access, refresh = found["token"], found["refreshToken"]
        assert isinstance(access, str)
        assert isinstance(refresh, str)
        return access, refresh

    return SignInStore(path).entry("local"), SignInStore(path).entry("local"), holds


def memory_store(_directory: Path) -> tuple[SignInKept, SignInKept, Holds]:
    """One sign-in kept in memory, which the renewer and another holder share."""
    kept = MemorySignIn()

    async def holds() -> tuple[str, str] | None:
        found = await kept.held()
        return None if found is None else (found.access, found.refresh)

    return kept, kept, holds


STORES = {"SignInStore": file_store, "MemorySignIn": memory_store}


@final
class Meanwhile(SignInKept):
    """The renewer's sign-in, on which another program acts between the renewal's read and its write: while its grant is in flight."""

    def __init__(self, kept: SignInKept, act: Callable[[], Awaitable[None]]) -> None:
        self._kept = kept
        self._act = act

    @override
    async def held(self) -> HeldSignIn | None:
        found = await self._kept.held()
        await self._act()
        return found

    @override
    async def keep(self, sign_in: HeldSignIn) -> None:
        await self._kept.keep(sign_in)

    @override
    async def renewed(self, read: HeldSignIn, access: str, refresh: str) -> str | None:
        return await self._kept.renewed(read, access, refresh)

    @override
    async def forget(self) -> None:
        await self._kept.forget()


def tokens_of(stated: JsonObject, what: str) -> tuple[str, str | None]:
    """A sign-in as the table states one: its access token's name and its refresh token, when it states one."""
    refresh = stated.get("refreshToken")
    assert refresh is None or isinstance(refresh, str), what
    return text(stated["token"], what), refresh


def optional_text(value: JsonValue, what: str) -> str | None:
    return None if value is None else text(value, what)


@pytest.mark.parametrize("row", RENEWALS, ids=[text(row["why"], "why") for row in RENEWALS])
@pytest.mark.parametrize("store", STORES)
def test_every_renewal_is_the_tables(store: str, row: JsonObject, tmp_path: Path) -> None:
    assert set(row) == RENEWAL_MEMBERS
    expired = strings(row["expired"], "expired")
    renewer, another, holds = STORES[store](tmp_path)
    # Each access token the row names is a JWT of its own.
    minted: dict[str, str] = {}

    def named(name: str) -> str:
        if name not in minted:
            now = int(time.time())
            expiry = now - 3600 if name in expired else now + 3600
            minted[name] = jwt({"email": "alice@example.org", "iss": ISSUER, "exp": expiry, "jti": name})
        return minted[name]

    def name_of(access: str | None) -> str | None:
        return next((name for name, minted_token in minted.items() if minted_token == access), access)

    async def scenario() -> None:
        async with GatewayServer() as gateway:

            def sign_in(stated: JsonValue, what: str) -> HeldSignIn:
                assert isinstance(stated, dict), what
                access, refresh = tokens_of(stated, what)
                assert refresh is not None, what
                return HeldSignIn(access=named(access), refresh=refresh, client_id="semiont-cli", token_endpoint=f"{gateway.origin}{TOKEN}")

            await another.keep(sign_in(row["kept"], "kept"))
            meanwhile = row["meanwhile"]
            assert meanwhile is None or isinstance(meanwhile, dict)

            async def act() -> None:
                assert meanwhile is not None
                does = meanwhile["does"]
                if does == "renews":
                    await another.keep(sign_in(meanwhile["theirs"], "theirs"))
                else:
                    assert does == "signs-out", does
                    await another.forget()

            issues = row["issues"]
            assert isinstance(issues, dict)
            issued_access, issued_refresh = tokens_of(issues, "issues")
            issued: JsonObject = {"access_token": named(issued_access), "token_type": "Bearer"}
            if issued_refresh is not None:
                issued["refresh_token"] = issued_refresh
            gateway.scripted[("POST", TOKEN)] = [says(issued)]
            renewing = renewer
            if meanwhile is not None:
                if meanwhile["when"] == "before":
                    await act()
                else:
                    assert meanwhile["when"] == "during", meanwhile["when"]
                    renewing = Meanwhile(renewer, act)
            holding = optional_text(row["holding"], "holding")

            given = await soon(renew_kept(renewing, None if holding is None else named(holding)))

            spent = [parse_qs(asked.body.decode())["refresh_token"][0] for asked in gateway.of("POST", TOKEN)]
            spends = optional_text(row["spends"], "spends")
            assert spent == ([] if spends is None else [spends]), "the grants made"
            assert name_of(given) == optional_text(row["gives"], "gives"), "the access token given"
            left = await holds()
            leaves = row["leaves"]
            assert leaves is None or isinstance(leaves, dict)
            assert (None if left is None else (name_of(left[0]), left[1])) == (None if leaves is None else tokens_of(leaves, "leaves")), (
                "what the store holds"
            )

    run(scenario())


def put(key: str, value: int) -> Callable[[JsonObject], bool]:
    """A change that puts one member in the document."""

    def change(held_document: JsonObject) -> bool:
        held_document[key] = value
        return True

    return change


# A program that takes the lock every writer of the file takes, says so, and holds it until it is told to let go,
# or for five seconds: a test that cannot tell it to, fails, and does not wait for good.
# It takes it as the launcher does on each system: `flock`, and on Windows the launcher's own call,
# `LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &Overlapped{OffsetHigh: 0x40000000})`.
HOLDER = """
import os, sys, threading, time
descriptor = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
if sys.platform == "win32":
    import ctypes, msvcrt
    from ctypes import wintypes
    class Overlapped(ctypes.Structure):
        _fields_ = [("Internal", ctypes.c_void_p), ("InternalHigh", ctypes.c_void_p),
                    ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD), ("hEvent", wintypes.HANDLE)]
    where = Overlapped(None, None, 0, 0x40000000, None)
    handle = wintypes.HANDLE(msvcrt.get_osfhandle(descriptor))
    if not ctypes.windll.kernel32.LockFileEx(handle, 0x2 | 0x1, 0, 1, 0, ctypes.byref(where)):
        raise ctypes.WinError()
else:
    import fcntl
    fcntl.flock(descriptor, fcntl.LOCK_EX)
print("held", flush=True)
threading.Thread(target=lambda: (sys.stdin.read(), os._exit(0)), daemon=True).start()
time.sleep(5)
"""


@contextmanager
def another_process_holding(lock: Path) -> Generator[Callable[[], None]]:
    """Another process holds `lock` from here on, until what is given is called or the block is left."""
    holder = subprocess.Popen([sys.executable, "-c", HOLDER, str(lock)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def let_go() -> None:
        # Its input ends, and so does it: a process that has ended holds no lock.
        if holder.poll() is None:
            holder.communicate(b"")

    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == b"held"
        yield let_go
    finally:
        let_go()


def test_a_change_waits_for_the_lock_another_process_holds(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    store = SignInStore(path)
    changed = threading.Event()

    def change() -> None:
        store.change(put("mine", 1))
        changed.set()

    changing = threading.Thread(target=change)
    with another_process_holding(tmp_path / "tokens.lock"):
        changing.start()
        assert not changed.wait(0.3), "the change was made while another process held the lock"
        assert not path.exists()
        # A reader that only reads takes no lock.
        assert store.read() == {}
    assert changed.wait(5), "the change was not made once the lock was let go"
    changing.join()
    assert document(path) == {"mine": 1}


def test_the_event_loop_turns_while_a_change_waits_for_the_lock(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    kept = SignInStore(path).entry("local")
    run(kept.keep(held(signed_in(1))))

    async def scenario() -> None:
        with another_process_holding(tmp_path / "tokens.lock") as let_go:
            forgetting = asyncio.create_task(kept.forget())
            for _ in range(20):
                await asyncio.sleep(0.005)
            assert not forgetting.done()
            let_go()
            await soon(forgetting)

    run(scenario())
    assert document(path) == {}


# A program that adds its own members to the store's document, one change at a time.
WRITER = """
import sys
from semiont.sign_in_store import SignInStore
store = SignInStore(sys.argv[1])
def put(key, value):
    def change(document):
        document[key] = value
        return True
    return change
for n in range(int(sys.argv[3])):
    store.change(put(f"{sys.argv[2]}-{n}", n))
"""


def test_writers_in_several_processes_lose_nothing_of_each_others(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    writers = [subprocess.Popen([sys.executable, "-c", WRITER, str(path), name, "40"]) for name in ("a", "b", "c", "d")]

    assert [writer.wait(60) for writer in writers] == [0, 0, 0, 0]
    assert document(path) == {f"{name}-{n}": n for name in ("a", "b", "c", "d") for n in range(40)}


def test_a_write_that_fails_leaves_the_document_whole_and_no_credential_in_a_stray_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / FILE_NAME
    store = SignInStore(path)
    store.change(put("kept", 1))

    def refuse(source: str, target: str) -> None:
        raise OSError(f"{target} could not be replaced: the disk is full")

    with monkeypatch.context() as patched:
        patched.setattr(os, "replace", refuse)
        with pytest.raises(OSError, match="the disk is full"):
            store.change(put("kept", 2))

    assert document(path) == {"kept": 1}
    assert sorted(found.name for found in tmp_path.iterdir()) == ["tokens.json", "tokens.lock"]
    # And the lock was let go: the next change is made.
    store.change(put("kept", 3))
    assert document(path) == {"kept": 3}
