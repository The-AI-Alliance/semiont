"""How a knowledge base is named, and the principals who act in it.

Every function here is held to a case table every implementation runs: the
knowledge base's own names to `specs/src/kb-identity/cases.json`, the rest to
`specs/src/principals/cases.json`.
"""

import re
from typing import Final
from urllib.parse import quote

from semiont.identifiers import UserId

__all__ = ["agent_address", "agent_did", "agent_name", "encode_uri_component", "kb_did", "kb_resource", "person_did"]

# What ECMAScript's `encodeURIComponent` leaves alone, beside letters and digits.
_UNRESERVED: Final = "-_.!~*'()"
_NOT_OF_AN_ADDRESS: Final = re.compile(r"[^A-Za-z0-9]+")


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


def agent_did(domain: str, provider: str, model: str) -> UserId:
    """A software agent: one per provider and model, under the knowledge base's domain."""
    return UserId(f"did:web:{domain}:agents:{encode_uri_component(provider)}:{encode_uri_component(model)}")


def agent_address(domain: str, provider: str, model: str) -> str:
    """An agent's address.

    `provider:model`, with every run of characters outside `[A-Za-z0-9-]` one
    hyphen and none at either end, at `agents.` and the domain up to its first
    colon.
    """
    slug = re.sub("-+", "-", _NOT_OF_AN_ADDRESS.sub("-", f"{provider}:{model}")).strip("-")
    return f"{slug}@agents.{domain.split(':', 1)[0]}"


def agent_name(provider: str, model: str) -> str:
    """An agent's name."""
    return f"{provider} {model}"
