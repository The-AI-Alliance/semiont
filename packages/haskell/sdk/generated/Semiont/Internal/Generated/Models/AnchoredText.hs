-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnchoredText
  ( AnchoredText(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.PdfTextItem
data AnchoredText = AnchoredText { anchoredTextItems :: [PdfTextItem], anchoredTextText :: Text, anchoredTextAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON AnchoredText where
  parseJSON = checked "AnchoredText" $ withObject "AnchoredText" (\fields -> AnchoredText <$> fields .: "items" <*> fields .: "text" <*> traverse parseJSON (withoutFields ["items", "text"] fields))
instance ToJSON AnchoredText where toJSON value = Object (KM.fromList (concat [[("items", toJSON (anchoredTextItems value))], [("text", toJSON (anchoredTextText value))]]) <> fmap toJSON (withoutFields ["items", "text"] (anchoredTextAdditionalProperties value)))

