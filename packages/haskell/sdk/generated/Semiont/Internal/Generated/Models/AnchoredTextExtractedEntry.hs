-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnchoredTextExtractedEntry
  ( AnchoredTextExtractedEntry(..)
  , AnchoredTextExtractedEntryLinesItem(..)
  , AnchoredTextExtractedEntryMethod(..)
  , AnchoredTextExtractedEntryOcrConfidence(..)
  , AnchoredTextExtractedEntryPdfClass(..)
  , AnchoredTextExtractedEntryV(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data AnchoredTextExtractedEntry = AnchoredTextExtractedEntry { anchoredTextExtractedEntryLines :: [AnchoredTextExtractedEntryLinesItem], anchoredTextExtractedEntryMethod :: AnchoredTextExtractedEntryMethod, anchoredTextExtractedEntryOcrConfidence :: Maybe (AnchoredTextExtractedEntryOcrConfidence), anchoredTextExtractedEntryPdfClass :: Maybe (AnchoredTextExtractedEntryPdfClass), anchoredTextExtractedEntryStamp :: Text, anchoredTextExtractedEntryText :: Text, anchoredTextExtractedEntryUnreadPages :: Maybe ([Integer]), anchoredTextExtractedEntryV :: AnchoredTextExtractedEntryV } deriving (Eq, Show)
instance FromJSON AnchoredTextExtractedEntry where
  parseJSON = checked "AnchoredTextExtractedEntry" $ withObject "AnchoredTextExtractedEntry" (\fields -> AnchoredTextExtractedEntry <$> fields .: "lines" <*> fields .: "method" <*> optional fields "ocrConfidence" <*> optional fields "pdfClass" <*> fields .: "stamp" <*> fields .: "text" <*> optional fields "unreadPages" <*> fields .: "v")
instance ToJSON AnchoredTextExtractedEntry where toJSON value = Object (KM.fromList (concat [[("lines", toJSON (anchoredTextExtractedEntryLines value))], [("method", toJSON (anchoredTextExtractedEntryMethod value))], optionalPair "ocrConfidence" (anchoredTextExtractedEntryOcrConfidence value), optionalPair "pdfClass" (anchoredTextExtractedEntryPdfClass value), [("stamp", toJSON (anchoredTextExtractedEntryStamp value))], [("text", toJSON (anchoredTextExtractedEntryText value))], optionalPair "unreadPages" (anchoredTextExtractedEntryUnreadPages value), [("v", toJSON (anchoredTextExtractedEntryV value))]]))

data AnchoredTextExtractedEntryLinesItem = AnchoredTextExtractedEntryLinesItem { anchoredTextExtractedEntryLinesItemH :: Scientific, anchoredTextExtractedEntryLinesItemP :: Integer, anchoredTextExtractedEntryLinesItemWords :: [[Scientific]], anchoredTextExtractedEntryLinesItemY :: Scientific } deriving (Eq, Show)
instance FromJSON AnchoredTextExtractedEntryLinesItem where
  parseJSON = checked "AnchoredTextExtractedEntryLinesItem" $ withObject "AnchoredTextExtractedEntryLinesItem" (\fields -> AnchoredTextExtractedEntryLinesItem <$> fields .: "h" <*> fields .: "p" <*> fields .: "words" <*> fields .: "y")
instance ToJSON AnchoredTextExtractedEntryLinesItem where toJSON value = Object (KM.fromList (concat [[("h", toJSON (anchoredTextExtractedEntryLinesItemH value))], [("p", toJSON (anchoredTextExtractedEntryLinesItemP value))], [("words", toJSON (anchoredTextExtractedEntryLinesItemWords value))], [("y", toJSON (anchoredTextExtractedEntryLinesItemY value))]]))

data AnchoredTextExtractedEntryMethod = AnchoredTextExtractedEntryMethodTextU2d_passthrough | AnchoredTextExtractedEntryMethodPdfU2d_textU2d_layer | AnchoredTextExtractedEntryMethodTable | AnchoredTextExtractedEntryMethodForm | AnchoredTextExtractedEntryMethodOcr deriving (Eq, Show)
instance FromJSON AnchoredTextExtractedEntryMethod where
  parseJSON = checked "AnchoredTextExtractedEntryMethod" $ \value -> if value == (String "text-passthrough") then pure AnchoredTextExtractedEntryMethodTextU2d_passthrough else if value == (String "pdf-text-layer") then pure AnchoredTextExtractedEntryMethodPdfU2d_textU2d_layer else if value == (String "table") then pure AnchoredTextExtractedEntryMethodTable else if value == (String "form") then pure AnchoredTextExtractedEntryMethodForm else if value == (String "ocr") then pure AnchoredTextExtractedEntryMethodOcr else fail "unknown enumeration member"
instance ToJSON AnchoredTextExtractedEntryMethod where
  toJSON AnchoredTextExtractedEntryMethodTextU2d_passthrough = String "text-passthrough"
  toJSON AnchoredTextExtractedEntryMethodPdfU2d_textU2d_layer = String "pdf-text-layer"
  toJSON AnchoredTextExtractedEntryMethodTable = String "table"
  toJSON AnchoredTextExtractedEntryMethodForm = String "form"
  toJSON AnchoredTextExtractedEntryMethodOcr = String "ocr"


data AnchoredTextExtractedEntryOcrConfidence = AnchoredTextExtractedEntryOcrConfidence { anchoredTextExtractedEntryOcrConfidenceLowConfidenceWords :: Integer, anchoredTextExtractedEntryOcrConfidenceMean :: Scientific, anchoredTextExtractedEntryOcrConfidenceTotalWords :: Integer, anchoredTextExtractedEntryOcrConfidenceAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON AnchoredTextExtractedEntryOcrConfidence where
  parseJSON = checked "AnchoredTextExtractedEntryOcrConfidence" $ withObject "AnchoredTextExtractedEntryOcrConfidence" (\fields -> AnchoredTextExtractedEntryOcrConfidence <$> fields .: "lowConfidenceWords" <*> fields .: "mean" <*> fields .: "totalWords" <*> traverse parseJSON (withoutFields ["lowConfidenceWords", "mean", "totalWords"] fields))
instance ToJSON AnchoredTextExtractedEntryOcrConfidence where toJSON value = Object (KM.fromList (concat [[("lowConfidenceWords", toJSON (anchoredTextExtractedEntryOcrConfidenceLowConfidenceWords value))], [("mean", toJSON (anchoredTextExtractedEntryOcrConfidenceMean value))], [("totalWords", toJSON (anchoredTextExtractedEntryOcrConfidenceTotalWords value))]]) <> fmap toJSON (withoutFields ["lowConfidenceWords", "mean", "totalWords"] (anchoredTextExtractedEntryOcrConfidenceAdditionalProperties value)))

data AnchoredTextExtractedEntryPdfClass = AnchoredTextExtractedEntryPdfClassA | AnchoredTextExtractedEntryPdfClassB | AnchoredTextExtractedEntryPdfClassC | AnchoredTextExtractedEntryPdfClassD | AnchoredTextExtractedEntryPdfClassE | AnchoredTextExtractedEntryPdfClassF | AnchoredTextExtractedEntryPdfClassG deriving (Eq, Show)
instance FromJSON AnchoredTextExtractedEntryPdfClass where
  parseJSON = checked "AnchoredTextExtractedEntryPdfClass" $ \value -> if value == (String "A") then pure AnchoredTextExtractedEntryPdfClassA else if value == (String "B") then pure AnchoredTextExtractedEntryPdfClassB else if value == (String "C") then pure AnchoredTextExtractedEntryPdfClassC else if value == (String "D") then pure AnchoredTextExtractedEntryPdfClassD else if value == (String "E") then pure AnchoredTextExtractedEntryPdfClassE else if value == (String "F") then pure AnchoredTextExtractedEntryPdfClassF else if value == (String "G") then pure AnchoredTextExtractedEntryPdfClassG else fail "unknown enumeration member"
instance ToJSON AnchoredTextExtractedEntryPdfClass where
  toJSON AnchoredTextExtractedEntryPdfClassA = String "A"
  toJSON AnchoredTextExtractedEntryPdfClassB = String "B"
  toJSON AnchoredTextExtractedEntryPdfClassC = String "C"
  toJSON AnchoredTextExtractedEntryPdfClassD = String "D"
  toJSON AnchoredTextExtractedEntryPdfClassE = String "E"
  toJSON AnchoredTextExtractedEntryPdfClassF = String "F"
  toJSON AnchoredTextExtractedEntryPdfClassG = String "G"


data AnchoredTextExtractedEntryV = AnchoredTextExtractedEntryVV3U2e_0 deriving (Eq, Show)
instance FromJSON AnchoredTextExtractedEntryV where
  parseJSON = checked "AnchoredTextExtractedEntryV" $ \value -> if value == (Number (read "3.0")) then pure AnchoredTextExtractedEntryVV3U2e_0 else fail "unknown enumeration member"
instance ToJSON AnchoredTextExtractedEntryV where
  toJSON AnchoredTextExtractedEntryVV3U2e_0 = Number (read "3.0")
