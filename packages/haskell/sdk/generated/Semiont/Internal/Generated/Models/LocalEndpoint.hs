-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.LocalEndpoint
  ( LocalEndpoint(..)
  , LocalEndpointKind(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data LocalEndpoint = LocalEndpoint { localEndpointKbId :: Text, localEndpointKind :: LocalEndpointKind, localEndpointAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON LocalEndpoint where
  parseJSON = checked "LocalEndpoint" $ withObject "LocalEndpoint" (\fields -> LocalEndpoint <$> fields .: "kbId" <*> fields .: "kind" <*> traverse parseJSON (withoutFields ["kbId", "kind"] fields))
instance ToJSON LocalEndpoint where toJSON value = Object (KM.fromList (concat [[("kbId", toJSON (localEndpointKbId value))], [("kind", toJSON (localEndpointKind value))]]) <> fmap toJSON (withoutFields ["kbId", "kind"] (localEndpointAdditionalProperties value)))

data LocalEndpointKind = LocalEndpointKindLocal deriving (Eq, Show)
instance FromJSON LocalEndpointKind where
  parseJSON = checked "LocalEndpointKind" $ \value -> if value == (String "local") then pure LocalEndpointKindLocal else fail "unknown enumeration member"
instance ToJSON LocalEndpointKind where
  toJSON LocalEndpointKindLocal = String "local"
