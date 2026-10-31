"""A service account's assertion of itself, held to `specs/src/session/client-assertion-cases.json`.

The table states the shape: the thumbprint a key is named by, the header and
claims an assertion carries, and the grant's form. The signature over them,
and the form a grant posts, are held in `test_key_credential.py`, where a
grant's assertion is checked with the key's public half as an issuer checks it.
"""

import base64

import pytest
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey, RSAPublicNumbers
from spec import SPEC, JsonObject, objects, read, text

from semiont.http._client_assertion import JWT_BEARER, LIFETIME_SECONDS, claims, header, thumbprint

TABLE = read(SPEC / "session/client-assertion-cases.json")
THUMBPRINTS = objects(TABLE["thumbprints"], "thumbprints")
CASES = objects(TABLE["cases"], "cases")


def why(case: JsonObject) -> str:
    return text(case["why"], "why")


def number(member: str) -> int:
    return int.from_bytes(base64.urlsafe_b64decode(member + "=" * (-len(member) % 4)), "big")


def key_of(case: JsonObject) -> RSAPublicKey:
    jwk = case["jwk"]
    assert isinstance(jwk, dict), f"{why(case)}: its jwk is not an object"
    assert jwk["kty"] == "RSA", f"{why(case)}: its key is not RSA"
    return RSAPublicNumbers(number(text(jwk["e"], "e")), number(text(jwk["n"], "n"))).public_key()


def whole(value: object, what: str) -> int:
    assert isinstance(value, int), f"{what} is not a whole number"
    assert not isinstance(value, bool), f"{what} is a truth value, not a number"
    return value


@pytest.mark.parametrize("case", THUMBPRINTS, ids=why)
def test_a_key_is_named_by_its_thumbprint(case: JsonObject) -> None:
    assert thumbprint(key_of(case)) == case["thumbprint"]


@pytest.mark.parametrize("case", CASES, ids=why)
def test_an_assertion_carries_the_header_and_claims_the_table_states(case: JsonObject) -> None:
    assert header(key_of(case)) == case["header"]
    stated = claims(
        text(case["clientId"], "clientId"),
        text(case["tokenEndpoint"], "tokenEndpoint"),
        issued_at=whole(case["issuedAt"], "issuedAt"),
        jti=text(case["jti"], "jti"),
    )
    assert stated == case["claims"]


def test_an_assertion_is_of_the_tables_type_and_lives_as_long_as_it_says() -> None:
    # The form a grant posts is held where a grant is made, in test_key_credential.py.
    assert TABLE["assertionType"] == JWT_BEARER
    assert TABLE["lifetimeSeconds"] == LIFETIME_SECONDS
