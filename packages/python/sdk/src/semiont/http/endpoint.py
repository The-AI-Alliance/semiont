"""A knowledge base's gateway as its HTTP endpoint names it.

Its origin is what a session sends its requests to and opens its stream at,
and every SDK makes it alike (specs/src/session/gateway-url-cases.json).
"""

import re
from typing import Final

from semiont.types import HttpEndpoint

__all__ = ["gateway_url", "is_valid_hostname"]

_LABEL: Final = re.compile(r"[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?")


def is_valid_hostname(host: str) -> bool:
    """Whether `host` is a host's name.

    That is labels of ASCII letters, digits and hyphens with a dot between
    each two, every label 1 to 63 characters long and none beginning or
    ending with a hyphen. `localhost` and a dotted address are such names; a
    host with a slash, a colon or a query is not.
    """
    return all(_LABEL.fullmatch(label) for label in host.split("."))


def gateway_url(endpoint: HttpEndpoint) -> str:
    """The origin of the gateway: the protocol, the host in lowercase and nothing else done to it, and the port.

    Raises `ValueError` when the host is not a host's name: a name a person
    typed is never put into a URL unread.
    """
    if not is_valid_hostname(endpoint.host):
        raise ValueError(f'Invalid KB hostname: "{endpoint.host}"')
    return f"{endpoint.protocol}://{endpoint.host.lower()}:{endpoint.port}"
