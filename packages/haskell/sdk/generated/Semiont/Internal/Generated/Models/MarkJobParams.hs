-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkJobParams
  ( MarkJobParams(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AssessingJobParams
import Semiont.Internal.Generated.Models.CommentingJobParams
import Semiont.Internal.Generated.Models.HighlightingJobParams
import Semiont.Internal.Generated.Models.LinkingJobParams
import Semiont.Internal.Generated.Models.TaggingJobParams
data MarkJobParams = MarkJobParamsBranch1 (HighlightingJobParams) | MarkJobParamsBranch2 (CommentingJobParams) | MarkJobParamsBranch3 (AssessingJobParams) | MarkJobParamsBranch4 (LinkingJobParams) | MarkJobParamsBranch5 (TaggingJobParams) deriving (Eq, Show)
instance FromJSON MarkJobParams where
  parseJSON = checked "MarkJobParams" $ \value -> (MarkJobParamsBranch1 <$> parseJSON value) <|> (MarkJobParamsBranch2 <$> parseJSON value) <|> (MarkJobParamsBranch3 <$> parseJSON value) <|> (MarkJobParamsBranch4 <$> parseJSON value) <|> (MarkJobParamsBranch5 <$> parseJSON value)
instance ToJSON MarkJobParams where
  toJSON (MarkJobParamsBranch1 value) = toJSON value
  toJSON (MarkJobParamsBranch2 value) = toJSON value
  toJSON (MarkJobParamsBranch3 value) = toJSON value
  toJSON (MarkJobParamsBranch4 value) = toJSON value
  toJSON (MarkJobParamsBranch5 value) = toJSON value


