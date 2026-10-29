"""Auth: the gateway's view of who is signed in.

Signing in happens at the issuer. This only asks the gateway what it sees.
"""

from typing import Final, final

from semiont.identifiers import ResourceId
from semiont.transport import GatewayOperations
from semiont.types import MediaTokenResponse, ProtectedResourceMetadata, UserResponse

__all__ = ["AuthNamespace"]


@final
class AuthNamespace:
    """See the module's documentation."""

    def __init__(self, gateway: GatewayOperations) -> None:
        self._gateway: Final = gateway

    async def me(self) -> UserResponse:
        """The signed-in principal."""
        return await self._gateway.get_current_user()

    async def media_token(self, resource_id: ResourceId) -> MediaTokenResponse:
        """A token that lets a browser fetch one resource's bytes."""
        return await self._gateway.get_media_token(resource_id)

    async def protected_resource_metadata(self) -> ProtectedResourceMetadata:
        """Which issuer the knowledge base trusts: where to send someone to sign in."""
        return await self._gateway.get_protected_resource_metadata()
