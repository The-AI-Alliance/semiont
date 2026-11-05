-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobRunning
  ( JobRunning(..)
  , JobRunningStatus(..)
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
import Semiont.Internal.Generated.Models.JobStoredProgress
data JobRunning = JobRunning { jobRunningMetadata :: JobMetadata, jobRunningParams :: JobParams, jobRunningProgress :: JobStoredProgress, jobRunningStartedAt :: Text, jobRunningStatus :: JobRunningStatus } deriving (Eq, Show)
instance FromJSON JobRunning where
  parseJSON = checked "JobRunning" $ withObject "JobRunning" (\fields -> JobRunning <$> fields .: "metadata" <*> fields .: "params" <*> fields .: "progress" <*> fields .: "startedAt" <*> fields .: "status")
instance ToJSON JobRunning where toJSON value = Object (KM.fromList (concat [[("metadata", toJSON (jobRunningMetadata value))], [("params", toJSON (jobRunningParams value))], [("progress", toJSON (jobRunningProgress value))], [("startedAt", toJSON (jobRunningStartedAt value))], [("status", toJSON (jobRunningStatus value))]]))

data JobRunningStatus = JobRunningStatusRunning deriving (Eq, Show)
instance FromJSON JobRunningStatus where
  parseJSON = checked "JobRunningStatus" $ \value -> if value == (String "running") then pure JobRunningStatusRunning else fail "unknown enumeration member"
instance ToJSON JobRunningStatus where
  toJSON JobRunningStatusRunning = String "running"
