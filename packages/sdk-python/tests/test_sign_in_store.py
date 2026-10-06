"""The sign-ins `semiont login` keeps (`specs/src/sign-in-store/README.md`), as this package reads and writes them.

Where the file is, is `test_state_dir.py`'s. Here: what an entry holds, what
a renewal keeps, what is written back untouched, and the lock every writer of
the file takes.
"""

import asyncio
import json
import os
import stat
import subprocess
import sys
import threading
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path

import pytest
from aio import run, soon
from spec import SPEC, JsonObject, read, strings
from tokens import jwt, token

from semiont.errors import SignInError
from semiont.session import HeldSignIn
from semiont.sign_in import SignIn
from semiont.sign_in_store import FILE_NAME, SignInStore

SCHEMA = read(SPEC / "sign-in-store/SignIn.json")
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
    # A gateway admits no token that names no address, and none from an issuer it does not trust.
    with pytest.raises(SignInError, match="names no email") as lacking:
        run(kept.keep(held(jwt({"iss": ISSUER}))))
    assert lacking.value.code == "exchange"
    with pytest.raises(SignInError, match="names no issuer"):
        run(kept.keep(held(jwt({"email": "alice@example.org"}))))
    assert not path.exists()


def test_a_renewal_keeps_who_signed_in_and_where_and_changes_the_tokens(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    kept = SignInStore(path).entry("local")
    run(kept.keep(held(signed_in(1))))
    before = entry(path, "local")
    # The renewed token names another address: the entry keeps the one the sign-in learned.
    renewed = signed_in(2, email="alice@elsewhere.example")

    assert run(kept.renewed(renewed, "refresh-2"))

    after = entry(path, "local")
    assert (after["token"], after["refreshToken"]) == (renewed, "refresh-2")
    for name in ("email", "issuer", "tokenEndpoint", "revocationEndpoint"):
        assert after[name] == before[name], name
    assert run(kept.held()) == held(renewed, "refresh-2")


def test_a_sign_in_that_ended_while_it_was_renewed_is_not_written_back(tmp_path: Path) -> None:
    path = tmp_path / FILE_NAME
    kept = SignInStore(path).entry("local")
    run(kept.keep(held(signed_in(1))))
    run(kept.forget())

    assert not run(kept.renewed(signed_in(2), "refresh-2"))
    assert document(path) == {}
    # Forgetting what is not kept changes nothing.
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

    run(store.entry("local").keep(held(signed_in(1))))
    assert run(store.entry("local").renewed(signed_in(2), "refresh-2"))
    assert {key: value for key, value in document(path).items() if key != "local"} == others
    # What is not a sign-in is none to hold, and is not renewed into one.
    assert run(store.entry("later").held()) is None
    assert not run(store.entry("later").renewed(signed_in(3), "refresh-3"))

    run(store.entry("local").forget())
    assert document(path) == others


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
