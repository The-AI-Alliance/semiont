module Semiont.Gateway (GatewayOperations(..)) where
import Semiont.Types

data GatewayOperations = GatewayOperations
  { getCurrentUser :: IO UserResponse
  , getMediaToken :: ResourceId -> IO MediaTokenResponse
  , getProtectedResourceMetadata :: IO ProtectedResourceMetadata
  , healthCheck :: IO HealthResponse
  , getStatus :: IO StatusResponse
  }
