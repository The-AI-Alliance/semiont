"""A launcher's discovery document over HTTP, as `semiont.discovery`'s transport.

It is read with the tag of the last good document, so a document that has not
changed is not sent again, and read as absent when what is at the URL is not
JSON, which is what a server that answers every path with its own page gives.
"""

import asyncio
from typing import Final, final, override

import httpx

from semiont.discovery import Absent, DiscoveryRead, DiscoveryTransport, Managed, Unchanged, parse_discovery_document
from semiont.http._withheld import why_unanswered
from semiont.timing import HTTP_REQUEST_TIMEOUT_MS

__all__ = ["http_discovery"]


@final
class _HttpDiscovery(DiscoveryTransport):
    def __init__(self, url: str) -> None:
        self._url: Final = url
        self._etag: str | None = None
        """The tag of the last document that read as managed; none when that document had none, or none has."""

    @override
    async def read(self) -> DiscoveryRead:
        headers = {} if self._etag is None else {"If-None-Match": self._etag}
        try:
            # With a deadline: a read that is never answered would hold the
            # poll that awaits it, and every poll after it, for good.
            async with (
                httpx.AsyncClient(timeout=None, trust_env=False, follow_redirects=True) as http,
                asyncio.timeout(HTTP_REQUEST_TIMEOUT_MS / 1000),
            ):
                response = await http.get(self._url, headers=headers)
        except TimeoutError:
            return Absent(reason="unreadable", diagnostic=f"the document was not served within {HTTP_REQUEST_TIMEOUT_MS // 1000}s")
        except httpx.HTTPError as error:
            return Absent(reason="unreadable", diagnostic=why_unanswered(error))
        if response.status_code == 304:
            return Unchanged()
        if not response.is_success:
            return Absent(reason="not-found", diagnostic=f"HTTP {response.status_code}")
        content_type = response.headers.get("content-type", "")
        if "json" not in content_type.lower():
            return Absent(reason="not-found", diagnostic=f'the content type is "{content_type}", not JSON')
        state = parse_discovery_document(response.text)
        # Only a good document's tag is kept: one kept for a document that did
        # not read would have this believe it for good.
        if isinstance(state, Managed):
            self._etag = response.headers.get("etag")
        return state


def http_discovery(url: str) -> DiscoveryTransport:
    """A transport that reads the discovery document at `url`, each read within the timing table's request deadline.

    A redirect is followed. Like every client this package makes of HTTP, it
    reads no environment variable.
    """
    return _HttpDiscovery(url)
