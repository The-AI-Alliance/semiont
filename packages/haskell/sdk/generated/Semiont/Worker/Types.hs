-- Generated from packages/typescript/sdk/src/claims.ts. Do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Worker.Types where
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.ErrorCodes (BusRequestCode)
import Semiont.Internal.Codec (optional, optionalPair)
import Semiont.Types (JobId, JobType, UnitCursor, FailureClass)
data ClaimRefusal = ClaimRefusal { claimRefusalCode :: Maybe (BusRequestCode), claimRefusalMessage :: Text } deriving (Eq, Show)
instance FromJSON ClaimRefusal where
  parseJSON = withObject "ClaimRefusal" $ \row -> ClaimRefusal <$> row .: "code" <*> row .: "message"
instance ToJSON ClaimRefusal where
  toJSON value = Object (KM.fromList (concat [[("code", toJSON (claimRefusalCode value))], [("message", toJSON (claimRefusalMessage value))]]))
data WorkerVitalsActiveJob = WorkerVitalsActiveJob { workerVitalsActiveJobJobId :: JobId, workerVitalsActiveJobType :: JobType, workerVitalsActiveJobSince :: Text } deriving (Eq, Show)
instance FromJSON WorkerVitalsActiveJob where
  parseJSON = withObject "WorkerVitalsActiveJob" $ \row -> WorkerVitalsActiveJob <$> row .: "jobId" <*> row .: "type" <*> row .: "since"
instance ToJSON WorkerVitalsActiveJob where
  toJSON value = Object (KM.fromList (concat [[("jobId", toJSON (workerVitalsActiveJobJobId value))], [("type", toJSON (workerVitalsActiveJobType value))], [("since", toJSON (workerVitalsActiveJobSince value))]]))
data WorkerVitals = WorkerVitals { workerVitalsLastQueuedEventAt :: Maybe (Text), workerVitalsLastClaimAt :: Maybe (Text), workerVitalsLastFinishedAt :: Maybe (Text), workerVitalsLastActivityAt :: Maybe (Text), workerVitalsActiveJob :: Maybe (WorkerVitalsActiveJob), workerVitalsJobsCompleted :: Scientific } deriving (Eq, Show)
instance FromJSON WorkerVitals where
  parseJSON = withObject "WorkerVitals" $ \row -> WorkerVitals <$> row .: "lastQueuedEventAt" <*> row .: "lastClaimAt" <*> row .: "lastFinishedAt" <*> row .: "lastActivityAt" <*> row .: "activeJob" <*> row .: "jobsCompleted"
instance ToJSON WorkerVitals where
  toJSON value = Object (KM.fromList (concat [[("lastQueuedEventAt", toJSON (workerVitalsLastQueuedEventAt value))], [("lastClaimAt", toJSON (workerVitalsLastClaimAt value))], [("lastFinishedAt", toJSON (workerVitalsLastFinishedAt value))], [("lastActivityAt", toJSON (workerVitalsLastActivityAt value))], [("activeJob", toJSON (workerVitalsActiveJob value))], [("jobsCompleted", toJSON (workerVitalsJobsCompleted value))]]))
data HeldJobStall = HeldJobStall { heldJobStallJobId :: JobId, heldJobStallJobType :: JobType, heldJobStallHeldSince :: Text, heldJobStallLastActivityAt :: Text, heldJobStallSilentForMs :: Scientific, heldJobStallThresholdMs :: Scientific } deriving (Eq, Show)
instance FromJSON HeldJobStall where
  parseJSON = withObject "HeldJobStall" $ \row -> HeldJobStall <$> row .: "jobId" <*> row .: "jobType" <*> row .: "heldSince" <*> row .: "lastActivityAt" <*> row .: "silentForMs" <*> row .: "thresholdMs"
instance ToJSON HeldJobStall where
  toJSON value = Object (KM.fromList (concat [[("jobId", toJSON (heldJobStallJobId value))], [("jobType", toJSON (heldJobStallJobType value))], [("heldSince", toJSON (heldJobStallHeldSince value))], [("lastActivityAt", toJSON (heldJobStallLastActivityAt value))], [("silentForMs", toJSON (heldJobStallSilentForMs value))], [("thresholdMs", toJSON (heldJobStallThresholdMs value))]]))
data JobCheckpoint = JobCheckpoint { jobCheckpointCompletedUnits :: [Text], jobCheckpointUnitCursors :: Maybe (KM.KeyMap (UnitCursor)) } deriving (Eq, Show)
instance FromJSON JobCheckpoint where
  parseJSON = withObject "JobCheckpoint" $ \row -> JobCheckpoint <$> row .: "completedUnits" <*> optional row "unitCursors"
instance ToJSON JobCheckpoint where
  toJSON value = Object (KM.fromList (concat [[("completedUnits", toJSON (jobCheckpointCompletedUnits value))], optionalPair "unitCursors" (jobCheckpointUnitCursors value)]))
data JobReached = JobReached { jobReachedCompletedUnits :: Maybe ([Text]), jobReachedUnitCursors :: Maybe (KM.KeyMap (UnitCursor)) } deriving (Eq, Show)
instance FromJSON JobReached where
  parseJSON = withObject "JobReached" $ \row -> JobReached <$> optional row "completedUnits" <*> optional row "unitCursors"
instance ToJSON JobReached where
  toJSON value = Object (KM.fromList (concat [optionalPair "completedUnits" (jobReachedCompletedUnits value), optionalPair "unitCursors" (jobReachedUnitCursors value)]))
data JobFailure = JobFailure { jobFailureCompletedUnits :: Maybe ([Text]), jobFailureUnitCursors :: Maybe (KM.KeyMap (UnitCursor)), jobFailureFailureClass :: Maybe (FailureClass) } deriving (Eq, Show)
instance FromJSON JobFailure where
  parseJSON = withObject "JobFailure" $ \row -> JobFailure <$> optional row "completedUnits" <*> optional row "unitCursors" <*> optional row "failureClass"
instance ToJSON JobFailure where
  toJSON value = Object (KM.fromList (concat [optionalPair "completedUnits" (jobFailureCompletedUnits value), optionalPair "unitCursors" (jobFailureUnitCursors value), optionalPair "failureClass" (jobFailureFailureClass value)]))
