-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.PersistedEventId
  ( PersistedEventId(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
newtype PersistedEventId = PersistedEventId { persistedEventIdValue :: Text } deriving (Eq, Show)
instance FromJSON PersistedEventId where
  parseJSON = checked "PersistedEventId" $ \value -> PersistedEventId <$> parseJSON value
instance ToJSON PersistedEventId where toJSON (PersistedEventId value) = toJSON value
