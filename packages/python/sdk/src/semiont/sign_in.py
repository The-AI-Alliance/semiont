# Generated from specs/src/sign-in-store/SignIn.json; do not edit.
# Regenerate: node scripts/spec/generate-sign-in-python.mjs

"""One entry of the sign-in store (`specs/src/sign-in-store`): the file where
`semiont login` keeps the sign-in to each stack, and where an application
finds it.
"""

from typing import Annotated, final

from pydantic import Field

from semiont.model import WireModel

__all__ = ["SignIn"]


@final
class SignIn(WireModel, frozen=True):
    """One sign-in to a running stack's knowledge base, as the sign-in store keeps it: the tokens
    an issuer issued to the script client, and what a renewal and a sign-out need of that
    issuer, learned once at sign-in. TOKENS, never a password. An entry of
    <stateDir>/tokens.json (see README.md).
    """

    # The access token: short-lived, sent as a Bearer token.
    token: str

    # The refresh token: long-lived, and what renews the access token at the issuer without
    # another sign-in. An entry with none cannot be renewed.
    refresh_token: Annotated[str | None, Field(alias="refreshToken")] = None

    # Who signed in: the address the access token named when the sign-in was made, which is the
    # one the gateway answers for it. For display. A writer that renews an entry keeps it.
    email: str

    # When the access token was issued to this machine, RFC 3339 in UTC.
    obtained_at: Annotated[str, Field(alias="obtainedAt")]

    # When the access token stops working, RFC 3339 in UTC, so a reader can renew before sending
    # a token it knows is dead. Absent when the issuer named no lifetime: the gateway's refusal
    # is then the signal.
    expires_at: Annotated[str | None, Field(alias="expiresAt")] = None

    # The issuer the sign-in came from: the one the access token named when the sign-in was
    # made. A writer that renews an entry keeps it.
    issuer: str

    # The issuer's token endpoint, where the refresh grant is made.
    token_endpoint: Annotated[str, Field(alias="tokenEndpoint")]

    # The issuer's revocation endpoint (RFC 7009), where a sign-out tells it to forget the
    # refresh token. Absent when the issuer has none.
    revocation_endpoint: Annotated[str | None, Field(alias="revocationEndpoint")] = None
