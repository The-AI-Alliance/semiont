"""The one seam to Apache TinkerPop's Gremlin client (`gremlinpython`), which both Gremlin stores ask through.

The library states no types, so it is never imported by name: a checker
could read nothing of such an import. What a store asks of it is stated
here, as protocols, and its client class is looked up where a client is
opened.

A store asks in Gremlin script text with bindings, so that a value is never
part of a script. What the server answers is trusted in nothing: it is held
to be a list here, and each store validates what the list holds into the
shape it reads.

The client is synchronous, and runs an event loop of its own to speak to the
server, so it cannot be asked on a thread whose loop is running. Nothing
here waits for a loop: each store runs these calls off its own, at one place.

What it leans on in the library: `gremlin_python.driver.client.Client`, made
with a URL, the name of a traversal source and `pool_size`; the client's
`submit(message, bindings)`, whose answer's `all()` is a
`concurrent.futures.Future` of every result; and the client's `close()`.

No traversal is stated here. Each store's are its own.
"""

import importlib
from collections.abc import Callable, Mapping
from concurrent.futures import Future
from typing import Final, Protocol

from pydantic import TypeAdapter

_RESULTS: Final = TypeAdapter[list[object]](list[object])


class _Submitted(Protocol):
    """What the server answers one script, as it arrives."""

    def all(self) -> Future[object]: ...


class GremlinClient(Protocol):
    """What a store asks of the library's client."""

    def submit(self, message: str, bindings: Mapping[str, object]) -> _Submitted: ...

    def close(self) -> None: ...


class _ClientClass(Protocol):
    """The library's `Client`, as a store makes one."""

    def __call__(self, url: str, traversal_source: str, *, pool_size: int) -> GremlinClient: ...


def gremlin_client(store: str) -> Callable[[str], GremlinClient]:
    """How the store named opens a client: given a URL, a client with one connection to the server there.

    The library is imported here, which is when a store's module is. Raises
    `ModuleNotFoundError` naming the store's extra where it is not installed.
    """
    try:
        # The library itself first: it is what is missing where the extra is not installed. Its client's module is
        # imported after it, so that something that module lacks is reported as itself.
        importlib.import_module("gremlin_python")
    except ModuleNotFoundError as missing:
        if missing.name != "gremlin_python":
            raise
        raise ModuleNotFoundError(
            f"The {store} store needs Apache TinkerPop's `gremlinpython` client, which is not installed. "
            f"It comes with the extra: install `semiont-graph[{store}]`.",
            name=missing.name,
        ) from missing
    library = importlib.import_module("gremlin_python.driver.client")

    def opened(url: str) -> GremlinClient:
        # One connection, and so one worker thread of the client's own: what a store asks is answered in the order asked.
        client: _ClientClass = vars(library)["Client"]
        return client(url, "g", pool_size=1)

    return opened


def answered(client: GremlinClient, script: str, bindings: Mapping[str, object]) -> list[object]:
    """Every result the server answers one script. It waits for them, so a store calls it off its loop."""
    return _RESULTS.validate_python(client.submit(script, bindings).all().result())
