"""What the tests of the two Gremlin stores share: a client that keeps no graph, and what the stores are given to write.

The client stands where the library's own `Client` does. It records each
script it is asked, with what the script binds, and answers what a test says
that script is answered. It filters nothing and follows no edge, so what a
test reads is what a store asked, and what the store made of an answer. No
case here says anything of a server: neither store has run against one.

The library's client cannot be asked on a thread whose loop is running, and
this one refuses to be. A store that asked on its loop would pass on a
client that did not mind, and fail on a server.
"""

import asyncio
import importlib
import subprocess
import sys
from collections.abc import Callable, Mapping
from concurrent.futures import Future
from typing import Final, final

import pytest
from contract import annotation, link, resource
from pydantic import JsonValue
from semiont.identifiers import AnnotationId, ResourceId

type Answers = Callable[[str, Mapping[str, object]], list[object]]
"""What a script, with what it binds, is answered."""

ON = ResourceId("res-1")
TO = ResourceId("res-2")
STORAGE_URI = "file:///kb/res-1.md"
QUOTE: dict[str, JsonValue] = {"type": "TextQuoteSelector", "exact": "Black Hawk", "prefix": "", "suffix": ""}

# A reference on a whole resource: its target has a source and no selector.
SOURCE_ONLY = annotation(AnnotationId("ann-source-only"), ON, "linking", target={"source": ON}, body=[link(TO)])
HIGHLIGHT = annotation(AnnotationId("ann-highlight"), ON, "highlighting", target={"source": ON, "selector": QUOTE})

# The storage location is the representation's, and not the resource's.
RESOURCE = resource(
    ON,
    name="Cedar County, Iowa",
    entityTypes=["Place"],
    representations=[{"mediaType": "text/markdown", "checksum": "sha256:abc", "rel": "original", "storageUri": STORAGE_URI}],
    dateCreated="2026-08-22T10:00:00.000Z",
)
RESOURCE_WITHOUT_STORAGE = resource(
    ON,
    name="Cedar County, Iowa",
    entityTypes=["Place"],
    representations=[{"mediaType": "text/markdown", "checksum": "sha256:abc", "rel": "original"}],
    dateCreated="2026-08-22T10:00:00.000Z",
)


def nothing(script: str, bindings: Mapping[str, object]) -> list[object]:
    """What a server that holds nothing answers."""
    del script, bindings
    return []


def table(answers: Mapping[str, list[object]]) -> Answers:
    """Each of those scripts answered as stated, whatever it binds, and every other with nothing."""

    def answered(script: str, bindings: Mapping[str, object]) -> list[object]:
        del bindings
        return answers.get(script, [])

    return answered


def _off_the_loop() -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    raise AssertionError("the client was asked on a thread whose loop is running, where the library's cannot be")


@final
class _Answered:
    """What a script was answered, as the library hands it back: every result, by way of a future."""

    def __init__(self, results: list[object]) -> None:
        self._results: Final = results

    def all(self) -> Future[object]:
        future: Future[object] = Future()
        future.set_result(self._results)
        return future


@final
class FakeGremlin:
    """A Gremlin client that keeps no graph. See the module's documentation."""

    def __init__(self) -> None:
        self.answers: Answers = nothing
        self.opened: list[tuple[str, str, int]] = []
        self.asked: list[tuple[str, dict[str, object]]] = []
        self.closed = 0

    def client(self, url: str, traversal_source: str, *, pool_size: int) -> "FakeGremlin":
        """What stands for the library's `Client` class: called as that is, it answers this client."""
        self.opened.append((url, traversal_source, pool_size))
        return self

    def submit(self, message: str, bindings: Mapping[str, object]) -> _Answered:
        _off_the_loop()
        self.asked.append((message, dict(bindings)))
        return _Answered(self.answers(message, bindings))

    def close(self) -> None:
        _off_the_loop()
        self.closed += 1

    def bound(self, script: str) -> list[dict[str, object]]:
        """What that script bound, each time it was asked."""
        return [bindings for asked, bindings in self.asked if asked == script]

    def added(self, label: str) -> list[dict[str, object]]:
        """The properties of each vertex of that label a store has asked to add."""
        return [set_by(bindings) for asked, bindings in self.asked if asked.startswith(f"g.addV('{label}')")]


def replacing_the_client(monkeypatch: pytest.MonkeyPatch) -> FakeGremlin:
    """A client that keeps no graph, where a store finds the library's own."""
    fake = FakeGremlin()
    monkeypatch.setattr(importlib.import_module("gremlin_python.driver.client"), "Client", fake.client)
    return fake


def set_by(bindings: Mapping[str, object]) -> dict[str, object]:
    """The properties a script sets, by their names: what it binds for each, without the `p_` a property's value is bound under."""
    return {name.removeprefix("p_"): value for name, value in bindings.items() if name.startswith("p_")}


def setting(properties: Mapping[str, object]) -> str:
    """The steps that set each of those properties, and no other."""
    return "".join(f".property('{name}', p_{name})" for name in properties)


def vertex(properties: Mapping[str, object]) -> dict[str, list[object]]:
    """Properties as `valueMap()` answers them: each a list of its values."""
    return {name: [value] for name, value in properties.items()}


def alone(program: str) -> str:
    """What `program` printed, run by an interpreter of its own: what it imports is what it asked for itself."""
    ran = subprocess.run([sys.executable, "-c", program], capture_output=True, text=True, check=False)
    assert ran.returncode == 0, ran.stderr
    return ran.stdout


def without_the_library(store: str) -> str:
    """A program that imports a store's module where the client's library is not installed, and prints how that failed."""
    return f"""
import sys

sys.modules["gremlin_python"] = None  # as an interpreter has it where the library is not installed
from semiont_graph.memory import MemoryGraphDatabase

try:
    import semiont_graph.{store}
except ModuleNotFoundError as missing:
    print(type(missing).__name__, "|", missing.name, "|", type(missing.__cause__).__name__, "|", missing)
print(MemoryGraphDatabase().is_connected())
"""
