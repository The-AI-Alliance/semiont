-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobCancelled
  ( JobCancelled(..)
  , JobCancelledStatus(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.JobMetadata
import Semiont.Internal.Generated.Models.JobParams
data JobCancelled = JobCancelled { jobCancelledCompletedAt :: Text, jobCancelledMetadata :: JobMetadata, jobCancelledParams :: JobParams, jobCancelledStartedAt :: Maybe (Text), jobCancelledStatus :: JobCancelledStatus } deriving (Eq, Show)
instance FromJSON JobCancelled where
  parseJSON = checked "JobCancelled" $ withObject "JobCancelled" (\fields -> JobCancelled <$> fields .: "completedAt" <*> fields .: "metadata" <*> fields .: "params" <*> optional fields "startedAt" <*> fields .: "status")
instance ToJSON JobCancelled where toJSON value = Object (KM.fromList (concat [[("completedAt", toJSON (jobCancelledCompletedAt value))], [("metadata", toJSON (jobCancelledMetadata value))], [("params", toJSON (jobCancelledParams value))], optionalPair "startedAt" (jobCancelledStartedAt value), [("status", toJSON (jobCancelledStatus value))]]))

data JobCancelledStatus = JobCancelledStatusCancelled deriving (Eq, Show)
instance FromJSON JobCancelledStatus where
  parseJSON = checked "JobCancelledStatus" $ \value -> if value == (String "cancelled") then pure JobCancelledStatusCancelled else fail "unknown enumeration member"
instance ToJSON JobCancelledStatus where
  toJSON JobCancelledStatusCancelled = String "cancelled"


