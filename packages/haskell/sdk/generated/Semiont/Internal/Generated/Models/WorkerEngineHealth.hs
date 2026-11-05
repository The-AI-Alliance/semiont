-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.WorkerEngineHealth
  ( WorkerEngineHealth(..)
  , WorkerEngineHealthActiveJob(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Engine
import Semiont.Internal.Generated.Models.JobFilter
import Semiont.Internal.Generated.Models.JobId
import Semiont.Internal.Generated.Models.JobType
data WorkerEngineHealth = WorkerEngineHealth { workerEngineHealthActiveJob :: Maybe (WorkerEngineHealthActiveJob), workerEngineHealthEngine :: Engine, workerEngineHealthJobs :: [JobFilter], workerEngineHealthJobsCompleted :: Integer, workerEngineHealthLastActivityAt :: Maybe (Text), workerEngineHealthLastClaimAt :: Maybe (Text), workerEngineHealthLastFinishedAt :: Maybe (Text), workerEngineHealthLastQueuedEventAt :: Maybe (Text) } deriving (Eq, Show)
instance FromJSON WorkerEngineHealth where
  parseJSON = checked "WorkerEngineHealth" $ withObject "WorkerEngineHealth" (\fields -> WorkerEngineHealth <$> fields .: "activeJob" <*> fields .: "engine" <*> fields .: "jobs" <*> fields .: "jobsCompleted" <*> fields .: "lastActivityAt" <*> fields .: "lastClaimAt" <*> fields .: "lastFinishedAt" <*> fields .: "lastQueuedEventAt")
instance ToJSON WorkerEngineHealth where toJSON value = Object (KM.fromList (concat [[("activeJob", toJSON (workerEngineHealthActiveJob value))], [("engine", toJSON (workerEngineHealthEngine value))], [("jobs", toJSON (workerEngineHealthJobs value))], [("jobsCompleted", toJSON (workerEngineHealthJobsCompleted value))], [("lastActivityAt", toJSON (workerEngineHealthLastActivityAt value))], [("lastClaimAt", toJSON (workerEngineHealthLastClaimAt value))], [("lastFinishedAt", toJSON (workerEngineHealthLastFinishedAt value))], [("lastQueuedEventAt", toJSON (workerEngineHealthLastQueuedEventAt value))]]))

data WorkerEngineHealthActiveJob = WorkerEngineHealthActiveJob { workerEngineHealthActiveJobJobId :: JobId, workerEngineHealthActiveJobSince :: Text, workerEngineHealthActiveJobType :: JobType } deriving (Eq, Show)
instance FromJSON WorkerEngineHealthActiveJob where
  parseJSON = checked "WorkerEngineHealthActiveJob" $ withObject "WorkerEngineHealthActiveJob" (\fields -> WorkerEngineHealthActiveJob <$> fields .: "jobId" <*> fields .: "since" <*> fields .: "type")
instance ToJSON WorkerEngineHealthActiveJob where toJSON value = Object (KM.fromList (concat [[("jobId", toJSON (workerEngineHealthActiveJobJobId value))], [("since", toJSON (workerEngineHealthActiveJobSince value))], [("type", toJSON (workerEngineHealthActiveJobType value))]]))

