-- | OAuth against the issuer named by a knowledge base.
module Semiont.Issuer
  ( IssuerOptions(..), IssuerEndpoints(..), IssuedTokens(..), DeviceCode(..)
  , BeginAuthorizationOptions(..), PendingAuthorization(..), pendingAuthorizationKey
  , browserClientId, scriptClientId, signInScope
  , discoverIssuer, codeChallenge, beginAuthorization, completeAuthorization
  , refreshAtIssuer, refreshSession, revokeAtIssuer, signInWithDeviceGrant
  ) where
import Semiont.Internal.Issuer
