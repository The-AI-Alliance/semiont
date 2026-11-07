-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.DiscoveryDocument
  ( DiscoveryDocument(..)
  , DiscoveryDocumentVersion(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.DiscoveredKB
data DiscoveryDocument = DiscoveryDocument { discoveryDocumentKbs :: [DiscoveredKB], discoveryDocumentVersion :: DiscoveryDocumentVersion, discoveryDocumentAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON DiscoveryDocument where
  parseJSON = checked "DiscoveryDocument" $ withObject "DiscoveryDocument" (\fields -> DiscoveryDocument <$> fields .: "kbs" <*> fields .: "version" <*> traverse parseJSON (withoutFields ["kbs", "version"] fields))
instance ToJSON DiscoveryDocument where toJSON value = Object (KM.fromList (concat [[("kbs", toJSON (discoveryDocumentKbs value))], [("version", toJSON (discoveryDocumentVersion value))]]) <> fmap toJSON (withoutFields ["kbs", "version"] (discoveryDocumentAdditionalProperties value)))

data DiscoveryDocumentVersion = DiscoveryDocumentVersionV1U2e_0 deriving (Eq, Show)
instance FromJSON DiscoveryDocumentVersion where
  parseJSON = checked "DiscoveryDocumentVersion" $ \value -> if value == (Number (read "1.0")) then pure DiscoveryDocumentVersionV1U2e_0 else fail "unknown enumeration member"
instance ToJSON DiscoveryDocumentVersion where
  toJSON DiscoveryDocumentVersionV1U2e_0 = Number (read "1.0")
