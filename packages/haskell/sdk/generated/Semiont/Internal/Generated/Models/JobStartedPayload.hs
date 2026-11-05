-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobStartedPayload
  ( JobStartedPayload(..)
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
import Semiont.Internal.Generated.Models.JobType
data JobStartedPayload = JobStartedPayload { jobStartedPayloadAnnotationId :: Maybe (AnnotationId), jobStartedPayloadJobId :: JobId, jobStartedPayloadJobType :: JobType, jobStartedPayloadTotalSteps :: Maybe (Integer), jobStartedPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobStartedPayload where
  parseJSON = checked "JobStartedPayload" $ withObject "JobStartedPayload" (\fields -> JobStartedPayload <$> optional fields "annotationId" <*> fields .: "jobId" <*> fields .: "jobType" <*> optional fields "totalSteps" <*> traverse parseJSON (withoutFields ["annotationId", "jobId", "jobType", "totalSteps"] fields))
instance ToJSON JobStartedPayload where toJSON value = Object (KM.fromList (concat [optionalPair "annotationId" (jobStartedPayloadAnnotationId value), [("jobId", toJSON (jobStartedPayloadJobId value))], [("jobType", toJSON (jobStartedPayloadJobType value))], optionalPair "totalSteps" (jobStartedPayloadTotalSteps value)]) <> fmap toJSON (withoutFields ["annotationId", "jobId", "jobType", "totalSteps"] (jobStartedPayloadAdditionalProperties value)))

