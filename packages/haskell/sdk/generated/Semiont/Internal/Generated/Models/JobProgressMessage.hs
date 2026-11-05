-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobProgressMessage
  ( JobProgressMessage(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.JobProgressAnalyzing
import Semiont.Internal.Generated.Models.JobProgressAnalyzingTags
import Semiont.Internal.Generated.Models.JobProgressCompleteCreated
import Semiont.Internal.Generated.Models.JobProgressCompleteGenerated
import Semiont.Internal.Generated.Models.JobProgressCreatingAnnotations
import Semiont.Internal.Generated.Models.JobProgressCreatingResource
import Semiont.Internal.Generated.Models.JobProgressCreatingTagAnnotations
import Semiont.Internal.Generated.Models.JobProgressDetectingEntities
import Semiont.Internal.Generated.Models.JobProgressGeneratingResource
import Semiont.Internal.Generated.Models.JobProgressLoading
data JobProgressMessage = JobProgressMessageBranch1 (JobProgressLoading) | JobProgressMessageBranch2 (JobProgressAnalyzing) | JobProgressMessageBranch3 (JobProgressAnalyzingTags) | JobProgressMessageBranch4 (JobProgressGeneratingResource) | JobProgressMessageBranch5 (JobProgressCreatingResource) | JobProgressMessageBranch6 (JobProgressCompleteGenerated) | JobProgressMessageBranch7 (JobProgressDetectingEntities) | JobProgressMessageBranch8 (JobProgressCreatingAnnotations) | JobProgressMessageBranch9 (JobProgressCreatingTagAnnotations) | JobProgressMessageBranch10 (JobProgressCompleteCreated) deriving (Eq, Show)
instance FromJSON JobProgressMessage where
  parseJSON = checked "JobProgressMessage" $ \value -> (JobProgressMessageBranch1 <$> parseJSON value) <|> (JobProgressMessageBranch2 <$> parseJSON value) <|> (JobProgressMessageBranch3 <$> parseJSON value) <|> (JobProgressMessageBranch4 <$> parseJSON value) <|> (JobProgressMessageBranch5 <$> parseJSON value) <|> (JobProgressMessageBranch6 <$> parseJSON value) <|> (JobProgressMessageBranch7 <$> parseJSON value) <|> (JobProgressMessageBranch8 <$> parseJSON value) <|> (JobProgressMessageBranch9 <$> parseJSON value) <|> (JobProgressMessageBranch10 <$> parseJSON value)
instance ToJSON JobProgressMessage where
  toJSON (JobProgressMessageBranch1 value) = toJSON value
  toJSON (JobProgressMessageBranch2 value) = toJSON value
  toJSON (JobProgressMessageBranch3 value) = toJSON value
  toJSON (JobProgressMessageBranch4 value) = toJSON value
  toJSON (JobProgressMessageBranch5 value) = toJSON value
  toJSON (JobProgressMessageBranch6 value) = toJSON value
  toJSON (JobProgressMessageBranch7 value) = toJSON value
  toJSON (JobProgressMessageBranch8 value) = toJSON value
  toJSON (JobProgressMessageBranch9 value) = toJSON value
  toJSON (JobProgressMessageBranch10 value) = toJSON value


