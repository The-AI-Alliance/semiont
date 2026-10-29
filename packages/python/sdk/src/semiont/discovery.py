"""The knowledge bases a launcher manages, as the launcher publishes them (`specs/src/discovery`).

What the document says, read whole or not at all, and what changed since it
was last read.

**Absent is not empty.** `Absent` is "no launcher was found", with why;
`Managed` with no knowledge bases is "the launcher is here and manages
nothing". A reader shows the two differently and never has to work out which
it has.

**A document is read whole.** One of a version this client does not speak,
or with an entry that is not what the schema says, is `Absent`: a partial
reading would hide a running knowledge base without a trace.

**The address is the key.** Entries are told apart by host and port, which
the launcher keeps unique. A did is not unique: one knowledge base running in
two places is two entries with one did, and each is its own. Two entries at
one address cannot both be true, and are named in `DiscoveryDiff.duplicated`
for a reader to show rather than merged.

Where the document is read from is a `DiscoveryTransport`: `text_discovery`
is one over any way of getting the text, and `semiont.http.discovery` has
one over a URL. Discovery only describes: signing in to a knowledge base it
lists is a person's act.
"""

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Final, Literal, Protocol, final, override

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont.types import DiscoveredKB, DiscoveryDocument

__all__ = [
    "DISCOVERY_INTERVAL",
    "Absent",
    "DiscoveryAbsentReason",
    "DiscoveryDiff",
    "DiscoveryRead",
    "DiscoveryState",
    "DiscoveryTransport",
    "Managed",
    "Unchanged",
    "parse_discovery_document",
    "subscribe_discovery",
    "text_discovery",
]

DISCOVERY_INTERVAL: Final = 5.0
"""How often a launcher's document is read again, in seconds, unless a caller says otherwise."""

_VERSION: Final = 1
"""The version of the document this client reads."""

_JSON: Final = TypeAdapter[JsonValue](JsonValue)

type DiscoveryAbsentReason = Literal["not-found", "not-json", "invalid", "unsupported-version", "unreadable"]
"""Why no launcher was found: there is no document there (`not-found`); there is one, and it is not JSON
(`not-json`); it is JSON, and not a discovery document (`invalid`); it is of a version this client does not
speak (`unsupported-version`); it could not be read at all (`unreadable`)."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Absent:
    """No launcher was found, and why."""

    reason: DiscoveryAbsentReason
    diagnostic: str | None = None
    """What was wrong, in words; none when there is no more to say."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Managed:
    """The knowledge bases a launcher manages: none is a launcher that manages nothing."""

    kbs: tuple[DiscoveredKB, ...]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Unchanged:
    """A read that found nothing changed since the last."""


type DiscoveryState = Absent | Managed
"""What a launcher's document says."""

type DiscoveryRead = Absent | Managed | Unchanged
"""What one read gave: a state, or that nothing changed since the last."""


class DiscoveryTransport(Protocol):
    """Where the document is read from."""

    async def read(self) -> DiscoveryRead:
        """Read the document once."""
        ...


def _where(location: tuple[int | str, ...]) -> str:
    """A place in the document, as `kbs[1].did` names one."""
    return "".join(f"[{step}]" if isinstance(step, int) else f".{step}" for step in location).removeprefix(".")


def parse_discovery_document(text: str) -> DiscoveryState:
    """The document's text as a state. Every reader goes through this."""
    try:
        parsed = _JSON.validate_json(text)
    except ValidationError as error:
        return Absent(reason="not-json", diagnostic=error.errors()[0]["msg"])
    if not isinstance(parsed, dict):
        return Absent(reason="invalid", diagnostic="document is not an object")
    version = parsed.get("version")
    if isinstance(version, bool) or not isinstance(version, int):
        return Absent(reason="invalid", diagnostic='missing numeric "version"')
    if version != _VERSION:
        return Absent(
            reason="unsupported-version",
            diagnostic=f"discovery document version {version} is not the one this client speaks ({_VERSION}); it is not read in part",
        )
    try:
        # Strictly: a port written as text, or a name written as a number, is not the schema's.
        document = DiscoveryDocument.model_validate_json(text, strict=True)
    except ValidationError as error:
        first = error.errors()[0]
        return Absent(reason="invalid", diagnostic=f"{_where(first['loc'])}: {first['msg']}")
    for kb in document.kbs:
        if not 1 <= kb.port <= 65535:
            return Absent(reason="invalid", diagnostic=f"kb entry at {kb.host} has port {kb.port}, which is not a port")
    return Managed(kbs=tuple(document.kbs))


@final
class _TextDiscovery(DiscoveryTransport):
    def __init__(self, read: Callable[[], Awaitable[str]]) -> None:
        self._read: Final = read

    @override
    async def read(self) -> DiscoveryRead:
        try:
            text = await self._read()
        except FileNotFoundError:
            return Absent(reason="not-found")
        except (OSError, UnicodeDecodeError) as error:
            return Absent(reason="unreadable", diagnostic=str(error))
        return parse_discovery_document(text)


def text_discovery(read: Callable[[], Awaitable[str]]) -> DiscoveryTransport:
    """A transport over any way of getting the document's text.

    `read` gives the text, raises `FileNotFoundError` when there is no
    document, and another `OSError`, or `UnicodeDecodeError` for text that is
    not UTF-8, when it could not be read. Reading the launcher's file with
    `Path.read_text` fails each of those ways.
    """
    return _TextDiscovery(read)


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class DiscoveryDiff:
    """What one read changed: the state now, and what was added, changed and removed since the last one told of."""

    state: DiscoveryState
    added: tuple[DiscoveredKB, ...]
    updated: tuple[DiscoveredKB, ...]
    removed: tuple[DiscoveredKB, ...]
    duplicated: tuple[str, ...]
    """The addresses more than one entry claims, each once. At most one claim can be true; every claimant is in `state`."""


def _address(kb: DiscoveredKB) -> str:
    return f"{kb.host}:{kb.port}"


def _kbs_of(state: DiscoveryState | None) -> Sequence[DiscoveredKB]:
    """The knowledge bases a state lists: none when it is absent, or when there is no state."""
    return state.kbs if isinstance(state, Managed) else ()


def _diff(last: DiscoveryState | None, next_state: DiscoveryState) -> DiscoveryDiff | None:
    """What changed between `last`, the state last told of (none when none was), and `next_state`; none when nothing did."""
    before_kbs, after_kbs = _kbs_of(last), _kbs_of(next_state)
    before = {_address(kb): kb for kb in before_kbs}
    after = {_address(kb) for kb in after_kbs}

    added: list[DiscoveredKB] = []
    updated: list[DiscoveredKB] = []
    duplicated: list[str] = []
    claimed: dict[str, int] = {}
    for kb in after_kbs:
        at = _address(kb)
        claimed[at] = claimed.get(at, 0) + 1
        if claimed[at] == 2:
            duplicated.append(at)
        was = before.get(at)
        if was is None:
            added.append(kb)
        elif was != kb:
            updated.append(kb)
    removed = [kb for kb in before_kbs if _address(kb) not in after]

    match last, next_state:
        case Managed(), Managed():
            state_changed = False
        case Absent(reason=why_before), Absent(reason=why_now):
            state_changed = why_before != why_now
        case _:
            state_changed = True
    if not (state_changed or added or updated or removed):
        return None
    return DiscoveryDiff(state=next_state, added=tuple(added), updated=tuple(updated), removed=tuple(removed), duplicated=tuple(duplicated))


async def subscribe_discovery(transport: DiscoveryTransport, interval: float) -> AsyncGenerator[DiscoveryDiff]:
    """Read a launcher's document now and then every `interval` seconds, and tell of each change.

    The first read is always told of. After it, a read that changed nothing
    is not: only an entry added, changed or removed, and a change of state,
    which carries every entry it brought or took away. Each iteration reads on
    its own, and reading stops when its reader stops: it reads only while it
    is being iterated, and closing it (`aclose`) ends it.
    """
    last: DiscoveryState | None = None
    while True:
        match await transport.read():
            case Unchanged():
                pass
            case Absent() | Managed() as state:
                change = _diff(last, state)
                if change is not None:
                    last = change.state
                    yield change
        await asyncio.sleep(interval)
