"""A `GatewayOperations` for tests that answers only what it was told to.

An operation nobody scripted is refused, naming it: a double that answered it
with a value of its own making would hand its caller a success nobody decided
on. Every call is recorded, answered or not.
"""

from collections.abc import Sequence
from typing import Final, final, override

from semiont.errors import TransportError
from semiont.identifiers import ResourceId
from semiont.transport import GatewayOperations
from semiont.types import HealthResponse, MediaTokenResponse, ProtectedResourceMetadata, StatusResponse, UserResponse

__all__ = ["StubGateway"]


@final
class StubGateway(GatewayOperations):
    """See the module's documentation."""

    def __init__(self) -> None:
        self._current_user: UserResponse | None = None
        self._media_token: MediaTokenResponse | None = None
        self._protected_resource_metadata: ProtectedResourceMetadata | None = None
        self._health: HealthResponse | None = None
        self._status: StatusResponse | None = None
        self._calls: Final[list[str]] = []

    # ── What a test says ────────────────────────────────────────────────

    def current_user(self, answer: UserResponse) -> None:
        """What `get_current_user` answers."""
        self._current_user = answer

    def media_token(self, answer: MediaTokenResponse) -> None:
        """What `get_media_token` answers, of any resource."""
        self._media_token = answer

    def protected_resource_metadata(self, answer: ProtectedResourceMetadata) -> None:
        """What `get_protected_resource_metadata` answers."""
        self._protected_resource_metadata = answer

    def health(self, answer: HealthResponse) -> None:
        """What `health_check` answers."""
        self._health = answer

    def status(self, answer: StatusResponse) -> None:
        """What `get_status` answers."""
        self._status = answer

    @property
    def calls(self) -> Sequence[str]:
        """Every operation called, in order: its name and, when it has one, the resource it was called for (`get_media_token res-1`)."""
        return self._calls

    def _answer[T](self, operation: str, scripted: T | None, of: ResourceId | None = None) -> T:
        """Record a call of `operation` and give what was scripted for it."""
        self._calls.append(operation if of is None else f"{operation} {of}")
        if scripted is None:
            raise TransportError("error", f"StubGateway: not scripted: {operation}")
        return scripted

    # ── The gateway's own operations ────────────────────────────────────

    @override
    async def get_current_user(self) -> UserResponse:
        return self._answer("get_current_user", self._current_user)

    @override
    async def get_media_token(self, resource_id: ResourceId) -> MediaTokenResponse:
        return self._answer("get_media_token", self._media_token, resource_id)

    @override
    async def get_protected_resource_metadata(self) -> ProtectedResourceMetadata:
        return self._answer("get_protected_resource_metadata", self._protected_resource_metadata)

    @override
    async def health_check(self) -> HealthResponse:
        return self._answer("health_check", self._health)

    @override
    async def get_status(self) -> StatusResponse:
        return self._answer("get_status", self._status)
