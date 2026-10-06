"""An agent's token at a knowledge base's gateway.

A service account signs in at its issuer (OIDC discovery, then the
client-credentials grant), and its token is exchanged at
`POST /api/tokens/agent` for the token of the software agent
`(provider, model)`, which names the work it does. The gateway decides how
long the agent token lives.

An `AgentToken` is a transport's token source, as a person's kept sign-in is:
it gives the current token and each one after it (`token`), renews the token
by the schedule every Semiont client keeps (`semiont.session`), and renews it
at once when the gateway refuses it (`refresh`, a transport's refresher).

It is not a session. A person whose token cannot be renewed is signed out,
and signs in again. An agent whose renewal fails keeps the token it has and
tries again: a process holding a token that still works does not stop working
over one bad round trip.

A failure names the issuer and the client, and never the secret.
"""

import asyncio
import time
from dataclasses import dataclass, field
from types import TracebackType
from typing import Final, Self, final

import httpx
from pydantic import ValidationError

from semiont.errors import SemiontError, SignInError, TransportError
from semiont.http.oauth import issuer_client, object_in, post_form, seconds_in, text_in
from semiont.retry import REFRESH, RetryFacts, retry_after_ms, retry_with_backoff
from semiont.session import refresh_delay, renew_when_due, renewal_delay
from semiont.timing import HTTP_REQUEST_TIMEOUT_MS, REFRESH_RETRY
from semiont.types import AgentTokenRequest, AgentTokenResponse
from semiont.watched import Variable, Watched

__all__ = ["AgentToken", "Credential", "ServiceToken"]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Credential:
    """A service account at an issuer."""

    issuer: str
    client_id: str
    client_secret: str = field(repr=False)


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
            raise SignInError("discovery", f"OIDC discovery for {issuer} got no answer: {error!r}") from error
        status = response.status_code
        if not response.is_success:
            raise SignInError("discovery", f"OIDC discovery for {issuer} failed: HTTP {status} from {url}", status=status)
        endpoint = text_in(object_in(response.content), "token_endpoint")
        if endpoint is None:
            raise SignInError("discovery", f"OIDC discovery for {issuer} returned no `token_endpoint`", status=status)
        self._token_endpoint = endpoint
        return endpoint

    async def authorization(self) -> str:
        """The `Authorization` header's value: the account's token, renewed when it is due.

        Its own `exp` and `iat` say how long it lives, or failing those the
        grant's `expires_in`; a token that says neither is not kept.
        """
        loop = asyncio.get_running_loop()
        async with self._asking:
            if self._held is not None and loop.time() < self._held[1]:
                return f"Bearer {self._held[0]}"
            issuer, client_id = self._credential.issuer, self._credential.client_id
            async with issuer_client() as http:
                endpoint = await self._endpoint(http)
                try:
                    status, answer = await post_form(
                        http,
                        endpoint,
                        [("grant_type", "client_credentials"), ("client_id", client_id), ("client_secret", self._credential.client_secret)],
                    )
                except SignInError as error:
                    raise SignInError("exchange", f"Client-credentials grant for {client_id} at {issuer} got no answer") from error
            if not 200 <= status < 300:
                # The status, never the body: an error body can echo the secret.
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
            return f"Bearer {token}"


def _transient(error: SemiontError) -> bool:
    """Whether a renewal that failed this way is worth another attempt."""
    return REFRESH.retryable(RetryFacts(status=error.status, method="POST"))


@final
class AgentToken:
    """The token of the agent `(provider, model)` at the gateway at `gateway`.

    Held with `async with`: the agent is signed in on the way in, which raises
    when it cannot be (`SignInError` when its service account could not sign
    in, `TransportError` when the gateway did not make the exchange), and it
    is kept signed in until the way out.

    A transport is given `token` as its token and `refresh` as its refresher.
    """

    def __init__(self, gateway: str, *, provider: str, model: str, service: ServiceToken) -> None:
        self._gateway: Final = gateway.rstrip("/")
        self._agent: Final = AgentTokenRequest(provider=provider, model=model)
        self._service: Final = service
        self._token: Final[Variable[str | None]] = Variable(None)
        self._closing: Final = asyncio.Event()
        self._keeping: asyncio.Task[None] | None = None

    @property
    def gateway(self) -> str:
        """The gateway the agent signs in at."""
        return self._gateway

    @property
    def token(self) -> Watched[str | None]:
        """The agent token: the current one, and each one after it."""
        return self._token

    async def __aenter__(self) -> Self:
        if self._keeping is not None or self._closing.is_set():
            raise RuntimeError("an agent is signed in once")
        await self._renew()
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
        """The gateway refused the token: exchange again. The new token, or nothing when the exchange failed."""
        try:
            return await self._renew()
        except SemiontError:
            return None

    async def _renew(self) -> str:
        """Exchange again, and make the answer the token."""
        token = await self._exchange()
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

    async def _exchange(self) -> str:
        authorization = await self._service.authorization()
        url = f"{self._gateway}/api/tokens/agent"
        try:
            async with issuer_client() as http, _within():
                response = await http.post(
                    url,
                    content=self._agent.model_dump_json(),
                    headers={"Authorization": authorization, "Content-Type": "application/json"},
                )
        except (TimeoutError, httpx.HTTPError) as error:
            raise TransportError.without_response(f"{url} got no answer: {error!r}") from error
        status = response.status_code
        if not response.is_success:
            raise TransportError.of_status(
                f"the gateway refused the agent token exchange (HTTP {status})", status, retry_after_ms(response.headers.get("retry-after"))
            )
        try:
            return AgentTokenResponse.model_validate_json(response.content).token
        except ValidationError as error:
            raise TransportError("error", f"{url} did not answer an agent token: {error}", status=status) from error
