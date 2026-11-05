-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobCancelCommand
  ( JobCancelCommand(..)
  , JobCancelCommandUnitCursors(..)
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
import Semiont.Internal.Generated.Models.UnitCursor
import Semiont.Internal.Generated.Models.UserId
data JobCancelCommand = JobCancelCommand { jobCancelCommandU5f_userId :: Maybe (UserId), jobCancelCommandAnnotationId :: Maybe (AnnotationId), jobCancelCommandCompletedUnits :: Maybe ([Text]), jobCancelCommandJobId :: JobId, jobCancelCommandJobType :: JobType, jobCancelCommandResourceId :: ResourceId, jobCancelCommandUnitCursors :: Maybe (JobCancelCommandUnitCursors), jobCancelCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobCancelCommand where
  parseJSON = checked "JobCancelCommand" $ withObject "JobCancelCommand" (\fields -> JobCancelCommand <$> optional fields "_userId" <*> optional fields "annotationId" <*> optional fields "completedUnits" <*> fields .: "jobId" <*> fields .: "jobType" <*> fields .: "resourceId" <*> optional fields "unitCursors" <*> traverse parseJSON (withoutFields ["_userId", "annotationId", "completedUnits", "jobId", "jobType", "resourceId", "unitCursors"] fields))
instance ToJSON JobCancelCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (jobCancelCommandU5f_userId value), optionalPair "annotationId" (jobCancelCommandAnnotationId value), optionalPair "completedUnits" (jobCancelCommandCompletedUnits value), [("jobId", toJSON (jobCancelCommandJobId value))], [("jobType", toJSON (jobCancelCommandJobType value))], [("resourceId", toJSON (jobCancelCommandResourceId value))], optionalPair "unitCursors" (jobCancelCommandUnitCursors value)]) <> fmap toJSON (withoutFields ["_userId", "annotationId", "completedUnits", "jobId", "jobType", "resourceId", "unitCursors"] (jobCancelCommandAdditionalProperties value)))

data JobCancelCommandUnitCursors = JobCancelCommandUnitCursors { jobCancelCommandUnitCursorsAdditionalProperties :: KM.KeyMap (UnitCursor) } deriving (Eq, Show)
instance FromJSON JobCancelCommandUnitCursors where
  parseJSON = checked "JobCancelCommandUnitCursors" $ withObject "JobCancelCommandUnitCursors" (\fields -> JobCancelCommandUnitCursors <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON JobCancelCommandUnitCursors where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (jobCancelCommandUnitCursorsAdditionalProperties value)))
