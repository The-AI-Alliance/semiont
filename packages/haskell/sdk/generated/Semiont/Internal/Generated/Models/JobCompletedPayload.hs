-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobCompletedPayload
  ( JobCompletedPayload(..)
  , JobCompletedPayloadResult(..)
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
import Semiont.Internal.Generated.Models.DurabilityEvidence
import Semiont.Internal.Generated.Models.JobId
import Semiont.Internal.Generated.Models.JobType
import Semiont.Internal.Generated.Models.ResourceId
data JobCompletedPayload = JobCompletedPayload { jobCompletedPayloadAnnotationId :: Maybe (AnnotationId), jobCompletedPayloadAnnotationUri :: Maybe (Text), jobCompletedPayloadAttempt :: Maybe (Integer), jobCompletedPayloadDurability :: Maybe (DurabilityEvidence), jobCompletedPayloadFoundCount :: Maybe (Integer), jobCompletedPayloadJobId :: JobId, jobCompletedPayloadJobType :: JobType, jobCompletedPayloadResult :: Maybe (JobCompletedPayloadResult), jobCompletedPayloadResultResourceId :: Maybe (ResourceId), jobCompletedPayloadTotalSteps :: Maybe (Integer), jobCompletedPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobCompletedPayload where
  parseJSON = checked "JobCompletedPayload" $ withObject "JobCompletedPayload" (\fields -> JobCompletedPayload <$> optional fields "annotationId" <*> optional fields "annotationUri" <*> optional fields "attempt" <*> optional fields "durability" <*> optional fields "foundCount" <*> fields .: "jobId" <*> fields .: "jobType" <*> optional fields "result" <*> optional fields "resultResourceId" <*> optional fields "totalSteps" <*> traverse parseJSON (withoutFields ["annotationId", "annotationUri", "attempt", "durability", "foundCount", "jobId", "jobType", "result", "resultResourceId", "totalSteps"] fields))
instance ToJSON JobCompletedPayload where toJSON value = Object (KM.fromList (concat [optionalPair "annotationId" (jobCompletedPayloadAnnotationId value), optionalPair "annotationUri" (jobCompletedPayloadAnnotationUri value), optionalPair "attempt" (jobCompletedPayloadAttempt value), optionalPair "durability" (jobCompletedPayloadDurability value), optionalPair "foundCount" (jobCompletedPayloadFoundCount value), [("jobId", toJSON (jobCompletedPayloadJobId value))], [("jobType", toJSON (jobCompletedPayloadJobType value))], optionalPair "result" (jobCompletedPayloadResult value), optionalPair "resultResourceId" (jobCompletedPayloadResultResourceId value), optionalPair "totalSteps" (jobCompletedPayloadTotalSteps value)]) <> fmap toJSON (withoutFields ["annotationId", "annotationUri", "attempt", "durability", "foundCount", "jobId", "jobType", "result", "resultResourceId", "totalSteps"] (jobCompletedPayloadAdditionalProperties value)))

data JobCompletedPayloadResult = JobCompletedPayloadResult { jobCompletedPayloadResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobCompletedPayloadResult where
  parseJSON = checked "JobCompletedPayloadResult" $ withObject "JobCompletedPayloadResult" (\fields -> JobCompletedPayloadResult <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON JobCompletedPayloadResult where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (jobCompletedPayloadResultAdditionalProperties value)))
