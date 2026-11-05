-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobFailed
  ( JobFailed(..)
  , JobFailedStatus(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.FailureClass
import Semiont.Internal.Generated.Models.JobMetadata
import Semiont.Internal.Generated.Models.JobParams
data JobFailed = JobFailed { jobFailedCompletedAt :: Text, jobFailedError :: Text, jobFailedFailureClass :: Maybe (FailureClass), jobFailedMetadata :: JobMetadata, jobFailedParams :: JobParams, jobFailedStartedAt :: Maybe (Text), jobFailedStatus :: JobFailedStatus } deriving (Eq, Show)
instance FromJSON JobFailed where
  parseJSON = checked "JobFailed" $ withObject "JobFailed" (\fields -> JobFailed <$> fields .: "completedAt" <*> fields .: "error" <*> optional fields "failureClass" <*> fields .: "metadata" <*> fields .: "params" <*> optional fields "startedAt" <*> fields .: "status")
instance ToJSON JobFailed where toJSON value = Object (KM.fromList (concat [[("completedAt", toJSON (jobFailedCompletedAt value))], [("error", toJSON (jobFailedError value))], optionalPair "failureClass" (jobFailedFailureClass value), [("metadata", toJSON (jobFailedMetadata value))], [("params", toJSON (jobFailedParams value))], optionalPair "startedAt" (jobFailedStartedAt value), [("status", toJSON (jobFailedStatus value))]]))

data JobFailedStatus = JobFailedStatusFailed deriving (Eq, Show)
instance FromJSON JobFailedStatus where
  parseJSON = checked "JobFailedStatus" $ \value -> if value == (String "failed") then pure JobFailedStatusFailed else fail "unknown enumeration member"
instance ToJSON JobFailedStatus where
  toJSON JobFailedStatusFailed = String "failed"


