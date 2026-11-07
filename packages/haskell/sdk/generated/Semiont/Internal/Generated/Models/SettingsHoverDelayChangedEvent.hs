-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SettingsHoverDelayChangedEvent
  ( SettingsHoverDelayChangedEvent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data SettingsHoverDelayChangedEvent = SettingsHoverDelayChangedEvent { settingsHoverDelayChangedEventHoverDelayMs :: Integer, settingsHoverDelayChangedEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON SettingsHoverDelayChangedEvent where
  parseJSON = checked "SettingsHoverDelayChangedEvent" $ withObject "SettingsHoverDelayChangedEvent" (\fields -> SettingsHoverDelayChangedEvent <$> fields .: "hoverDelayMs" <*> traverse parseJSON (withoutFields ["hoverDelayMs"] fields))
instance ToJSON SettingsHoverDelayChangedEvent where toJSON value = Object (KM.fromList (concat [[("hoverDelayMs", toJSON (settingsHoverDelayChangedEventHoverDelayMs value))]]) <> fmap toJSON (withoutFields ["hoverDelayMs"] (settingsHoverDelayChangedEventAdditionalProperties value)))
