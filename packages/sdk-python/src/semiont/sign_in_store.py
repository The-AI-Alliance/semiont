"""The sign-ins `semiont login` keeps (`specs/src/sign-in-store`).

One sign-in serves the launcher's verbs and an application built on this SDK.

The launcher keeps one sign-in per stack in `<stateDir>/tokens.json`, under
the stack's key (`local`, `codespace:<owner>/<name>`). A session reaches one
by that key: `SignInStore(path).entry("local")` is where the session of the
local stack's knowledge base is kept.

What is in the file was issued to the script client and is renewed as it, and
that is the only client this SDK signs in as.

**Every change is a read, a change and a write under a lock** (`tokens.lock`,
beside the file; `flock`, and `LockFileEx` on Windows): another process
renewing another stack at the same moment loses nothing. What the file holds
that is not a sign-in as this release knows one is written back as it was. A
reader that only reads takes no lock: the file is replaced whole, so every
document read is a whole one.

This module reads no environment. An application reads its own and says what
it found: `state_dir(this_system(), home=..., xdg_state_home=..., local_app_data=...)`.
"""

import asyncio
import os
import sys
import threading
import time
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager, suppress
from types import MappingProxyType
from typing import Final, Literal, final, override

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont.errors import SignInError
from semiont.oauth_clients import SCRIPT_CLIENT_ID
from semiont.session import HeldSignIn, SignInKept, text_claim, token_expiry
from semiont.sign_in import SignIn

__all__ = ["FILE_NAME", "SignInStore", "System", "state_dir", "this_system"]

FILE_NAME: Final = "tokens.json"
"""The file's name in the launcher's state home."""

_LOCK_NAME: Final = "tokens.lock"

type System = Literal["macos", "windows", "other"]
"""The systems the state home differs by: macOS, Windows, and everything else."""

_DOCUMENT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


_SYSTEMS: Final[Mapping[str, System]] = MappingProxyType({"darwin": "macos", "win32": "windows"})


def this_system() -> System:
    """The system this process runs on."""
    return _SYSTEMS.get(sys.platform, "other")


def _under(separator: str, base: str, *names: str) -> str:
    return separator.join([base.rstrip(separator), *names])


def state_dir(system: System, *, home: str | None, xdg_state_home: str | None, local_app_data: str | None) -> str | None:
    """The launcher's state home, from what the system says of the person's directories.

    `home` is the home directory (`HOME`, or `USERPROFILE` on Windows),
    `xdg_state_home` is `XDG_STATE_HOME` and `local_app_data` is
    `LOCALAPPDATA`, each none when it is not set. Nothing when there is no
    home. The path is composed with the system's own separator, not this
    machine's: a case gives one answer whichever machine computes it.
    """
    if not home:
        return None
    if system == "macos":
        return _under("/", home, "Library", "Application Support", "semiont")
    if system == "windows":
        return _under("\\", local_app_data, "semiont") if local_app_data else _under("\\", home, "AppData", "Local", "semiont")
    return _under("/", xdg_state_home, "semiont") if xdg_state_home else _under("/", home, ".local", "state", "semiont")


def _rfc3339(at: float) -> str:
    """A time as RFC 3339 in UTC, to the second."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))


if sys.platform == "win32":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class _Overlapped(ctypes.Structure):
        _fields_ = (
            ("Internal", ctypes.c_void_p),
            ("InternalHigh", ctypes.c_void_p),
            ("Offset", wintypes.DWORD),
            ("OffsetHigh", wintypes.DWORD),
            ("hEvent", wintypes.HANDLE),
        )

    _LOCKFILE_EXCLUSIVE_LOCK: Final = 0x00000002

    def _lock(descriptor: int) -> None:
        # The one byte the launcher locks, far past anything a lock file holds;
        # a program that locks the whole file, as the Rust SDK does, covers it.
        where = _Overlapped(None, None, 0, 0x40000000, None)
        locked = ctypes.windll.kernel32.LockFileEx(
            wintypes.HANDLE(msvcrt.get_osfhandle(descriptor)), _LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, ctypes.byref(where)
        )
        if not locked:
            raise ctypes.WinError()

else:
    import fcntl

    def _lock(descriptor: int) -> None:
        fcntl.flock(descriptor, fcntl.LOCK_EX)


@final
class SignInStore:
    """The store in the file at `path`: `FILE_NAME` in `state_dir`, for the launcher's."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self._path: Final = os.fspath(path)
        self._lock_path: Final = os.path.join(os.path.dirname(self._path), _LOCK_NAME)
        # One change at a time from this process: the file lock is between
        # processes, and two handles of one process on one file do not exclude
        # each other on every system.
        self._turn: Final = threading.Lock()

    def entry(self, key: str) -> SignInKept:
        """Where the sign-in of the stack `key` is kept."""
        return _Entry(self, key)

    def read(self) -> dict[str, JsonValue]:
        """The document as it is now. A file that is not there holds nothing."""
        try:
            with open(self._path, "rb") as file:
                return _DOCUMENT.validate_json(file.read())
        except FileNotFoundError:
            return {}

    @contextmanager
    def _locked(self) -> Generator[None]:
        """Hold the lock every writer of the document takes, from before its read until after its rename."""
        os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
        with self._turn:
            descriptor = os.open(self._lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                _lock(descriptor)
                yield
            finally:
                # Closing it lets the lock go.
                os.close(descriptor)

    def change(self, change: Callable[[dict[str, JsonValue]], bool]) -> None:
        """Change the document as one step: read it, change it, and write it when `change` says it changed."""
        with self._locked():
            document = self.read()
            if change(document):
                self._write(document)

    def _write(self, document: dict[str, JsonValue]) -> None:
        """Written beside the file and renamed over it: no reader sees half a document, and no credential is left in a stray file."""
        beside = f"{self._path}.tmp"
        try:
            descriptor = os.open(beside, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "wb") as file:
                file.write(_DOCUMENT.dump_json(document, indent=2) + b"\n")
            os.replace(beside, self._path)
        except BaseException:
            with suppress(FileNotFoundError):
                os.remove(beside)
            raise


def _sign_in_of(entry: JsonValue) -> SignIn | None:
    """A member of the document as a sign-in. One that is not a sign-in is none."""
    try:
        return SignIn.model_validate(entry)
    except ValidationError:
        return None


@final
class _Entry(SignInKept):
    """One stack's sign-in, in the store's file. Its file is read and written off the event loop."""

    def __init__(self, store: SignInStore, key: str) -> None:
        self._store = store
        self._key = key

    def _held(self) -> HeldSignIn | None:
        entry = _sign_in_of(self._store.read().get(self._key))
        # A sign-in with no refresh token is none: a session that cannot be
        # renewed does not outlive its first access token.
        if entry is None or not entry.refresh_token:
            return None
        return HeldSignIn(
            access=entry.token,
            refresh=entry.refresh_token,
            client_id=SCRIPT_CLIENT_ID,
            token_endpoint=entry.token_endpoint,
            revocation_endpoint=entry.revocation_endpoint,
        )

    def _written(self, before: SignIn, access: str, refresh: str) -> JsonValue:
        """The entry a renewal leaves: who signed in, at which issuer and where it is renewed stay as the sign-in learned them."""
        expiry = token_expiry(access)
        entry = SignIn(
            token=access,
            refresh_token=refresh,
            email=before.email,
            obtained_at=_rfc3339(time.time()),
            expires_at=None if expiry is None else _rfc3339(expiry),
            issuer=before.issuer,
            token_endpoint=before.token_endpoint,
            revocation_endpoint=before.revocation_endpoint,
        )
        return entry.model_dump(mode="json", exclude_none=True)

    def _keep(self, sign_in: HeldSignIn) -> None:
        if sign_in.client_id != SCRIPT_CLIENT_ID:
            raise ValueError(
                f"the sign-in store keeps what the client {SCRIPT_CLIENT_ID} was issued, and this was issued to {sign_in.client_id}"
            )
        # A gateway admits no token that names no address, and none from an
        # issuer it does not trust: a token that lacks either is no sign-in.
        email, issuer = text_claim(sign_in.access, "email"), text_claim(sign_in.access, "iss")
        if email is None or issuer is None:
            lacking = "email" if email is None else "issuer"
            raise SignInError("exchange", f"The sign-in to {self._key} was not kept: its access token names no {lacking}")
        learned = SignIn(
            token=sign_in.access,
            email=email,
            obtained_at=_rfc3339(time.time()),
            issuer=issuer,
            token_endpoint=sign_in.token_endpoint,
            revocation_endpoint=sign_in.revocation_endpoint,
        )

        def change(document: dict[str, JsonValue]) -> bool:
            document[self._key] = self._written(learned, sign_in.access, sign_in.refresh)
            return True

        self._store.change(change)

    def _renewed(self, access: str, refresh: str) -> bool:
        kept = False

        def change(document: dict[str, JsonValue]) -> bool:
            nonlocal kept
            before = _sign_in_of(document.get(self._key))
            if before is None:
                return False
            document[self._key] = self._written(before, access, refresh)
            kept = True
            return True

        self._store.change(change)
        return kept

    def _forget(self) -> None:
        self._store.change(lambda document: document.pop(self._key, None) is not None)

    @override
    async def held(self) -> HeldSignIn | None:
        return await asyncio.to_thread(self._held)

    @override
    async def keep(self, sign_in: HeldSignIn) -> None:
        await asyncio.to_thread(self._keep, sign_in)

    @override
    async def renewed(self, access: str, refresh: str) -> bool:
        return await asyncio.to_thread(self._renewed, access, refresh)

    @override
    async def forget(self) -> None:
        await asyncio.to_thread(self._forget)
