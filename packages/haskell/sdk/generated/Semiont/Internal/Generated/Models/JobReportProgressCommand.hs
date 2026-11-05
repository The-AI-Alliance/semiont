-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobReportProgressCommand
  ( JobReportProgressCommand(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationId
import Semiont.Internal.Generated.Models.JobId
import Semiont.Internal.Generated.Models.JobProgress
import Semiont.Internal.Generated.Models.JobType
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data JobReportProgressCommand = JobReportProgressCommand { jobReportProgressCommandU5f_userId :: Maybe (UserId), jobReportProgressCommandAnnotationId :: Maybe (AnnotationId), jobReportProgressCommandAttempt :: Maybe (Integer), jobReportProgressCommandJobId :: JobId, jobReportProgressCommandJobType :: JobType, jobReportProgressCommandPercentage :: Scientific, jobReportProgressCommandProgress :: Maybe (JobProgress), jobReportProgressCommandResourceId :: ResourceId, jobReportProgressCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobReportProgressCommand where
  parseJSON = checked "JobReportProgressCommand" $ withObject "JobReportProgressCommand" (\fields -> JobReportProgressCommand <$> optional fields "_userId" <*> optional fields "annotationId" <*> optional fields "attempt" <*> fields .: "jobId" <*> fields .: "jobType" <*> fields .: "percentage" <*> optional fields "progress" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["_userId", "annotationId", "attempt", "jobId", "jobType", "percentage", "progress", "resourceId"] fields))
instance ToJSON JobReportProgressCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (jobReportProgressCommandU5f_userId value), optionalPair "annotationId" (jobReportProgressCommandAnnotationId value), optionalPair "attempt" (jobReportProgressCommandAttempt value), [("jobId", toJSON (jobReportProgressCommandJobId value))], [("jobType", toJSON (jobReportProgressCommandJobType value))], [("percentage", toJSON (jobReportProgressCommandPercentage value))], optionalPair "progress" (jobReportProgressCommandProgress value), [("resourceId", toJSON (jobReportProgressCommandResourceId value))]]) <> fmap toJSON (withoutFields ["_userId", "annotationId", "attempt", "jobId", "jobType", "percentage", "progress", "resourceId"] (jobReportProgressCommandAdditionalProperties value)))

