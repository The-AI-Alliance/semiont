-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.NeptuneGraphConfig
  ( NeptuneGraphConfig(..)
  , NeptuneGraphConfigType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data NeptuneGraphConfig = NeptuneGraphConfig { neptuneGraphConfigEndpoint :: Text, neptuneGraphConfigPort :: Integer, neptuneGraphConfigType :: NeptuneGraphConfigType } deriving (Eq, Show)
instance FromJSON NeptuneGraphConfig where
  parseJSON = checked "NeptuneGraphConfig" $ withObject "NeptuneGraphConfig" (\fields -> NeptuneGraphConfig <$> fields .: "endpoint" <*> fields .: "port" <*> fields .: "type")
instance ToJSON NeptuneGraphConfig where toJSON value = Object (KM.fromList (concat [[("endpoint", toJSON (neptuneGraphConfigEndpoint value))], [("port", toJSON (neptuneGraphConfigPort value))], [("type", toJSON (neptuneGraphConfigType value))]]))

data NeptuneGraphConfigType = NeptuneGraphConfigTypeNeptune deriving (Eq, Show)
instance FromJSON NeptuneGraphConfigType where
  parseJSON = checked "NeptuneGraphConfigType" $ \value -> if value == (String "neptune") then pure NeptuneGraphConfigTypeNeptune else fail "unknown enumeration member"
instance ToJSON NeptuneGraphConfigType where
  toJSON NeptuneGraphConfigTypeNeptune = String "neptune"
