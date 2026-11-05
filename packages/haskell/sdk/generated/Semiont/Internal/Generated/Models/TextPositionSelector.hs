-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.TextPositionSelector
  ( TextPositionSelector(..)
  , TextPositionSelectorType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data TextPositionSelector = TextPositionSelector { textPositionSelectorEnd :: Integer, textPositionSelectorStart :: Integer, textPositionSelectorType :: TextPositionSelectorType, textPositionSelectorAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON TextPositionSelector where
  parseJSON = checked "TextPositionSelector" $ withObject "TextPositionSelector" (\fields -> TextPositionSelector <$> fields .: "end" <*> fields .: "start" <*> fields .: "type" <*> traverse parseJSON (withoutFields ["end", "start", "type"] fields))
instance ToJSON TextPositionSelector where toJSON value = Object (KM.fromList (concat [[("end", toJSON (textPositionSelectorEnd value))], [("start", toJSON (textPositionSelectorStart value))], [("type", toJSON (textPositionSelectorType value))]]) <> fmap toJSON (withoutFields ["end", "start", "type"] (textPositionSelectorAdditionalProperties value)))

data TextPositionSelectorType = TextPositionSelectorTypeTextPositionSelector deriving (Eq, Show)
instance FromJSON TextPositionSelectorType where
  parseJSON = checked "TextPositionSelectorType" $ \value -> if value == (String "TextPositionSelector") then pure TextPositionSelectorTypeTextPositionSelector else fail "unknown enumeration member"
instance ToJSON TextPositionSelectorType where
  toJSON TextPositionSelectorTypeTextPositionSelector = String "TextPositionSelector"


