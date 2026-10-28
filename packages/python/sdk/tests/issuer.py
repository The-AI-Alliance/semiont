"""An issuer and a gateway's own answers, scripted on the tests' gateway server: what a sign-in is made against."""

from gateway_server import Answer, GatewayServer
from pydantic import JsonValue, TypeAdapter
from spec import JsonObject
from tokens import token

from semiont.http import Credential
from semiont.identity import agent_did

_JSON = TypeAdapter[JsonValue](JsonValue)

REALM = "/realms/semiont"
CONFIGURATION = f"{REALM}/.well-known/openid-configuration"
TOKEN, DEVICE, REVOKE = f"{REALM}/token", f"{REALM}/device", f"{REALM}/revoke"
METADATA = "/.well-known/oauth-protected-resource"
AGENT = "/api/tokens/agent"
ME = "/api/users/me"
ALICE: JsonObject = {
    "did": "did:web:example.org:users:alice",
    "email": "alice@example.org",
    "name": "Alice",
    "image": None,
    "domain": "example.org",
}
REFUSED = Answer(status=401, body=b'{"error":"The token is not one this gateway admits"}')


def says(body: JsonValue, status: int = 200) -> Answer:
    return Answer(status=status, body=_JSON.dump_json(body))


def issuer_of(gateway: GatewayServer) -> str:
    return f"{gateway.origin}{REALM}"


def trusting(gateway: GatewayServer, *, device: bool = True, revocation: bool = True) -> None:
    """The gateway names its issuer, and the issuer its endpoints."""
    issuer = issuer_of(gateway)
    gateway.answers[METADATA] = {
        "resource": "https://kb.example.org",
        "authorization_servers": [issuer],
        "bearer_methods_supported": ["header"],
    }
    configuration: JsonObject = {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/auth",
        "token_endpoint": f"{gateway.origin}{TOKEN}",
    }
    if device:
        configuration["device_authorization_endpoint"] = f"{gateway.origin}{DEVICE}"
    if revocation:
        configuration["revocation_endpoint"] = f"{gateway.origin}{REVOKE}"
    gateway.answers[CONFIGURATION] = configuration
    gateway.answers[ME] = ALICE


def minted(**stated: JsonValue) -> Answer:
    """The issuer's answer to a device authorization request."""
    return says(
        {"device_code": "the-device-code", "user_code": "WDJB-MJHT", "verification_uri": "https://issuer.example.org/device", **stated}
    )


PENDING = says({"error": "authorization_pending"}, 400)


SECRET = "s3cr3t &=+/"


def account(gateway: GatewayServer) -> Credential:
    return Credential(issuer=issuer_of(gateway), client_id="semiont-smelter", client_secret=SECRET)


def agent_token(n: int, lifetime: int = 3600) -> Answer:
    return says({"token": token(lifetime, n), "did": agent_did("example.org", "ollama", "gemma2:27b")})
