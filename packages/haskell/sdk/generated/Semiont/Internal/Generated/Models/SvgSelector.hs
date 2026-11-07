-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SvgSelector
  ( SvgSelector(..)
  , SvgSelectorType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data SvgSelector = SvgSelector { svgSelectorType :: SvgSelectorType, svgSelectorValue :: Text, svgSelectorAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON SvgSelector where
  parseJSON = checked "SvgSelector" $ withObject "SvgSelector" (\fields -> SvgSelector <$> fields .: "type" <*> fields .: "value" <*> traverse parseJSON (withoutFields ["type", "value"] fields))
instance ToJSON SvgSelector where toJSON value = Object (KM.fromList (concat [[("type", toJSON (svgSelectorType value))], [("value", toJSON (svgSelectorValue value))]]) <> fmap toJSON (withoutFields ["type", "value"] (svgSelectorAdditionalProperties value)))

data SvgSelectorType = SvgSelectorTypeSvgSelector deriving (Eq, Show)
instance FromJSON SvgSelectorType where
  parseJSON = checked "SvgSelectorType" $ \value -> if value == (String "SvgSelector") then pure SvgSelectorTypeSvgSelector else fail "unknown enumeration member"
instance ToJSON SvgSelectorType where
  toJSON SvgSelectorTypeSvgSelector = String "SvgSelector"
