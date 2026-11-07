-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.PdfCoordinate
  ( PdfCoordinate(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data PdfCoordinate = PdfCoordinate { pdfCoordinateHeight :: Scientific, pdfCoordinatePage :: Scientific, pdfCoordinateWidth :: Scientific, pdfCoordinateX :: Scientific, pdfCoordinateY :: Scientific, pdfCoordinateAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON PdfCoordinate where
  parseJSON = checked "PdfCoordinate" $ withObject "PdfCoordinate" (\fields -> PdfCoordinate <$> fields .: "height" <*> fields .: "page" <*> fields .: "width" <*> fields .: "x" <*> fields .: "y" <*> traverse parseJSON (withoutFields ["height", "page", "width", "x", "y"] fields))
instance ToJSON PdfCoordinate where toJSON value = Object (KM.fromList (concat [[("height", toJSON (pdfCoordinateHeight value))], [("page", toJSON (pdfCoordinatePage value))], [("width", toJSON (pdfCoordinateWidth value))], [("x", toJSON (pdfCoordinateX value))], [("y", toJSON (pdfCoordinateY value))]]) <> fmap toJSON (withoutFields ["height", "page", "width", "x", "y"] (pdfCoordinateAdditionalProperties value)))
