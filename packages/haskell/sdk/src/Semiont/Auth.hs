module Semiont.Auth (AuthNamespace, newAuth, me, mediaToken, protectedResourceMetadata) where
import Semiont.Gateway
import Semiont.Types

data AuthNamespace = AuthNamespace GatewayOperations
newAuth :: GatewayOperations -> AuthNamespace
newAuth = AuthNamespace
me :: AuthNamespace -> IO UserResponse
me (AuthNamespace gateway) = getCurrentUser gateway
mediaToken :: AuthNamespace -> ResourceId -> IO MediaTokenResponse
mediaToken (AuthNamespace gateway) = getMediaToken gateway
protectedResourceMetadata :: AuthNamespace -> IO ProtectedResourceMetadata
protectedResourceMetadata (AuthNamespace gateway) = getProtectedResourceMetadata gateway
