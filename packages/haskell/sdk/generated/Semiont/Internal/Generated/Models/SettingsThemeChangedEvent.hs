-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SettingsThemeChangedEvent
  ( SettingsThemeChangedEvent(..)
  , SettingsThemeChangedEventTheme(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data SettingsThemeChangedEvent = SettingsThemeChangedEvent { settingsThemeChangedEventTheme :: SettingsThemeChangedEventTheme, settingsThemeChangedEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON SettingsThemeChangedEvent where
  parseJSON = checked "SettingsThemeChangedEvent" $ withObject "SettingsThemeChangedEvent" (\fields -> SettingsThemeChangedEvent <$> fields .: "theme" <*> traverse parseJSON (withoutFields ["theme"] fields))
instance ToJSON SettingsThemeChangedEvent where toJSON value = Object (KM.fromList (concat [[("theme", toJSON (settingsThemeChangedEventTheme value))]]) <> fmap toJSON (withoutFields ["theme"] (settingsThemeChangedEventAdditionalProperties value)))

data SettingsThemeChangedEventTheme = SettingsThemeChangedEventThemeLight | SettingsThemeChangedEventThemeDark | SettingsThemeChangedEventThemeSystem deriving (Eq, Show)
instance FromJSON SettingsThemeChangedEventTheme where
  parseJSON = checked "SettingsThemeChangedEventTheme" $ \value -> if value == (String "light") then pure SettingsThemeChangedEventThemeLight else if value == (String "dark") then pure SettingsThemeChangedEventThemeDark else if value == (String "system") then pure SettingsThemeChangedEventThemeSystem else fail "unknown enumeration member"
instance ToJSON SettingsThemeChangedEventTheme where
  toJSON SettingsThemeChangedEventThemeLight = String "light"
  toJSON SettingsThemeChangedEventThemeDark = String "dark"
  toJSON SettingsThemeChangedEventThemeSystem = String "system"
