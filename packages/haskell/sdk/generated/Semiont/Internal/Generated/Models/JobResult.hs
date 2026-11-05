-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobResult
  ( JobResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.JobDeclined
import Semiont.Internal.Generated.Models.MarkJobDone
import Semiont.Internal.Generated.Models.YieldJobDone
data JobResult = JobResultBranch1 (MarkJobDone) | JobResultBranch2 (YieldJobDone) | JobResultBranch3 (JobDeclined) deriving (Eq, Show)
instance FromJSON JobResult where
  parseJSON = checked "JobResult" $ \value -> (JobResultBranch1 <$> parseJSON value) <|> (JobResultBranch2 <$> parseJSON value) <|> (JobResultBranch3 <$> parseJSON value)
instance ToJSON JobResult where
  toJSON (JobResultBranch1 value) = toJSON value
  toJSON (JobResultBranch2 value) = toJSON value
  toJSON (JobResultBranch3 value) = toJSON value


