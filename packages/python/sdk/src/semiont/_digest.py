"""The unpadded base64url (RFC 4648 §5) of a text's SHA-256: a PKCE challenge, and the key a person's caches are kept under."""

import base64
import hashlib

__all__ = ["base64url_sha256"]


def base64url_sha256(text: str) -> str:
    """BASE64URL(SHA-256(UTF-8 of `text`)), with no padding."""
    return base64.urlsafe_b64encode(hashlib.sha256(text.encode()).digest()).rstrip(b"=").decode()
