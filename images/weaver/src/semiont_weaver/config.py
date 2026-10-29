"""What of the Weaver's configuration is the Weaver's own: its name, the graph it refuses, and its graph database's password.

The document is the protocol's `WeaverConfig`. It is found, read and refused
as every Python service's is (`semiont_service.config`), and so is the
service's account. A secret is never in the document. The document names the
variable that holds the graph database's password, and the environment is
read for it here. `docs/protocol/WEAVER.md` § Settings states each refusal.
"""

from collections.abc import Mapping
from typing import Final

from semiont.types import MemoryGraphConfig, Neo4jGraphConfig, WeaverConfig
from semiont_service.config import Refused, read_config, set_in

__all__ = ["SERVICE", "graph_password_of", "read_weaver_config"]

SERVICE: Final = "weaver"
"""What the service is called among a knowledge base's services, as its image and its container are named."""


def read_weaver_config(path: str) -> WeaverConfig:
    """The document at `path`: read, and held to its schema before it is believed.

    A graph held in one process's memory is a kind the schema has, and a
    Weaver refuses it: it could not be shared with a reader of the graph.
    """
    config = read_config(SERVICE, WeaverConfig, path)
    if isinstance(config.graph, MemoryGraphConfig):
        raise Refused("graph.type is memory: a graph held in the weaver's own memory could not be shared with a reader of the graph")
    return config


def graph_password_of(config: WeaverConfig, environment: Mapping[str, str]) -> str | None:
    """The graph database's password, read from the variable the document names for it. Nothing for a database that takes none.

    The refusal names the variable. A variable's name is no secret, and is
    what an operator has to set.
    """
    graph = config.graph
    if not isinstance(graph, Neo4jGraphConfig):
        return None
    password = set_in(environment, graph.password_env)
    if password is None:
        raise Refused(f"graph.passwordEnv names {graph.password_env}, which is not set in the weaver's environment")
    return password
