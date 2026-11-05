-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.EphemeralEventId
  ( EphemeralEventId(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
newtype EphemeralEventId = EphemeralEventId { ephemeralEventIdValue :: Text } deriving (Eq, Show)
instance FromJSON EphemeralEventId where
  parseJSON = checked "EphemeralEventId" $ \value -> EphemeralEventId <$> parseJSON value
instance ToJSON EphemeralEventId where toJSON (EphemeralEventId value) = toJSON value

