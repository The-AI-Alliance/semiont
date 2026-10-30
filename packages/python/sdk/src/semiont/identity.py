"""How a knowledge base is named, and the principals who act in it.

Every function here is held to a case table every implementation runs: the
knowledge base's own names to `specs/src/kb-identity/cases.json`, the rest to
`specs/src/principals/cases.json`.
"""

from typing import Final
from urllib.parse import quote

from semiont.identifiers import UserId

__all__ = ["agent_did", "encode_uri_component", "engine_name", "kb_did", "kb_resource", "person_did"]

# What ECMAScript's `encodeURIComponent` leaves alone, beside letters and digits.
_UNRESERVED: Final = "-_.!~*'()"


def encode_uri_component(value: str) -> str:
    """`value` as `encodeURIComponent` writes it: each UTF-8 byte of every other character as `%XX`, in uppercase hex."""
    return quote(value, safe=_UNRESERVED)


def kb_did(domain: str) -> UserId:
    """The knowledge base's DID: `did:web:` and its domain as it is, which is already a colon path."""
    return UserId(f"did:web:{domain}")


def kb_resource(domain: str) -> str:
    """The knowledge base's resource identifier, the audience its tokens carry: its DID as an https URL."""
    return f"https://{domain.replace(':', '/')}"


def person_did(domain: str, subject: str) -> UserId:
    """A person, named by the subject the issuer asserted."""
    return UserId(f"did:web:{domain}:users:{encode_uri_component(subject)}")


def agent_did(domain: str, subject: str) -> UserId:
    """An agent, named by the subject its issuer asserted for its account, as a person is."""
    return UserId(f"did:web:{domain}:agents:{encode_uri_component(subject)}")


def engine_name(provider: str, model: str) -> str:
    """An engine's name — a provider and a model, which is no principal — as a worker states it of itself."""
    return f"{provider} {model}"
