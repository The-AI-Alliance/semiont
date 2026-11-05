-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.HttpEndpoint
  ( HttpEndpoint(..)
  , HttpEndpointKind(..)
  , HttpEndpointProtocol(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data HttpEndpoint = HttpEndpoint { httpEndpointHost :: Text, httpEndpointKind :: HttpEndpointKind, httpEndpointPort :: Integer, httpEndpointProtocol :: HttpEndpointProtocol, httpEndpointAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON HttpEndpoint where
  parseJSON = checked "HttpEndpoint" $ withObject "HttpEndpoint" (\fields -> HttpEndpoint <$> fields .: "host" <*> fields .: "kind" <*> fields .: "port" <*> fields .: "protocol" <*> traverse parseJSON (withoutFields ["host", "kind", "port", "protocol"] fields))
instance ToJSON HttpEndpoint where toJSON value = Object (KM.fromList (concat [[("host", toJSON (httpEndpointHost value))], [("kind", toJSON (httpEndpointKind value))], [("port", toJSON (httpEndpointPort value))], [("protocol", toJSON (httpEndpointProtocol value))]]) <> fmap toJSON (withoutFields ["host", "kind", "port", "protocol"] (httpEndpointAdditionalProperties value)))

data HttpEndpointKind = HttpEndpointKindHttp deriving (Eq, Show)
instance FromJSON HttpEndpointKind where
  parseJSON = checked "HttpEndpointKind" $ \value -> if value == (String "http") then pure HttpEndpointKindHttp else fail "unknown enumeration member"
instance ToJSON HttpEndpointKind where
  toJSON HttpEndpointKindHttp = String "http"


data HttpEndpointProtocol = HttpEndpointProtocolHttp | HttpEndpointProtocolHttps deriving (Eq, Show)
instance FromJSON HttpEndpointProtocol where
  parseJSON = checked "HttpEndpointProtocol" $ \value -> if value == (String "http") then pure HttpEndpointProtocolHttp else if value == (String "https") then pure HttpEndpointProtocolHttps else fail "unknown enumeration member"
instance ToJSON HttpEndpointProtocol where
  toJSON HttpEndpointProtocolHttp = String "http"
  toJSON HttpEndpointProtocolHttps = String "https"
