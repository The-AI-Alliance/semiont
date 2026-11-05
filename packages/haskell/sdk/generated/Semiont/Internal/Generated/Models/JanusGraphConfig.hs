-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JanusGraphConfig
  ( JanusGraphConfig(..)
  , JanusGraphConfigType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data JanusGraphConfig = JanusGraphConfig { janusGraphConfigHost :: Text, janusGraphConfigPort :: Integer, janusGraphConfigType :: JanusGraphConfigType } deriving (Eq, Show)
instance FromJSON JanusGraphConfig where
  parseJSON = checked "JanusGraphConfig" $ withObject "JanusGraphConfig" (\fields -> JanusGraphConfig <$> fields .: "host" <*> fields .: "port" <*> fields .: "type")
instance ToJSON JanusGraphConfig where toJSON value = Object (KM.fromList (concat [[("host", toJSON (janusGraphConfigHost value))], [("port", toJSON (janusGraphConfigPort value))], [("type", toJSON (janusGraphConfigType value))]]))

data JanusGraphConfigType = JanusGraphConfigTypeJanusgraph deriving (Eq, Show)
instance FromJSON JanusGraphConfigType where
  parseJSON = checked "JanusGraphConfigType" $ \value -> if value == (String "janusgraph") then pure JanusGraphConfigTypeJanusgraph else fail "unknown enumeration member"
instance ToJSON JanusGraphConfigType where
  toJSON JanusGraphConfigTypeJanusgraph = String "janusgraph"


