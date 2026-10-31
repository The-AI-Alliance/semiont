"""An agent's token at a knowledge base's gateway.

An agent is an account, as a person is: it signs in at its issuer (OIDC
discovery, then the client-credentials grant, proving itself with a secret or
with a key), and the token its issuer grants is its bearer at the gateway. The
gateway names it by that account: its DID (`did`), which the gateway answers
at `GET /api/users/me`, is who its work is attributed to. The engine it runs is
no part of it: each write names that itself.

An `AgentToken` is a transport's token source, as a person's kept sign-in is:
it gives the current token and each one after it (`token`), renews the token
by the schedule every Semiont client keeps (`semiont.session`), and renews it
at once when the gateway refuses it (`refresh`, a transport's refresher).

It is not a session. A person whose token cannot be renewed is signed out,
and signs in again. An agent whose renewal fails keeps the token it has and
tries again: a process holding a token that still works does not stop working
over one bad round trip.

A failure names the issuer and the client, and never the secret or the key. Nor does one
say any part of a token: an answer that is refused is said by what it lacks,
in none of its own words.
"""

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from types import TracebackType
from typing import Final, Self, final

import httpx
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from pydantic import ValidationError

from semiont._lacks import lacks
from semiont._reading import Reading
from semiont.errors import SemiontError, SignInError, TransportError
from semiont.http._client_assertion import JWT_BEARER, client_assertion
from semiont.http._withheld import why_unanswered
from semiont.http.exchange import refusal
from semiont.http.oauth import issuer_client, object_in, post_form, seconds_in, text_in
from semiont.identifiers import UserId
from semiont.retry import REFRESH, RetryFacts, retry_after_ms, retry_with_backoff
from semiont.session import refresh_delay, renew_when_due, renewal_delay
from semiont.timing import HTTP_REQUEST_TIMEOUT_MS, REFRESH_RETRY
from semiont.types import UserResponse
from semiont.watched import Variable, Watched

__all__ = [
    "AgentToken",
    "Credential",
    "KeyCredential",
    "NotAnRsaKey",
    "SecretCredential",
    "ServiceToken",
    "UnreadableKey",
    "private_key_from_pem",
]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SecretCredential:
    """A service account at an issuer, which proves itself with its client secret."""

    issuer: str
    client_id: str
    client_secret: str = field(repr=False)


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class KeyCredential:
    """A service account at an issuer, which proves itself with a key.

    Each grant carries an assertion signed with `private_key`, which the issuer
    checks with the public half registered on the client. The key never leaves
    the process.
    """

    issuer: str
    client_id: str
    private_key: RSAPrivateKey = field(repr=False)


type Credential = SecretCredential | KeyCredential
"""A service account at an issuer, by how it proves itself."""

_PKCS8_BEGIN: Final = "-----BEGIN PRIVATE KEY-----"
_PKCS8_END: Final = "-----END PRIVATE KEY-----"


@final
class UnreadableKey(ValueError):
    """Text that is not an unencrypted PKCS#8 PEM private key."""


@final
class NotAnRsaKey(ValueError):
    """A private key that is not RSA: a key credential signs its assertions with RS256."""


def private_key_from_pem(pem: str) -> RSAPrivateKey:
    """The RSA private key a PKCS#8 PEM holds, unencrypted: the text between `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`.

    Raises `UnreadableKey` for text that is not one, an encrypted or PKCS#1
    key among them, and `NotAnRsaKey` for a key of another kind. Neither says
    anything of the text.
    """
    armoured = pem.strip()
    if not (armoured.startswith(_PKCS8_BEGIN) and armoured.endswith(_PKCS8_END)):
        raise UnreadableKey("The key is not a PKCS#8 PEM private key: one that begins -----BEGIN PRIVATE KEY-----")
    try:
        key = serialization.load_pem_private_key(armoured.encode("ascii"), password=None)
    except (ValueError, TypeError, UnicodeEncodeError, UnsupportedAlgorithm):
        raise UnreadableKey("The PEM holds no private key that can be read") from None
    if not isinstance(key, RSAPrivateKey):
        raise NotAnRsaKey("The PEM holds no RSA private key: a key credential signs its assertions with RS256")
    return key


def _proof(credential: Credential, token_endpoint: str) -> list[tuple[str, str]]:
    """The client-credentials grant's form: the secret itself, or an assertion signed for this grant alone."""
    match credential:
        case SecretCredential():
            return [
                ("grant_type", "client_credentials"),
                ("client_id", credential.client_id),
                ("client_secret", credential.client_secret),
            ]
        case KeyCredential():
            assertion = client_assertion(
                credential.private_key,
                credential.client_id,
                token_endpoint,
                issued_at=int(time.time()),
                jti=uuid.uuid4().hex,
            )
            return [
                ("grant_type", "client_credentials"),
                ("client_assertion_type", JWT_BEARER),
                ("client_assertion", assertion),
            ]


def _within() -> asyncio.Timeout:
    return asyncio.timeout(HTTP_REQUEST_TIMEOUT_MS / 1000)


@final
class ServiceToken:
    """A service account's token, fetched on first use and renewed when it is due.

    It is kept until it is due for renewal by the schedule every Semiont
    client keeps: half its lifetime before it expires, at most
    `REFRESH_BEFORE_EXP_MS`. A service reaches another as itself with this
    token.
    """

    def __init__(self, credential: Credential) -> None:
        self._credential: Final = credential
        self._token_endpoint: str | None = None
        self._held: tuple[str, float] | None = None
        """The token, and until when it is used, by the loop's clock."""
        # One grant at a time: those who ask while one is under way are given what it brings.
        self._asking: Final = asyncio.Lock()

    async def _endpoint(self, http: httpx.AsyncClient) -> str:
        if self._token_endpoint is not None:
            return self._token_endpoint
        issuer = self._credential.issuer
        url = f"{issuer if issuer.endswith('/') else issuer + '/'}.well-known/openid-configuration"
        try:
            async with _within():
                response = await http.get(url)
        except (TimeoutError, httpx.HTTPError) as error:
            raise SignInError("discovery", f"OIDC discovery for {issuer} got no answer: {why_unanswered(error)}") from None
        status = response.status_code
        if not response.is_success:
            raise SignInError("discovery", f"OIDC discovery for {issuer} failed: HTTP {status} from {url}", status=status)
        endpoint = text_in(object_in(response.content), "token_endpoint")
        if endpoint is None:
            raise SignInError("discovery", f"OIDC discovery for {issuer} returned no `token_endpoint`", status=status)
        self._token_endpoint = endpoint
        return endpoint

    async def authorization(self) -> str:
        """The `Authorization` header's value: the account's token, renewed when it is due."""
        return f"Bearer {await self.token()}"

    async def token(self, *, renewed: bool = False) -> str:
        """The account's token: the one held until it is due, and a new grant after, or at once when `renewed`.

        Its own `exp` and `iat` say how long it lives, or failing those the
        grant's `expires_in`; a token that says neither is not kept.
        """
        loop = asyncio.get_running_loop()
        async with self._asking:
            if not renewed and self._held is not None and loop.time() < self._held[1]:
                return self._held[0]
            issuer, client_id = self._credential.issuer, self._credential.client_id
            async with issuer_client() as http:
                endpoint = await self._endpoint(http)
                try:
                    status, answer = await post_form(http, endpoint, _proof(self._credential, endpoint))
                except SignInError as error:
                    raise SignInError("exchange", f"Client-credentials grant for {client_id} at {issuer} got no answer") from error
            if not 200 <= status < 300:
                # The status, never the body: an error body can echo the secret or the assertion.
                raise SignInError("exchange", f"Client-credentials grant for {client_id} at {issuer} failed (HTTP {status})", status=status)
            token = text_in(answer, "access_token")
            if token is None:
                raise SignInError("exchange", f"Token endpoint for {issuer} returned no `access_token`", status=status)
            lifetime = seconds_in(answer, "expires_in")
            # Used until it is due for renewal, and never past its expiry: the
            # schedule's floor is for a timer, which a token already expired
            # must not turn into a loop, and nothing here loops.
            renew_in = refresh_delay(token, now=time.time())
            if renew_in is None and lifetime is not None:
                renew_in = renewal_delay(lifetime, lifetime)
            if renew_in is None:
                self._held = None
            else:
                self._held = (token, loop.time() + (renew_in if lifetime is None else min(renew_in, lifetime)))
            return token


def _transient(error: SemiontError) -> bool:
    """Whether a renewal that failed this way is worth another attempt.

    A renewal is a grant at the issuer, whose answer is the verdict
    (`semiont.retry.REFRESH`): no answer, or one saying "not now", is worth
    another; a refused grant is not, because the same account gets the same answer.
    """
    return REFRESH.retryable(RetryFacts(status=error.status, method="POST"))


@final
class AgentToken:
    """The token of the agent whose account `service` names, at the gateway at `gateway`.

    Held with `async with`: the agent is signed in on the way in, which raises
    when it cannot be (`SignInError` when its account could not sign in at its
    issuer, `TransportError` when the gateway did not name it), and it is kept
    signed in until the way out.

    A transport is given `token` as its token and `refresh` as its refresher.
    Signed in, it says who the agent is (`did`).
    """

    def __init__(self, gateway: str, *, service: ServiceToken) -> None:
        self._gateway: Final = gateway.rstrip("/")
        self._service: Final = service
        self._token: Final[Variable[str | None]] = Variable(None)
        self._did: UserId | None = None
        self._closing: Final = asyncio.Event()
        self._keeping: asyncio.Task[None] | None = None

    @property
    def gateway(self) -> str:
        """The gateway the agent signs in at."""
        return self._gateway

    @property
    def token(self) -> Watched[str | None]:
        """The agent's token: the current one, and each one after it."""
        return Reading(self._token)

    @property
    def did(self) -> UserId:
        """The agent's DID, as the gateway names its account under the knowledge base's own domain.

        It is carried as it came: re-derived from the URL the process happens
        to dial, one agent has two DIDs. It is the sign-in's answer, so an
        agent that is not signed in has none, and asking for it raises.
        """
        if self._did is None:
            raise RuntimeError("the agent is not signed in: hold it with `async with`")
        return self._did

    async def __aenter__(self) -> Self:
        if self._keeping is not None or self._closing.is_set():
            raise RuntimeError("an agent is signed in once")
        token = await self._service.token()
        self._did = await self._named(token)
        self._token.set(token)
        self._keeping = asyncio.create_task(renew_when_due(self._token, self._renew_within_budget))
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self._closing.set()
        keeping = self._keeping
        if keeping is not None:
            keeping.cancel()
            await asyncio.gather(keeping, return_exceptions=True)
            # Whatever ended the keeping that was not this closing is raised here.
            if not keeping.cancelled():
                await keeping

    async def refresh(self) -> str | None:
        """The gateway refused the token: ask the issuer for another. The new token, or nothing when it gave none."""
        try:
            return await self._renew()
        except SemiontError:
            return None

    async def _renew(self) -> str:
        """Ask the issuer for another, and make it the token."""
        token = await self._service.token(renewed=True)
        self._token.set(token)
        return token

    async def _renew_within_budget(self) -> None:
        """A due renewal.

        One that fails is tried again inside the renewal budget when the
        failure is transient (`semiont.retry.REFRESH`); spent or refused, the
        token is left as it is and the next is due an interval later, by the
        schedule's floor.
        """
        try:
            await retry_with_backoff(REFRESH_RETRY, self._renew, retryable=_transient, give_up=self._closing)
        except SemiontError:
            return

    async def _named(self, token: str) -> UserId:
        """The DID the gateway names the bearer of `token` by: `GET /api/users/me`."""
        url = f"{self._gateway}/api/users/me"
        try:
            async with issuer_client() as http, _within():
                response = await http.get(url, headers={"Authorization": f"Bearer {token}"})
        except (TimeoutError, httpx.HTTPError) as error:
            raise TransportError.without_response(f"{url} got no answer: {why_unanswered(error)}") from None
        status = response.status_code
        if not response.is_success:
            raise refusal(
                f"the gateway did not name the agent (HTTP {status})",
                status,
                response.content,
                retry_after_ms(response.headers.get("retry-after")),
            )
        try:
            return UserResponse.model_validate_json(response.content).did
        except ValidationError as error:
            lacking = lacks((UserResponse,), error, "a principal")
        # Raised from nothing: the decoder's failure shows the answer, and what a failure is raised from is printed with it.
        raise TransportError("error", f"{url} did not answer who the agent is: {lacking}", status=status)
