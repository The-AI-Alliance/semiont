"""What of the Smelter's configuration is the Smelter's own: its name, the index it refuses, and its embedding provider's key.

The document is the protocol's `SmelterConfig`. It is found, read and refused
as every Python service's is (`semiont_service.config`), and so is the
service's account. A secret is never in the document. The document names the
variable that holds an embedding provider's key, and the environment is read
for it here. `docs/protocol/SMELTER.md` § Settings states each refusal.
"""

from collections.abc import Mapping
from typing import Final

from semiont.types import MemoryVectorsConfig, SmelterConfig, VoyageEmbeddingConfig
from semiont_service.config import Refused, read_config, set_in

__all__ = ["SERVICE", "embedding_key_of", "read_smelter_config"]

SERVICE: Final = "smelter"
"""What the service is called among a knowledge base's services, as its image and its container are named."""


def read_smelter_config(path: str) -> SmelterConfig:
    """The document at `path`: read, and held to its schema before it is believed.

    An index held in one process's memory is a kind the schema has, and a
    Smelter refuses it: nothing else could search it.
    """
    config = read_config(SERVICE, SmelterConfig, path)
    if isinstance(config.vectors, MemoryVectorsConfig):
        raise Refused("vectors.type is memory: an index held in the smelter's own memory could not be searched by anything else")
    return config


def embedding_key_of(config: SmelterConfig, environment: Mapping[str, str]) -> str | None:
    """The embedding provider's key, read from the variable the document names for it. Nothing for a provider that takes none.

    The refusal names the variable. A variable's name is no secret, and is
    what an operator has to set.
    """
    embedding = config.embedding
    if not isinstance(embedding, VoyageEmbeddingConfig):
        return None
    key = set_in(environment, embedding.api_key_env)
    if key is None:
        raise Refused(f"embedding.apiKeyEnv names {embedding.api_key_env}, which is not set in the smelter's environment")
    return key
