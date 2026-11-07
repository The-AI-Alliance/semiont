-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnchoredTextAnswer
  ( AnchoredTextAnswer(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnchoredTextAbsent
import Semiont.Internal.Generated.Models.ExtractedText
import Semiont.Internal.Generated.Models.ExtractionDeclined
data AnchoredTextAnswer = AnchoredTextAnswerBranch1 (ExtractedText) | AnchoredTextAnswerBranch2 (ExtractionDeclined) | AnchoredTextAnswerBranch3 (AnchoredTextAbsent) deriving (Eq, Show)
instance FromJSON AnchoredTextAnswer where
  parseJSON = checked "AnchoredTextAnswer" $ \value -> (AnchoredTextAnswerBranch1 <$> parseJSON value) <|> (AnchoredTextAnswerBranch2 <$> parseJSON value) <|> (AnchoredTextAnswerBranch3 <$> parseJSON value)
instance ToJSON AnchoredTextAnswer where
  toJSON (AnchoredTextAnswerBranch1 value) = toJSON value
  toJSON (AnchoredTextAnswerBranch2 value) = toJSON value
  toJSON (AnchoredTextAnswerBranch3 value) = toJSON value
