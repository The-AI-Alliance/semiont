"""System: what the knowledge base says about itself."""

from typing import Final, final

from semiont.transport import GatewayOperations
from semiont.types import HealthResponse, StatusResponse

__all__ = ["SystemNamespace"]


@final
class SystemNamespace:
    """See the module's documentation."""

    def __init__(self, gateway: GatewayOperations) -> None:
        self._gateway: Final = gateway

    async def health_check(self) -> HealthResponse:
        """Whether the gateway is up."""
        return await self._gateway.health_check()

    async def status(self) -> StatusResponse:
        """The knowledge base's version and features, and who the caller is to it."""
        return await self._gateway.get_status()
