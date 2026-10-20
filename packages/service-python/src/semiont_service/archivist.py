"""A resource's bytes and its annotations, read from the Archivist: `GET /resources/{id}/content` and `GET /resources/{id}/annotations`, as
the service's own account.

The Archivist serves the bytes of a resource's stored representation as they
are stored, under the content type they are stored with
(`specs/src/archivist/openapi.json`). Nothing between changes them, so the
checksum a service takes of what it reads is the one the record states. A
resource's annotations are read here too, not over the bus: their number
follows the document's, and a bus message is bounded.

Whatever keeps the bytes from being read is a `ContentUnread`, which says
what it was: the account could not sign in, the Archivist did not answer or
answered with a failure, or it has no such bytes. A 404 says which half of
the lookup failed, the resource or its bytes, and that is said too. Whatever
keeps the annotations from being read is an `AnnotationsUnread`, which says
the same. A failure to sign in names the service by its one word, which it
hands in.

The token is the service account's own, kept and renewed by the SDK
(`semiont.http.ServiceToken`), which is handed in. No request follows a
proxy of the environment: the address the document names is the address
asked.
"""

from collections.abc import Callable
from types import TracebackType
from typing import Final, Protocol, Self, final, override

import httpx
from pydantic import ValidationError
from semiont.errors import SemiontError
from semiont.identifiers import ResourceId
from semiont.types import GetAnnotationsResponse, RepresentationNotFound

from semiont_service.content import Content, ContentReads, ContentUnread

__all__ = ["AnnotationsUnread", "ArchivistContent", "Authorizes"]

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


@final
class AnnotationsUnread(Exception):
    """A resource's annotations could not be read: the account could not sign in, the Archivist did not answer or refused, or it holds
    no such resource."""


class Authorizes(Protocol):
    """What says who asks: the SDK's `ServiceToken` is one."""

    async def authorization(self) -> str:
        """The `Authorization` header's value. Raises `SemiontError` where the account could not sign in."""
        ...


@final
class ArchivistContent(ContentReads):
    """The Archivist at `host` and `port`, asked as the service account `account` is, for the service whose word is `service`.

    Held with `async with`: its connections are closed on the way out.
    """

    def __init__(self, service: str, *, host: str, port: int, account: Authorizes) -> None:
        self._service: Final = service
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

    async def _answer(self, path: str, what: str, unread: Callable[[str], Exception]) -> httpx.Response:
        """The Archivist's answer to a GET of `path`, asked for `what`, when it is found or is not; anything else is raised as `unread`."""
        if self._client is None:
            raise RuntimeError("the Archivist is not being read: hold it with `async with`")
        try:
            authorization = await self._account.authorization()
        except SemiontError as failure:
            raise unread(f"{what} were not asked for: the {self._service} could not sign in ({failure})") from failure
        try:
            answer = await self._client.get(path, headers={"Authorization": authorization})
        except httpx.HTTPError as failure:
            unanswered = f"{type(failure).__name__}: {failure}"
            raise unread(f"the Archivist did not answer for {what}: {unanswered}") from failure
        if answer.status_code not in (_OK, _NOT_FOUND):
            raise unread(f"the Archivist answered {answer.status_code} for {what}")
        return answer

    @override
    async def read(self, resource_id: ResourceId) -> Content:
        answer = await self._answer(f"/resources/{resource_id}/content", f"the bytes of {resource_id}", ContentUnread)
        if answer.status_code == _NOT_FOUND:
            raise ContentUnread(f"the Archivist has no bytes for {resource_id}: {_missing(answer.content)}")
        content_type = answer.headers.get("content-type")
        if content_type is None:
            raise ContentUnread(f"the Archivist stated no content type for the bytes of {resource_id}")
        return Content(answer.content, content_type)

    async def read_annotations(self, resource_id: ResourceId) -> GetAnnotationsResponse:
        """Every annotation on a resource, as the record's view holds them. Raises `AnnotationsUnread` where they were not read."""
        what = f"the annotations of {resource_id}"
        answer = await self._answer(f"/resources/{resource_id}/annotations", what, AnnotationsUnread)
        if answer.status_code == _NOT_FOUND:
            raise AnnotationsUnread(f"the Archivist has no annotations of {resource_id}: the record holds no such resource")
        try:
            return GetAnnotationsResponse.model_validate_json(answer.content)
        except ValidationError as failure:
            raise AnnotationsUnread(f"the Archivist's answer for {what} is no list of annotations: {failure}") from failure
