"""A script as an OAuth public client of the issuer a knowledge base trusts.

Finding the issuer from the knowledge base's resource metadata (RFC 9728), the
device authorization grant (RFC 8628) for a process with no browser, the
refresh grant, and revocation (RFC 7009).

Nothing here names a vendor, and no password passes through it. A client that
knows a gateway's address knows everything it needs: the knowledge base names
its issuer, and the issuer names its endpoints.

**A refusal and an outage are different events.** A `SignInError` that carries
a status is the issuer's answer. One that carries none got no answer. A kept
sign-in's renewal is tried again only on the second kind, and on an answer
that says "not now" (`semiont.retry.REFRESH`), inside a bounded budget: a
refused grant is final, because trying again only delays a sign-in the person
has to perform anyway.

Each request of an issuer is to be answered within `HTTP_REQUEST_TIMEOUT_MS`:
an issuer that accepts a connection and never answers would otherwise hold a
renewal, and the session waiting on it, for as long as the process lives.
"""

import asyncio
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, final

import httpx
from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont.errors import SignInError, TransportError
from semiont.http.transport import HttpTransport
from semiont.identity import encode_uri_component
from semiont.oauth_clients import SCRIPT_CLIENT_ID, SIGN_IN_SCOPE
from semiont.retry import REFRESH, RetryFacts, retry_with_backoff
from semiont.session import SignInKept
from semiont.timing import HTTP_REQUEST_TIMEOUT_MS, REFRESH_RETRY
from semiont.watched import Variable

__all__ = [
    "Answer",
    "DeviceCode",
    "IssuedTokens",
    "IssuerEndpoints",
    "discover_issuer",
    "issuer_client",
    "object_in",
    "post_form",
    "refresh_at_issuer",
    "renew_kept",
    "revoke_at_issuer",
    "seconds_in",
    "sign_in_with_device_grant",
    "text_in",
]

_DEVICE_GRANT: Final = "urn:ietf:params:oauth:grant-type:device_code"
# How long a device code is good for when the issuer does not say.
_DEVICE_CODE_LIFETIME_S: Final = 600.0
# How often the token endpoint is asked when the issuer does not say, and how
# much longer it is left between asks each time it says to slow down.
_DEVICE_POLL_S: Final = 5.0

_OBJECT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])

type Answer = Mapping[str, JsonValue] | None
"""What an issuer answered, when that was a JSON object."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class IssuerEndpoints:
    """An issuer, and the endpoints of it a client uses."""

    issuer: str
    authorization: str
    token: str
    device: str | None = None
    revocation: str | None = None


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class IssuedTokens:
    """What a grant issued."""

    access: str
    refresh: str


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class DeviceCode:
    """What a person is shown to approve a sign-in from wherever they have a browser."""

    user_code: str
    verification_uri: str
    verification_uri_complete: str | None
    expires_in: float
    """How long the code is good for, in seconds."""


def issuer_client() -> httpx.AsyncClient:
    """An HTTP client for requests of an issuer. It reads no environment variable, as a transport's reads none."""
    return httpx.AsyncClient(timeout=None, trust_env=False)


def _within() -> asyncio.Timeout:
    return asyncio.timeout(HTTP_REQUEST_TIMEOUT_MS / 1000)


def object_in(body: bytes) -> Answer:
    """A body, when it is a JSON object."""
    try:
        return _OBJECT.validate_json(body)
    except ValidationError:
        return None


def text_in(answer: Answer, name: str) -> str | None:
    """A member of an answer that is text, when it has one."""
    value = None if answer is None else answer.get(name)
    return value if isinstance(value, str) else None


def seconds_in(answer: Answer, name: str) -> float | None:
    """A span of time an answer states in seconds, when it states one that can be waited."""
    value = None if answer is None else answer.get(name)
    if isinstance(value, bool) or not isinstance(value, int | float) or value < 0 or value == float("inf"):
        return None
    return float(value)


def _no_issuer() -> SignInError:
    return SignInError("no-issuer", "The knowledge base trusts no external issuer")


async def discover_issuer(base_url: str) -> IssuerEndpoints:
    """Ask the knowledge base at `base_url` which issuer it trusts, and the issuer where its endpoints are."""
    # Its resource metadata is public: asked with no token, by a transport that opens no stream.
    asking = HttpTransport(base_url, token=Variable[str | None](None), channels=())
    try:
        metadata = await asking.get_protected_resource_metadata()
    except TransportError as error:
        if error.status == 404:
            raise _no_issuer() from error
        raise SignInError(
            "discovery", f"The knowledge base did not answer its resource metadata: {error.message}", status=error.status
        ) from error
    finally:
        await asking.close()
    if not metadata.authorization_servers:
        raise _no_issuer()
    issuer = metadata.authorization_servers[0]

    url = f"{issuer.rstrip('/')}/.well-known/openid-configuration"
    try:
        async with issuer_client() as http, _within():
            response = await http.get(url, headers={"Accept": "application/json"})
    except (TimeoutError, httpx.HTTPError) as error:
        raise SignInError("discovery", f"Issuer {issuer}: discovery was not answered: {error!r}") from error
    status = response.status_code
    if not response.is_success:
        raise SignInError("discovery", f"Issuer {issuer}: discovery answered HTTP {status}", status=status)
    document = object_in(response.content)
    authorization, token = text_in(document, "authorization_endpoint"), text_in(document, "token_endpoint")
    if text_in(document, "issuer") != issuer or authorization is None or token is None:
        raise SignInError("discovery", f"Issuer {issuer}: its discovery document is not an OpenID configuration for it", status=status)
    return IssuerEndpoints(
        issuer=issuer,
        authorization=authorization,
        token=token,
        device=text_in(document, "device_authorization_endpoint"),
        revocation=text_in(document, "revocation_endpoint"),
    )


# ── The token endpoint ──────────────────────────────────────────────────


def _form(pairs: Sequence[tuple[str, str]]) -> bytes:
    return "&".join(f"{name}={encode_uri_component(value)}" for name, value in pairs).encode()


async def post_form(http: httpx.AsyncClient, endpoint: str, form: Sequence[tuple[str, str]]) -> tuple[int, Answer]:
    """One form posted to the issuer: the status it answered, and its answer when that was a JSON object.

    No answer at all is an error with no status, and so is one that has not
    come by the request's deadline.
    """
    try:
        async with _within():
            response = await http.post(
                endpoint,
                content=_form(form),
                headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
            )
    except (TimeoutError, httpx.HTTPError) as error:
        raise SignInError("exchange", f"The issuer did not answer: {error!r}") from error
    return response.status_code, object_in(response.content)


def _refusal(status: int, answer: Answer) -> str:
    """What the issuer said of a refusal: its error and description, or the status."""
    error, description = text_in(answer, "error"), text_in(answer, "error_description")
    if error is None:
        return f"HTTP {status}"
    return error if description is None else f"{error}: {description}"


def _no_refresh_token() -> SignInError:
    return SignInError("exchange", "The issuer returned no refresh token: the session could not outlive its first access token")


async def refresh_at_issuer(http: httpx.AsyncClient, token_endpoint: str, client_id: str, refresh_token: str) -> IssuedTokens:
    """The refresh grant. An issuer that does not rotate refresh tokens returns none, and the one held stays current."""
    status, answer = await post_form(
        http, token_endpoint, [("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", client_id)]
    )
    access = text_in(answer, "access_token")
    if status != 200 or access is None:
        raise SignInError("exchange", f"The issuer refused the token request ({_refusal(status, answer)})", status=status)
    return IssuedTokens(access=access, refresh=text_in(answer, "refresh_token") or refresh_token)


async def renew_kept(kept: SignInKept) -> str | None:
    """Renew a kept sign-in at its issuer, and keep what it rotated.

    The new access token; nothing when no sign-in is kept, which is an absence
    and not a failure. A renewal that fails says why in the issuer's own
    words, and, when the retry budget ran out, how many attempts it took to
    give up.

    What is kept is written against what is kept then: a sign-in that was
    signed out, or ended, while it was being renewed is gone. It is not
    written back, and its new token is given to nobody: a session that is over
    is not handed a credential again.
    """
    held = await kept.held()
    if held is None:
        return None
    attempts = 0
    async with issuer_client() as http:

        async def attempt() -> IssuedTokens:
            nonlocal attempts
            attempts += 1
            return await refresh_at_issuer(http, held.token_endpoint, held.client_id, held.refresh)

        try:
            tokens = await retry_with_backoff(
                REFRESH_RETRY,
                attempt,
                retryable=lambda error: REFRESH.retryable(RetryFacts(status=error.status, method="POST")),
                give_up=asyncio.Event(),
            )
        except SignInError as error:
            # One attempt: the issuer answered, and its answer was final.
            if attempts <= 1:
                raise
            raise SignInError(
                "exchange", f"The session could not be renewed after {attempts} attempts: {error.message}", status=error.status
            ) from error
    return tokens.access if await kept.renewed(tokens.access, tokens.refresh) else None


async def revoke_at_issuer(http: httpx.AsyncClient, revocation_endpoint: str, client_id: str, refresh_token: str) -> None:
    """RFC 7009. The issuer answers 200 for a token it has already forgotten, so revoking twice is revoking once."""
    status, _ = await post_form(
        http, revocation_endpoint, [("token", refresh_token), ("token_type_hint", "refresh_token"), ("client_id", client_id)]
    )
    if status != 200:
        raise SignInError("exchange", f"The issuer refused the revocation (HTTP {status})", status=status)


# ── The device authorization grant ──────────────────────────────────────


def _expired() -> SignInError:
    return SignInError("expired", "The code expired before it was approved")


async def sign_in_with_device_grant(base_url: str, on_code: Callable[[DeviceCode], None]) -> tuple[IssuerEndpoints, IssuedTokens]:
    """Sign in as a person from a process with no browser.

    The issuer the knowledge base at `base_url` trusts mints a code, `on_code`
    shows the person where to approve it, and the token endpoint is asked at
    the issuer's interval until the tokens arrive. Cancelling it abandons the
    sign-in.
    """
    issuer = await discover_issuer(base_url)
    if issuer.device is None:
        raise SignInError(
            "discovery",
            f"Issuer {issuer.issuer} offers no device authorization endpoint: "
            f"the device grant needs one enabled for client {SCRIPT_CLIENT_ID}",
        )
    async with issuer_client() as http:
        status, body = await post_form(http, issuer.device, [("client_id", SCRIPT_CLIENT_ID), ("scope", SIGN_IN_SCOPE)])
        device_code, user_code, verification_uri = (
            text_in(body, "device_code"),
            text_in(body, "user_code"),
            text_in(body, "verification_uri"),
        )
        if status != 200 or device_code is None or user_code is None or verification_uri is None:
            raise SignInError("exchange", f"The issuer refused the device authorization request ({_refusal(status, body)})", status=status)
        expires_in = seconds_in(body, "expires_in")
        if expires_in is None:
            expires_in = _DEVICE_CODE_LIFETIME_S
        on_code(
            DeviceCode(
                user_code=user_code,
                verification_uri=verification_uri,
                verification_uri_complete=text_in(body, "verification_uri_complete"),
                expires_in=expires_in,
            )
        )

        stated = seconds_in(body, "interval")
        interval = max(_DEVICE_POLL_S if stated is None else stated, 1.0)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + expires_in
        while True:
            await asyncio.sleep(interval)
            if loop.time() > deadline:
                raise _expired()
            status, answer = await post_form(
                http, issuer.token, [("grant_type", _DEVICE_GRANT), ("device_code", device_code), ("client_id", SCRIPT_CLIENT_ID)]
            )
            access = text_in(answer, "access_token")
            if status == 200 and access is not None:
                refresh = text_in(answer, "refresh_token")
                if refresh is None:
                    raise _no_refresh_token()
                return issuer, IssuedTokens(access=access, refresh=refresh)
            match text_in(answer, "error"):
                case "authorization_pending":
                    pass
                case "slow_down":
                    interval += _DEVICE_POLL_S
                case "access_denied":
                    raise SignInError("denied", "The sign-in was denied at the issuer", status=status)
                case "expired_token":
                    raise _expired()
                case _:
                    raise SignInError("exchange", f"The issuer refused the token request ({_refusal(status, answer)})", status=status)
