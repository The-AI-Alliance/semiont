-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.DiscoveredKB
  ( DiscoveredKB(..)
  , DiscoveredKBPlacement(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data DiscoveredKB = DiscoveredKB { discoveredKBDid :: Text, discoveredKBHost :: Text, discoveredKBManagedBy :: Text, discoveredKBPlacement :: DiscoveredKBPlacement, discoveredKBPort :: Integer, discoveredKBRepo :: Maybe (Text), discoveredKBSiteName :: Maybe (Text), discoveredKBAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON DiscoveredKB where
  parseJSON = checked "DiscoveredKB" $ withObject "DiscoveredKB" (\fields -> DiscoveredKB <$> fields .: "did" <*> fields .: "host" <*> fields .: "managedBy" <*> fields .: "placement" <*> fields .: "port" <*> optional fields "repo" <*> optional fields "siteName" <*> traverse parseJSON (withoutFields ["did", "host", "managedBy", "placement", "port", "repo", "siteName"] fields))
instance ToJSON DiscoveredKB where toJSON value = Object (KM.fromList (concat [[("did", toJSON (discoveredKBDid value))], [("host", toJSON (discoveredKBHost value))], [("managedBy", toJSON (discoveredKBManagedBy value))], [("placement", toJSON (discoveredKBPlacement value))], [("port", toJSON (discoveredKBPort value))], optionalPair "repo" (discoveredKBRepo value), optionalPair "siteName" (discoveredKBSiteName value)]) <> fmap toJSON (withoutFields ["did", "host", "managedBy", "placement", "port", "repo", "siteName"] (discoveredKBAdditionalProperties value)))

data DiscoveredKBPlacement = DiscoveredKBPlacementLocal | DiscoveredKBPlacementCodespace deriving (Eq, Show)
instance FromJSON DiscoveredKBPlacement where
  parseJSON = checked "DiscoveredKBPlacement" $ \value -> if value == (String "local") then pure DiscoveredKBPlacementLocal else if value == (String "codespace") then pure DiscoveredKBPlacementCodespace else fail "unknown enumeration member"
instance ToJSON DiscoveredKBPlacement where
  toJSON DiscoveredKBPlacementLocal = String "local"
  toJSON DiscoveredKBPlacementCodespace = String "codespace"
