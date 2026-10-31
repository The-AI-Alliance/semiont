"""What of the worker's configuration is the Worker's own: the service's name, that it serves a knowledge base once, each engine's key.

The document is the protocol's `WorkerConfig`. It is found, read and refused
as every Python service's is (`semiont_service.config`), and so is the key the
service signs in with. A secret is never in the document. The document names
the variable that holds an engine's key, and the environment is read for it
here. `docs/protocol/WORKER-SERVICE.md` § Configuration states each refusal.
"""

from collections.abc import Mapping
from typing import Final

from semiont.types import WorkerConfig
from semiont_service.config import Refused, set_in

SERVICE: Final = "worker"
"""What the service is called among a knowledge base's services, as its image and its container are named."""


def served_once(config: WorkerConfig) -> None:
    """Refuse a document in which two knowledge bases name one domain: the service is one agent at a knowledge base.

    The refusal names the later entry and the earlier by their places, and no
    domain.
    """
    first_named_at: dict[str, int] = {}
    for at, knowledge_base in enumerate(config.knowledge_bases):
        earlier = first_named_at.setdefault(knowledge_base.domain, at)
        if earlier != at:
            raise Refused(f"knowledgeBases[{at}].domain is the domain of knowledgeBases[{earlier}]: a worker serves a knowledge base once")


def api_key_of(config: WorkerConfig, knowledge_base: int, index: int, environment: Mapping[str, str]) -> str | None:
    """The key of the engine at `index` of the knowledge base at `knowledge_base`, read from the variable the document names for it.

    An engine whose provider takes no key names no variable and has none. The
    refusal says which member named the variable and never what it named.
    """
    name = config.knowledge_bases[knowledge_base].engines[index].api_key_env
    if name is None:
        return None
    key = set_in(environment, name)
    if key is None:
        raise Refused(
            f"knowledgeBases[{knowledge_base}].engines[{index}].apiKeyEnv names a variable that is not set in the worker's environment"
        )
    return key
