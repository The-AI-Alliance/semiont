-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.UnitCursor
  ( UnitCursor(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data UnitCursor = UnitCursor { unitCursorEmitted :: Integer, unitCursorErrors :: Integer, unitCursorFound :: Integer, unitCursorNext :: Integer, unitCursorSize :: Integer, unitCursorAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON UnitCursor where
  parseJSON = checked "UnitCursor" $ withObject "UnitCursor" (\fields -> UnitCursor <$> fields .: "emitted" <*> fields .: "errors" <*> fields .: "found" <*> fields .: "next" <*> fields .: "size" <*> traverse parseJSON (withoutFields ["emitted", "errors", "found", "next", "size"] fields))
instance ToJSON UnitCursor where toJSON value = Object (KM.fromList (concat [[("emitted", toJSON (unitCursorEmitted value))], [("errors", toJSON (unitCursorErrors value))], [("found", toJSON (unitCursorFound value))], [("next", toJSON (unitCursorNext value))], [("size", toJSON (unitCursorSize value))]]) <> fmap toJSON (withoutFields ["emitted", "errors", "found", "next", "size"] (unitCursorAdditionalProperties value)))
