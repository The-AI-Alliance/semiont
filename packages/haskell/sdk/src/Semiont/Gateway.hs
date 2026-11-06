{-# LANGUAGE OverloadedStrings #-}

module Semiont.Gateway (GatewayOperations(..), gatewayUrl) where
import Data.Aeson (toJSON)
import Data.Text (Text)
import qualified Data.Text as T
import Semiont.HostName (isValidHostname)
import Semiont.Internal.Generated.Schemas (schemas)
import Semiont.Internal.Schema (validateNamed)
import Semiont.Types

data GatewayOperations = GatewayOperations
  { getCurrentUser :: Maybe Text -> IO UserResponse
  , getMediaToken :: ResourceId -> IO MediaTokenResponse
  , getProtectedResourceMetadata :: IO ProtectedResourceMetadata
  , healthCheck :: IO HealthResponse
  , getStatus :: IO StatusResponse
  }

-- Preserve a numeric-looking host as a name; URL parsers may reinterpret it.
gatewayUrl :: HttpEndpoint -> Either Text Text
gatewayUrl endpoint = do
  either (Left . T.pack) Right (validateNamed schemas "HttpEndpoint" (toJSON endpoint))
  if not (isValidHostname (httpEndpointHost endpoint))
    then Left "invalid gateway hostname"
    else Right (scheme (httpEndpointProtocol endpoint) <> "://" <> T.toLower (httpEndpointHost endpoint)
      <> ":" <> T.pack (show (httpEndpointPort endpoint)))
  where
    scheme HttpEndpointProtocolHttp = "http"
    scheme HttpEndpointProtocolHttps = "https"
