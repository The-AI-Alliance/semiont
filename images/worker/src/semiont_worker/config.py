"""What of the worker's configuration is the Worker's own: what the service is called, and each engine's key.

The document is the protocol's `WorkerConfig`. It is found, read and refused
as every Python service's is (`semiont_service.config`), and so is the
service's account. A secret is never in the document. The document names the
variable that holds an engine's key, and the environment is read for it here.
`docs/protocol/WORKER-SERVICE.md` § Configuration states each refusal.
"""

from collections.abc import Mapping
from typing import Final

from semiont.types import WorkerConfig
from semiont_service.config import Refused, set_in

SERVICE: Final = "worker"
"""What the service is called among a knowledge base's services, as its image and its container are named."""


def api_key_of(config: WorkerConfig, index: int, environment: Mapping[str, str]) -> str | None:
    """The key of the engine at `index`, read from the variable the document names for it.

    An engine whose provider takes no key names no variable and has none. The
    refusal says which member named the variable and never what it named.
    """
    name = config.agents[index].api_key_env
    if name is None:
        return None
    key = set_in(environment, name)
    if key is None:
        raise Refused(f"agents[{index}].apiKeyEnv names a variable that is not set in the worker's environment")
    return key
