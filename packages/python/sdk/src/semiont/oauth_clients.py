# Generated from specs/src/session/oauth.json; do not edit.
# Regenerate: node scripts/spec/generate-oauth-clients-python.mjs

"""How a Semiont client presents itself to the issuer a knowledge base trusts:
the clients its realm registers, and the scope every sign-in asks for.
"""

from typing import Final

__all__ = [
    "BROWSER_CLIENT_ID",
    "SCRIPT_CLIENT_ID",
    "SIGN_IN_SCOPE",
]

# An application a person uses: the authorization-code grant with PKCE (RFC 7636), at a redirect
# address the registration lists.
BROWSER_CLIENT_ID: Final = "semiont-browser"

# A process with no browser of its own, and the launcher: the device authorization grant (RFC
# 8628).
SCRIPT_CLIENT_ID: Final = "semiont-cli"

# What every sign-in asks for. `offline_access` asks for a refresh token that outlives the
# issuer's own browser session: a session with a knowledge base is renewed for weeks, not
# minutes.
SIGN_IN_SCOPE: Final = "openid email profile offline_access"
