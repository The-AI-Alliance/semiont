-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ExtractedText
  ( ExtractedText(..)
  , ExtractedTextKind(..)
  , ExtractedTextMethod(..)
  , ExtractedTextOcrConfidence(..)
  , ExtractedTextPdfClass(..)
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
data ExtractedText = ExtractedText { extractedTextItems :: [PdfTextItem], extractedTextKind :: ExtractedTextKind, extractedTextMethod :: ExtractedTextMethod, extractedTextOcrConfidence :: Maybe (ExtractedTextOcrConfidence), extractedTextPdfClass :: Maybe (ExtractedTextPdfClass), extractedTextText :: Text, extractedTextUnreadPages :: Maybe ([Integer]), extractedTextAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ExtractedText where
  parseJSON = checked "ExtractedText" $ withObject "ExtractedText" (\fields -> ExtractedText <$> fields .: "items" <*> fields .: "kind" <*> fields .: "method" <*> optional fields "ocrConfidence" <*> optional fields "pdfClass" <*> fields .: "text" <*> optional fields "unreadPages" <*> traverse parseJSON (withoutFields ["items", "kind", "method", "ocrConfidence", "pdfClass", "text", "unreadPages"] fields))
instance ToJSON ExtractedText where toJSON value = Object (KM.fromList (concat [[("items", toJSON (extractedTextItems value))], [("kind", toJSON (extractedTextKind value))], [("method", toJSON (extractedTextMethod value))], optionalPair "ocrConfidence" (extractedTextOcrConfidence value), optionalPair "pdfClass" (extractedTextPdfClass value), [("text", toJSON (extractedTextText value))], optionalPair "unreadPages" (extractedTextUnreadPages value)]) <> fmap toJSON (withoutFields ["items", "kind", "method", "ocrConfidence", "pdfClass", "text", "unreadPages"] (extractedTextAdditionalProperties value)))

data ExtractedTextKind = ExtractedTextKindExtracted deriving (Eq, Show)
instance FromJSON ExtractedTextKind where
  parseJSON = checked "ExtractedTextKind" $ \value -> if value == (String "extracted") then pure ExtractedTextKindExtracted else fail "unknown enumeration member"
instance ToJSON ExtractedTextKind where
  toJSON ExtractedTextKindExtracted = String "extracted"


data ExtractedTextMethod = ExtractedTextMethodTextU2d_passthrough | ExtractedTextMethodPdfU2d_textU2d_layer | ExtractedTextMethodTable | ExtractedTextMethodForm | ExtractedTextMethodOcr deriving (Eq, Show)
instance FromJSON ExtractedTextMethod where
  parseJSON = checked "ExtractedTextMethod" $ \value -> if value == (String "text-passthrough") then pure ExtractedTextMethodTextU2d_passthrough else if value == (String "pdf-text-layer") then pure ExtractedTextMethodPdfU2d_textU2d_layer else if value == (String "table") then pure ExtractedTextMethodTable else if value == (String "form") then pure ExtractedTextMethodForm else if value == (String "ocr") then pure ExtractedTextMethodOcr else fail "unknown enumeration member"
instance ToJSON ExtractedTextMethod where
  toJSON ExtractedTextMethodTextU2d_passthrough = String "text-passthrough"
  toJSON ExtractedTextMethodPdfU2d_textU2d_layer = String "pdf-text-layer"
  toJSON ExtractedTextMethodTable = String "table"
  toJSON ExtractedTextMethodForm = String "form"
  toJSON ExtractedTextMethodOcr = String "ocr"


data ExtractedTextOcrConfidence = ExtractedTextOcrConfidence { extractedTextOcrConfidenceLowConfidenceWords :: Integer, extractedTextOcrConfidenceMean :: Scientific, extractedTextOcrConfidenceTotalWords :: Integer, extractedTextOcrConfidenceAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ExtractedTextOcrConfidence where
  parseJSON = checked "ExtractedTextOcrConfidence" $ withObject "ExtractedTextOcrConfidence" (\fields -> ExtractedTextOcrConfidence <$> fields .: "lowConfidenceWords" <*> fields .: "mean" <*> fields .: "totalWords" <*> traverse parseJSON (withoutFields ["lowConfidenceWords", "mean", "totalWords"] fields))
instance ToJSON ExtractedTextOcrConfidence where toJSON value = Object (KM.fromList (concat [[("lowConfidenceWords", toJSON (extractedTextOcrConfidenceLowConfidenceWords value))], [("mean", toJSON (extractedTextOcrConfidenceMean value))], [("totalWords", toJSON (extractedTextOcrConfidenceTotalWords value))]]) <> fmap toJSON (withoutFields ["lowConfidenceWords", "mean", "totalWords"] (extractedTextOcrConfidenceAdditionalProperties value)))

data ExtractedTextPdfClass = ExtractedTextPdfClassA | ExtractedTextPdfClassB | ExtractedTextPdfClassC | ExtractedTextPdfClassD | ExtractedTextPdfClassE | ExtractedTextPdfClassF | ExtractedTextPdfClassG deriving (Eq, Show)
instance FromJSON ExtractedTextPdfClass where
  parseJSON = checked "ExtractedTextPdfClass" $ \value -> if value == (String "A") then pure ExtractedTextPdfClassA else if value == (String "B") then pure ExtractedTextPdfClassB else if value == (String "C") then pure ExtractedTextPdfClassC else if value == (String "D") then pure ExtractedTextPdfClassD else if value == (String "E") then pure ExtractedTextPdfClassE else if value == (String "F") then pure ExtractedTextPdfClassF else if value == (String "G") then pure ExtractedTextPdfClassG else fail "unknown enumeration member"
instance ToJSON ExtractedTextPdfClass where
  toJSON ExtractedTextPdfClassA = String "A"
  toJSON ExtractedTextPdfClassB = String "B"
  toJSON ExtractedTextPdfClassC = String "C"
  toJSON ExtractedTextPdfClassD = String "D"
  toJSON ExtractedTextPdfClassE = String "E"
  toJSON ExtractedTextPdfClassF = String "F"
  toJSON ExtractedTextPdfClassG = String "G"


