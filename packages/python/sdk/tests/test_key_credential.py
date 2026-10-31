"""A service account that proves itself with a key: each grant carries an assertion signed for it alone, and no secret.

What an issuer does with the assertion is done here by hand: its signature is
checked with the key's public half, and its claims read. The shape the table
states is `test_client_assertion_cases.py`'s.
"""

import base64
import time
from urllib.parse import parse_qs

import pytest
from aio import pass_time, run, soon
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from gateway_server import Asked, GatewayServer
from issuer import TOKEN, issuer_of, says, trusting
from pydantic import JsonValue, TypeAdapter
from spec import SPEC, read, strings, text
from tokens import token

from semiont.errors import SignInError
from semiont.http import KeyCredential, NotAnRsaKey, ServiceToken, UnreadableKey, private_key_from_pem
from semiont.http._client_assertion import JWT_BEARER, LIFETIME_SECONDS, thumbprint

_JSON = TypeAdapter[JsonValue](JsonValue)
TABLE = read(SPEC / "session/client-assertion-cases.json")
FORM = strings(TABLE["form"], "form")
GRANT = text(TABLE["grantType"], "grantType")
CLIENT = "semiont-worker-alice-laptop"


def form(asked: Asked) -> dict[str, str]:
    """A request's body, which is a form: each field once."""
    assert asked.headers["content-type"] == "application/x-www-form-urlencoded"
    fields = parse_qs(asked.body.decode(), keep_blank_values=True, strict_parsing=True)
    assert all(len(values) == 1 for values in fields.values())
    return {name: values[0] for name, values in fields.items()}


def decoded(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def checked(assertion: str, key: RSAPrivateKey) -> tuple[JsonValue, JsonValue]:
    """The assertion's header and claims, once its signature is checked with `key`'s public half, as an issuer checks it."""
    head, body, signature = assertion.split(".")
    key.public_key().verify(decoded(signature), f"{head}.{body}".encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    return _JSON.validate_json(decoded(head)), _JSON.validate_json(decoded(body))


def a_key() -> RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def test_each_grant_carries_an_assertion_signed_for_it_alone_and_no_secret() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            first, second = token(300, 1), token(300, 2)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": first, "expires_in": 300}), says({"access_token": second})]
            key = a_key()
            service = ServiceToken(KeyCredential(issuer=issuer_of(gateway), client_id=CLIENT, private_key=key))

            assert await soon(service.authorization()) == f"Bearer {first}"
            await pass_time(152)
            assert await soon(service.authorization()) == f"Bearer {second}"

            jtis: list[JsonValue] = []
            for asked in gateway.of("POST", TOKEN):
                sent = form(asked)
                assert sorted(sent) == sorted(FORM)
                assert (sent["grant_type"], sent["client_assertion_type"]) == (GRANT, JWT_BEARER)
                head, claims = checked(sent["client_assertion"], key)
                assert head == {"alg": "RS256", "kid": thumbprint(key.public_key())}
                assert isinstance(claims, dict)
                assert (claims["iss"], claims["sub"], claims["aud"]) == (CLIENT, CLIENT, f"{gateway.origin}{TOKEN}")
                issued, expires = claims["iat"], claims["exp"]
                assert isinstance(issued, int)
                assert isinstance(expires, int)
                assert expires - issued == LIFETIME_SECONDS
                assert abs(issued - time.time()) < 60
                jtis.append(claims["jti"])
            assert len(jtis) == 2
            assert jtis[0] != jtis[1], "a grant's assertion is never sent twice"

    run(scenario())


def test_an_assertion_another_key_signed_is_not_this_accounts() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": token(300, 1), "expires_in": 300})]
            key = a_key()
            await soon(ServiceToken(KeyCredential(issuer=issuer_of(gateway), client_id=CLIENT, private_key=key)).authorization())
            assertion = form(gateway.of("POST", TOKEN)[0])["client_assertion"]
            with pytest.raises(InvalidSignature):
                checked(assertion, a_key())

    run(scenario())


def test_a_key_credential_never_shows_its_key_and_a_refused_grant_never_shows_its_assertion() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            key = a_key()
            credential = KeyCredential(issuer=issuer_of(gateway), client_id=CLIENT, private_key=key)
            pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            assert "private_key" not in repr(credential)
            assert pem.decode() not in repr(credential)

            # An error body can echo what it was sent: the status is said, never the body.
            gateway.scripted[("POST", TOKEN)] = [says({"error": "invalid_client", "error_description": "echo"}, 401)]
            with pytest.raises(SignInError, match=rf"Client-credentials grant for {CLIENT} at .* failed \(HTTP 401\)") as failed:
                await soon(ServiceToken(credential).authorization())
            assertion = form(gateway.of("POST", TOKEN)[0])["client_assertion"]
            assert assertion not in failed.value.message
            assert assertion not in repr(failed.value)

    run(scenario())


def test_a_pkcs8_pem_is_read_as_its_rsa_key_and_anything_else_is_refused_without_a_word_of_it() -> None:
    key = a_key()
    pkcs8 = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    # As a variable holds it: surrounding white space and CRLF line ends are the same key.
    assert private_key_from_pem("\n" + pkcs8.replace("\n", "\r\n") + "  ").private_numbers() == key.private_numbers()

    pkcs1 = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption())
    passphrase = serialization.BestAvailableEncryption(b"pass")
    encrypted = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, passphrase)
    unreadable = [
        "not a key at all",
        pkcs1.decode(),
        encrypted.decode(),
        "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n",
    ]
    for held in unreadable:
        with pytest.raises(UnreadableKey) as unread:
            private_key_from_pem(held)
        assert held.strip() not in str(unread.value)
        assert unread.value.__cause__ is None

    elliptic = ec.generate_private_key(ec.SECP256R1())
    held = elliptic.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    with pytest.raises(NotAnRsaKey) as refused:
        private_key_from_pem(held)
    assert held not in str(refused.value)
