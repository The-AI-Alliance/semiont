"""A service account's assertion of itself, signed with its own key (RFC 7523 §2.2, OpenID Connect's `private_key_jwt`).

The issuer holds the key's public half, registered on the account's client, and
checks the signature with it: the private key never leaves the process, and no
secret is sent. The assertion's shape is `specs/src/session/client-assertion-cases.json`'s.
"""

import base64
import json
from collections.abc import Mapping
from typing import Final

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey, RSAPublicKey

JWT_BEARER: Final = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
"""The grant's `client_assertion_type` for an assertion that is a JWT."""

LIFETIME_SECONDS: Final = 60
"""How long after it is made an assertion is good for."""


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unsigned(value: int) -> bytes:
    return value.to_bytes((value.bit_length() + 7) // 8, "big")


def _compact(value: Mapping[str, str | int]) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


def thumbprint(key: RSAPublicKey) -> str:
    """The key's JWK thumbprint (RFC 7638): the SHA-256 of `e`, `kty` and `n`, in that order, with no whitespace."""
    numbers = key.public_numbers()
    digest = hashes.Hash(hashes.SHA256())
    digest.update(_compact({"e": _base64url(_unsigned(numbers.e)), "kty": "RSA", "n": _base64url(_unsigned(numbers.n))}))
    return _base64url(digest.finalize())


def header(key: RSAPublicKey) -> dict[str, str]:
    """An assertion's header: RS256, and the key it is signed with, by its thumbprint."""
    return {"alg": "RS256", "kid": thumbprint(key)}


def claims(client_id: str, token_endpoint: str, *, issued_at: int, jti: str) -> dict[str, str | int]:
    """An assertion's claims: the client is its issuer and its subject, and the token endpoint its audience."""
    return {
        "iss": client_id,
        "sub": client_id,
        "aud": token_endpoint,
        "jti": jti,
        "iat": issued_at,
        "exp": issued_at + LIFETIME_SECONDS,
    }


def client_assertion(key: RSAPrivateKey, client_id: str, token_endpoint: str, *, issued_at: int, jti: str) -> str:
    """The assertion, signed: a compact JWT of `header` and `claims`, RS256 with `key`."""
    signing_input = ".".join(
        _base64url(_compact(part)) for part in (header(key.public_key()), claims(client_id, token_endpoint, issued_at=issued_at, jti=jti))
    )
    signature = key.sign(signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input}.{_base64url(signature)}"
