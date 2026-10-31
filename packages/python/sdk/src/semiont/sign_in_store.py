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
document read is a whole one. The file's directory is kept to its owner first,
as the launcher keeps its state home: mode `0700`, and on Windows the
launcher's access list, which what is made in it inherits.

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

    _CURRENT_PROCESS_TOKEN: Final = -4
    _TOKEN_USER: Final = 1
    _SDDL_REVISION_1: Final = 1
    _SE_FILE_OBJECT: Final = 1
    _DACL_SECURITY_INFORMATION: Final = 0x00000004
    _PROTECTED_DACL_SECURITY_INFORMATION: Final = 0x80000000

    _advapi32: Final = ctypes.WinDLL("advapi32", use_last_error=True)
    _kernel32: Final = ctypes.WinDLL("kernel32", use_last_error=True)

    _GetTokenInformation: Final = _advapi32.GetTokenInformation
    _GetTokenInformation.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD))
    _GetTokenInformation.restype = wintypes.BOOL
    _ConvertSidToStringSidW: Final = _advapi32.ConvertSidToStringSidW
    _ConvertSidToStringSidW.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR))
    _ConvertSidToStringSidW.restype = wintypes.BOOL
    _GetNamedSecurityInfoW: Final = _advapi32.GetNamedSecurityInfoW
    _GetNamedSecurityInfoW.argtypes = (
        wintypes.LPCWSTR,
        ctypes.c_int,
        wintypes.DWORD,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
    )
    _GetNamedSecurityInfoW.restype = wintypes.DWORD
    _ConvertSecurityDescriptorToStringSecurityDescriptorW: Final = _advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW
    _ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = (
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(wintypes.ULONG),
    )
    _ConvertSecurityDescriptorToStringSecurityDescriptorW.restype = wintypes.BOOL
    _ConvertStringSecurityDescriptorToSecurityDescriptorW: Final = _advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW
    _ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.ULONG),
    )
    _ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    _GetSecurityDescriptorDacl: Final = _advapi32.GetSecurityDescriptorDacl
    _GetSecurityDescriptorDacl.argtypes = (
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.BOOL),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.BOOL),
    )
    _GetSecurityDescriptorDacl.restype = wintypes.BOOL
    _SetNamedSecurityInfoW: Final = _advapi32.SetNamedSecurityInfoW
    _SetNamedSecurityInfoW.argtypes = (
        wintypes.LPCWSTR,
        ctypes.c_int,
        wintypes.DWORD,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
    )
    _SetNamedSecurityInfoW.restype = wintypes.DWORD
    _LocalFree: Final = _kernel32.LocalFree
    _LocalFree.argtypes = (ctypes.c_void_p,)
    _LocalFree.restype = ctypes.c_void_p

    def _user() -> str | None:
        """The user this process runs as, as a SID."""
        size = wintypes.DWORD()
        _GetTokenInformation(_CURRENT_PROCESS_TOKEN, _TOKEN_USER, None, 0, ctypes.byref(size))
        user = ctypes.create_string_buffer(size.value)
        if not _GetTokenInformation(_CURRENT_PROCESS_TOKEN, _TOKEN_USER, user, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        # A TOKEN_USER begins with the user's SID_AND_ATTRIBUTES, which begins with the SID.
        named = wintypes.LPWSTR()
        if not _ConvertSidToStringSidW(ctypes.c_void_p.from_buffer(user), ctypes.byref(named)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return named.value
        finally:
            _LocalFree(named)

    def _access_list(path: str) -> str | None:
        """The access list of `path`, as Windows writes it out (SDDL)."""
        descriptor, dacl = ctypes.c_void_p(), ctypes.c_void_p()
        failed = _GetNamedSecurityInfoW(
            path, _SE_FILE_OBJECT, _DACL_SECURITY_INFORMATION, None, None, ctypes.byref(dacl), None, ctypes.byref(descriptor)
        )
        if failed:
            raise ctypes.WinError(failed)
        try:
            written = wintypes.LPWSTR()
            if not _ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor, _SDDL_REVISION_1, _DACL_SECURITY_INFORMATION, ctypes.byref(written), None
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                return written.value
            finally:
                _LocalFree(written)
        finally:
            _LocalFree(descriptor)

    def _owner_only(directory: str) -> None:
        """Keep `directory`, and everything made in it from then on, to its owner, with the access list the launcher gives its state home.

        The user this process runs as, the system and the administrators, each
        with full access, handed down to what is made in it, and nothing
        inherited from above. A mode keeps nobody out on Windows; the access
        list is what does. A directory that has the list already is left as it
        is: setting a list hands it down to everything beneath, which in a state
        home is no small walk.
        """
        listed = f"D:PAI(A;OICI;FA;;;{_user()})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        if _access_list(directory) == listed:
            return
        descriptor = ctypes.c_void_p()
        if not _ConvertStringSecurityDescriptorToSecurityDescriptorW(listed, _SDDL_REVISION_1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            present, defaulted, dacl = wintypes.BOOL(), wintypes.BOOL(), ctypes.c_void_p()
            if not _GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)):
                raise ctypes.WinError(ctypes.get_last_error())
            failed = _SetNamedSecurityInfoW(
                directory, _SE_FILE_OBJECT, _DACL_SECURITY_INFORMATION | _PROTECTED_DACL_SECURITY_INFORMATION, None, None, dacl, None
            )
            if failed:
                raise ctypes.WinError(failed)
        finally:
            _LocalFree(descriptor)

else:
    import fcntl

    def _lock(descriptor: int) -> None:
        fcntl.flock(descriptor, fcntl.LOCK_EX)

    def _owner_only(directory: str) -> None:
        """Keep `directory` to its owner: mode `0700`, as the launcher keeps its state home."""
        os.chmod(directory, 0o700)


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
        """Hold the lock every writer of the document takes, from before its read until after its rename.

        The directory is kept to its owner first, as the launcher keeps its
        state home, so the file, its lock and what replaces the file are its
        owner's alone from the moment each is made.
        """
        directory = os.path.dirname(self._path) or "."
        os.makedirs(directory, exist_ok=True)
        _owner_only(directory)
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
        # A gateway admits no token from an issuer it does not trust: a token
        # that names no issuer is no sign-in.
        issuer = text_claim(sign_in.access, "iss")
        if issuer is None:
            raise SignInError("exchange", f"The sign-in to {self._key} was not kept: its access token names no issuer")
        learned = SignIn(
            token=sign_in.access,
            email=text_claim(sign_in.access, "email"),
            obtained_at=_rfc3339(time.time()),
            issuer=issuer,
            token_endpoint=sign_in.token_endpoint,
            revocation_endpoint=sign_in.revocation_endpoint,
        )

        def change(document: dict[str, JsonValue]) -> bool:
            document[self._key] = self._written(learned, sign_in.access, sign_in.refresh)
            return True

        self._store.change(change)

    def _renewed(self, read: HeldSignIn, access: str, refresh: str) -> str | None:
        given: str | None = None

        def change(document: dict[str, JsonValue]) -> bool:
            nonlocal given
            before = _sign_in_of(document.get(self._key))
            if before is None:
                return False
            # Another program renewed, or signed in again, while this renewal's
            # grant was in flight: its tokens stand. The refresh token alone does
            # not tell, since an issuer that rotates none leaves it as it was.
            if (before.token, before.refresh_token) != (read.access, read.refresh):
                given = before.token
                return False
            document[self._key] = self._written(before, access, refresh)
            given = access
            return True

        self._store.change(change)
        return given

    def _forget(self) -> None:
        self._store.change(lambda document: document.pop(self._key, None) is not None)

    @override
    async def held(self) -> HeldSignIn | None:
        return await asyncio.to_thread(self._held)

    @override
    async def keep(self, sign_in: HeldSignIn) -> None:
        await asyncio.to_thread(self._keep, sign_in)

    @override
    async def renewed(self, read: HeldSignIn, access: str, refresh: str) -> str | None:
        return await asyncio.to_thread(self._renewed, read, access, refresh)

    @override
    async def forget(self) -> None:
        await asyncio.to_thread(self._forget)
