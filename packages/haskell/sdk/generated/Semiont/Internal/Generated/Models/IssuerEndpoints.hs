-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.IssuerEndpoints
  ( IssuerEndpoints(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data IssuerEndpoints = IssuerEndpoints { issuerEndpointsAuthorization :: Text, issuerEndpointsDevice :: Maybe (Text), issuerEndpointsIssuer :: Text, issuerEndpointsRevocation :: Maybe (Text), issuerEndpointsToken :: Text, issuerEndpointsAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON IssuerEndpoints where
  parseJSON = checked "IssuerEndpoints" $ withObject "IssuerEndpoints" (\fields -> IssuerEndpoints <$> fields .: "authorization" <*> optional fields "device" <*> fields .: "issuer" <*> optional fields "revocation" <*> fields .: "token" <*> traverse parseJSON (withoutFields ["authorization", "device", "issuer", "revocation", "token"] fields))
instance ToJSON IssuerEndpoints where toJSON value = Object (KM.fromList (concat [[("authorization", toJSON (issuerEndpointsAuthorization value))], optionalPair "device" (issuerEndpointsDevice value), [("issuer", toJSON (issuerEndpointsIssuer value))], optionalPair "revocation" (issuerEndpointsRevocation value), [("token", toJSON (issuerEndpointsToken value))]]) <> fmap toJSON (withoutFields ["authorization", "device", "issuer", "revocation", "token"] (issuerEndpointsAdditionalProperties value)))
