"""The in-memory store, held to the contract every store is."""

from typing import final, override

from contract import GraphContract

from semiont_graph.interface import GraphDatabase
from semiont_graph.memory import MemoryGraphDatabase


@final
class TestMemoryGraph(GraphContract):
    @override
    def make(self) -> GraphDatabase:
        return MemoryGraphDatabase()


def test_two_stores_hold_two_graphs() -> None:
    # It is why no deployment is configured with it: a graph in one process is no other's.
    assert MemoryGraphDatabase() is not MemoryGraphDatabase()
