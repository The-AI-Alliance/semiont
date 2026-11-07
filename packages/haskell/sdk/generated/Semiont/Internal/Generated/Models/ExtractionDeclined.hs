-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ExtractionDeclined
  ( ExtractionDeclined(..)
  , ExtractionDeclinedDeclined(..)
  , ExtractionDeclinedKind(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data ExtractionDeclined = ExtractionDeclined { extractionDeclinedDeclined :: ExtractionDeclinedDeclined, extractionDeclinedKind :: ExtractionDeclinedKind, extractionDeclinedAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ExtractionDeclined where
  parseJSON = checked "ExtractionDeclined" $ withObject "ExtractionDeclined" (\fields -> ExtractionDeclined <$> fields .: "declined" <*> fields .: "kind" <*> traverse parseJSON (withoutFields ["declined", "kind"] fields))
instance ToJSON ExtractionDeclined where toJSON value = Object (KM.fromList (concat [[("declined", toJSON (extractionDeclinedDeclined value))], [("kind", toJSON (extractionDeclinedKind value))]]) <> fmap toJSON (withoutFields ["declined", "kind"] (extractionDeclinedAdditionalProperties value)))

data ExtractionDeclinedDeclined = ExtractionDeclinedDeclinedNoU2d_textU2d_layer | ExtractionDeclinedDeclinedEncrypted | ExtractionDeclinedDeclinedCorrupt | ExtractionDeclinedDeclinedTooU2d_large deriving (Eq, Show)
instance FromJSON ExtractionDeclinedDeclined where
  parseJSON = checked "ExtractionDeclinedDeclined" $ \value -> if value == (String "no-text-layer") then pure ExtractionDeclinedDeclinedNoU2d_textU2d_layer else if value == (String "encrypted") then pure ExtractionDeclinedDeclinedEncrypted else if value == (String "corrupt") then pure ExtractionDeclinedDeclinedCorrupt else if value == (String "too-large") then pure ExtractionDeclinedDeclinedTooU2d_large else fail "unknown enumeration member"
instance ToJSON ExtractionDeclinedDeclined where
  toJSON ExtractionDeclinedDeclinedNoU2d_textU2d_layer = String "no-text-layer"
  toJSON ExtractionDeclinedDeclinedEncrypted = String "encrypted"
  toJSON ExtractionDeclinedDeclinedCorrupt = String "corrupt"
  toJSON ExtractionDeclinedDeclinedTooU2d_large = String "too-large"


data ExtractionDeclinedKind = ExtractionDeclinedKindDeclined deriving (Eq, Show)
instance FromJSON ExtractionDeclinedKind where
  parseJSON = checked "ExtractionDeclinedKind" $ \value -> if value == (String "declined") then pure ExtractionDeclinedKindDeclined else fail "unknown enumeration member"
instance ToJSON ExtractionDeclinedKind where
  toJSON ExtractionDeclinedKindDeclined = String "declined"
