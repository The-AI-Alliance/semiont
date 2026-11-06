"""When a registry takes two endpoints for one place.

`protocol/specs/src/session/registry-cases.json` holds the rule, for this and
for every other SDK.
"""

from semiont.types import HttpEndpoint, KbEndpoint


def same_place(one: KbEndpoint, other: KbEndpoint) -> bool:
    """Whether two endpoints are one place.

    For a gateway, its origin: the protocol, the host in lowercase and the port.
    For a loaded knowledge base, its id.
    """
    if isinstance(one, HttpEndpoint):
        return (
            isinstance(other, HttpEndpoint)
            and one.protocol == other.protocol
            and one.host.lower() == other.host.lower()
            and one.port == other.port
        )
    return not isinstance(other, HttpEndpoint) and one.kb_id == other.kb_id
