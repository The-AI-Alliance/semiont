-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ResourceId
  ( ResourceId, resourceIdValue, mkResourceId
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
newtype ResourceId = ResourceId (Text) deriving (Eq, Ord, Show)
instance FromJSON ResourceId where
  parseJSON = checked "ResourceId" $ \value -> ResourceId <$> parseJSON value
instance ToJSON ResourceId where toJSON (ResourceId value) = toJSON value
resourceIdValue :: ResourceId -> Text
resourceIdValue (ResourceId value) = value
mkResourceId :: Text -> Either String ResourceId
mkResourceId value = parseEither parseJSON (toJSON value)
