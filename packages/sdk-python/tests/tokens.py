"""Tokens for tests: JWTs that carry what a test says. Nothing here signs one, and nothing in this package verifies one."""

import base64
import time

from pydantic import JsonValue, TypeAdapter

_JSON = TypeAdapter[JsonValue](JsonValue)


def segment(value: JsonValue) -> str:
    """A JWT's segment: base64url, without padding."""
    return base64.urlsafe_b64encode(_JSON.dump_json(value)).rstrip(b"=").decode()


def jwt(claims: JsonValue) -> str:
    """Any JWT that carries `claims`."""
    return f"{segment({'alg': 'RS256', 'typ': 'JWT'})}.{segment(claims)}.{segment('signature')}"


def token(lifetime: int, n: int, **claims: JsonValue) -> str:
    """A token issued now that lives `lifetime` seconds, told from every other by `n`."""
    issued = int(time.time())
    return jwt({"iat": issued, "exp": issued + lifetime, "n": n, **claims})


def expired(**claims: JsonValue) -> str:
    """A token whose time has passed."""
    issued = int(time.time())
    return jwt({"iat": issued - 600, "exp": issued - 300, **claims})
