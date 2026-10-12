"""A resource's bytes, read from the Archivist: `GET /resources/{id}/content`, as the Smelter's service account.

The Archivist serves the bytes of a resource's stored representation as they
are stored, under the content type they are stored with
(`specs/src/archivist/openapi.json`). Nothing between changes them, so the
checksum a Smelter takes of what it reads is the one the record states.

Whatever keeps the bytes from being read is a `ContentUnread`, which says
what it was: the account could not sign in, the Archivist did not answer or
answered with a failure, or it has no such bytes. A 404 says which half of
the lookup failed, the resource or its bytes, and that is said too.

The token is the service account's own, kept and renewed by the SDK
(`semiont.http.ServiceToken`), which is handed in. No request follows a
proxy of the environment: the address the document names is the address
asked.
"""

from types import TracebackType
from typing import Final, Protocol, Self, final, override

import httpx
from pydantic import ValidationError
from semiont.errors import SemiontError
from semiont.identifiers import ResourceId
from semiont.types import RepresentationNotFound

from semiont_smelter.content import Content, ContentReads, ContentUnread

__all__ = ["ArchivistContent", "Authorizes"]

_TIMEOUT: Final = httpx.Timeout(60.0, connect=10.0)
"""How long the Archivist is waited for: ten seconds to connect, and a minute for each part of an answer to come.

No bound is put on a whole answer: a large document takes as long as it
takes, as long as it keeps coming.
"""

_NOT_FOUND: Final = 404
_OK: Final = 200


def _missing(answer: bytes) -> str:
    """Which half of the lookup an Archivist's 404 says failed."""
    try:
        code = RepresentationNotFound.model_validate_json(answer).code
    except ValidationError:
        return "the Archivist answered 404, and did not say whether the resource or its bytes are missing"
    return "the record holds no such resource" if code == "resource" else "the record holds the resource and not its bytes"


class Authorizes(Protocol):
    """What says who asks: the SDK's `ServiceToken` is one."""

    async def authorization(self) -> str:
        """The `Authorization` header's value. Raises `SemiontError` where the account could not sign in."""
        ...


@final
class ArchivistContent(ContentReads):
    """The Archivist at `host` and `port`, asked as the service account `account` is.

    Held with `async with`: its connections are closed on the way out.
    """

    def __init__(self, *, host: str, port: int, account: Authorizes) -> None:
        self._origin: Final = f"http://{host}:{port}"
        self._account: Final = account
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> Self:
        self._client = httpx.AsyncClient(base_url=self._origin, timeout=_TIMEOUT, trust_env=False)
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    @override
    async def read(self, resource_id: ResourceId) -> Content:
        if self._client is None:
            raise RuntimeError("the Archivist is not being read: hold it with `async with`")
        try:
            authorization = await self._account.authorization()
        except SemiontError as failure:
            raise ContentUnread(f"the bytes of {resource_id} were not asked for: the smelter could not sign in ({failure})") from failure
        try:
            answer = await self._client.get(f"/resources/{resource_id}/content", headers={"Authorization": authorization})
        except httpx.HTTPError as failure:
            unanswered = f"{type(failure).__name__}: {failure}"
            raise ContentUnread(f"the Archivist did not answer for the bytes of {resource_id}: {unanswered}") from failure
        if answer.status_code == _NOT_FOUND:
            raise ContentUnread(f"the Archivist has no bytes for {resource_id}: {_missing(answer.content)}")
        if answer.status_code != _OK:
            raise ContentUnread(f"the Archivist answered {answer.status_code} for the bytes of {resource_id}")
        content_type = answer.headers.get("content-type")
        if content_type is None:
            raise ContentUnread(f"the Archivist stated no content type for the bytes of {resource_id}")
        return Content(answer.content, content_type)
