-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobStartCommand
  ( JobStartCommand(..)
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
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data JobStartCommand = JobStartCommand { jobStartCommandU5f_userId :: Maybe (UserId), jobStartCommandAnnotationId :: Maybe (AnnotationId), jobStartCommandAttempt :: Maybe (Integer), jobStartCommandJobId :: JobId, jobStartCommandJobType :: JobType, jobStartCommandResourceId :: ResourceId, jobStartCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobStartCommand where
  parseJSON = checked "JobStartCommand" $ withObject "JobStartCommand" (\fields -> JobStartCommand <$> optional fields "_userId" <*> optional fields "annotationId" <*> optional fields "attempt" <*> fields .: "jobId" <*> fields .: "jobType" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["_userId", "annotationId", "attempt", "jobId", "jobType", "resourceId"] fields))
instance ToJSON JobStartCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (jobStartCommandU5f_userId value), optionalPair "annotationId" (jobStartCommandAnnotationId value), optionalPair "attempt" (jobStartCommandAttempt value), [("jobId", toJSON (jobStartCommandJobId value))], [("jobType", toJSON (jobStartCommandJobType value))], [("resourceId", toJSON (jobStartCommandResourceId value))]]) <> fmap toJSON (withoutFields ["_userId", "annotationId", "attempt", "jobId", "jobType", "resourceId"] (jobStartCommandAdditionalProperties value)))
