{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module Semiont.Internal.Delegation
  ( Follower, Verb(..), newFollower, follow, run, dispose
  , JobEvent(..), UploadEvent(..), JobError(..), deriveStallDeadlineMs
  ) where

import Control.Concurrent.Async (race)
import Data.Either (isLeft)
import Data.Text (Text)
import Control.Concurrent.STM
import Control.Exception (Exception, SomeException, SomeAsyncException, bracket, finally, fromException, mask, throwIO, try)
import Control.Monad (forever, unless, void, when)
import Data.Maybe (fromMaybe)
import Data.Scientific (Scientific)
import qualified OpenTelemetry.Context as Context
import OpenTelemetry.Context.ThreadLocal (attachContext, detachContext, getContext)
import OpenTelemetry.Context.ThreadLocal.Propagation (tracedWithAsync)
import qualified Semiont.Bus as Bus
import qualified Semiont.Internal.Bus as Typed
import Semiont.Channels hiding (JobComplete)
import qualified Semiont.Channels as Channel
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (BusRequestError, TransportError(..))
import Semiont.Internal.Generated.OperationReports
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.Internal.Running as Running
import qualified Semiont.Internal.Transport as Local
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types

-- Native exception data retains absent failure words and an unknown job id.
data JobError = JobError
  { jobErrorCode :: Code.JobCode, jobErrorJobId :: Maybe JobId
  , jobErrorMessage :: Maybe Text, jobErrorFailureClass :: Maybe FailureClass
  , jobErrorDeadlineMs :: Maybe Scientific
  } deriving (Eq, Show)
instance Exception JobError

data Verb completion = Verb
  { heard :: JobCompleteCommand -> Maybe completion
  , learned :: JobStatusResponse -> ResourceId -> Maybe completion
  }
data Follower = Follower Bus.Bus Local.EventBus Bus.BusOptions Timing.Settings Lifetime.Lifetime
data FrameEvent = Advanced JobReportProgressCommand | Finished JobCompleteCommand | FailedAttempt JobFailCommand
type Parent = Maybe Context.Context
data Event = CreatedAnswer (Either SomeException JobCreatedResult)
  | Frame Parent FrameEvent
  | Status Integer (Either SomeException JobStatusResponse)
  | Stalled Integer

deriveStallDeadlineMs :: Timing.Settings -> Maybe Scientific -> Scientific
deriveStallDeadlineMs settings tokens = max (fromInteger (Timing.generationStallFloorMs settings))
  (fromMaybe (fromInteger (Timing.generationStallAssumedTokensCount settings)) tokens * fromInteger (Timing.generationStallPerTokenMs settings))

newFollower :: Bus.Bus -> Local.EventBus -> Bus.BusOptions -> Timing.Settings -> IO Follower
newFollower wire local clock timing = do
  when (Timing.jobSilenceMs timing < 0 || Timing.jobStatusPollMs timing <= 0)
    (ioError (userError "job following needs nonnegative silence and a positive polling interval"))
  Follower wire local clock timing <$> Lifetime.newLifetime "delegation is disposed"
run :: Follower -> IO value -> IO value
run (Follower _ _ _ _ lifetime) = Lifetime.run lifetime
dispose :: Follower -> IO ()
dispose (Follower _ _ _ _ lifetime) = Lifetime.close lifetime

withParent :: Parent -> IO value -> IO value
withParent parent = bracket (attachContext (fromMaybe Context.empty parent)) detachContext . const

frameIdentity :: FrameEvent -> JobId
frameIdentity (Advanced value) = jobReportProgressCommandJobId value
frameIdentity (FailedAttempt value) = jobFailCommandJobId value
frameIdentity (Finished value) = case value of
  JobCompleteCommandBranch1 completed -> markJobCompleteCommandJobId completed
  JobCompleteCommandBranch2 completed -> yieldJobCompleteCommandJobId completed

receive :: TQueue Event -> Local.Frame -> Parent -> STM ()
receive events frame parent
  | name==channelName JobReportProgress = offer JobReportProgress Advanced
  | name==channelName Channel.JobComplete = offer Channel.JobComplete Finished
  | name==channelName JobFail = offer JobFail FailedAttempt
  | otherwise = pure ()
  where
    name=busFrameChannel (Local.wireFrame frame)
    offer channel make = case Typed.decoded channel frame of
      Bus.Heard value -> writeTQueue events (Frame parent (make (Bus.deliveredPayload value)))
      Bus.Refused _ -> pure ()

follow :: Follower -> JobCreateCommand -> Verb completion -> ResourceId -> Maybe Scientific
  -> IO (Running.Running (JobEvent completion) completion)
follow (Follower wire local clock timing lifetime) command verb resource stallMs = do
  when (maybe False (<0) stallMs) (ioError (userError "negative generation stall deadline"))
  Running.newRunning $ \report -> Lifetime.run lifetime $ mask $ \restore -> do
    events <- newTQueueIO
    polls <- newTQueueIO
    pollPlan <- newTVarIO Nothing
    pollEpoch <- newTVarIO (0::Integer)
    asking <- newTVarIO False
    activeId <- newTVarIO Nothing
    began <- Bus.requestNow clock
    caller <- getContext
    activity <- newTVarIO (0::Integer,began,Just caller)
    let resetStall parent = do
          now <- Bus.requestNow clock
          atomically (modifyTVar' activity (\(generation,_,_) -> (generation+1,now,parent)))
        silence parent identity = do
          now <- Bus.requestNow clock
          atomically $ do
            modifyTVar' pollEpoch (+1)
            writeTVar pollPlan (Just (identity,now+Timing.jobSilenceMs timing*1000000,parent))
        stopPoll = atomically $ modifyTVar' pollEpoch (+1) >> writeTVar pollPlan Nothing
        creation = do
          result <- try (Bus.request wire JobCreateOperation command (Timing.busRequestTimeoutMs timing))
          atomically (writeTQueue events (CreatedAnswer result))
        pollTimer = forever $ do
          (generation,identity,due,parent) <- atomically $ do
            planned <- readTVar pollPlan
            case planned of
              Nothing -> retry
              Just (identity,due,parent) -> (,,,) <$> readTVar pollEpoch <*> pure identity <*> pure due <*> pure parent
          reached <- isLeft <$> race (Bus.requestWaitUntil clock due) (atomically (readTVar pollEpoch >>= check . (/=generation)))
          when reached $ do
            now <- Bus.requestNow clock
            atomically $ do
              current <- readTVar pollEpoch
              when (current==generation) $ do
                writeTVar pollPlan (Just (identity,now+Timing.jobStatusPollMs timing*1000000,parent))
                busy <- readTVar asking
                unless busy $ do
                  writeTVar asking True
                  writeTQueue polls (generation,identity,parent)
        pollWorker = forever $ do
          (generation,identity,parent) <- atomically (readTQueue polls)
          let ask = do
                result <- try $ withParent parent $
                  jobStatusResultResponse <$> Bus.request wire JobStatusRequestedOperation (JobStatusRequest identity mempty) (Timing.busRequestTimeoutMs timing)
                case result of
                  Left problem | Just (_::SomeAsyncException) <- fromException problem -> throwIO problem
                  _ -> atomically (writeTQueue events (Status generation result))
          ask `finally` atomically (writeTVar asking False)
        stallTimer threshold = do
          (generation,lastHeard,_) <- readTVarIO activity
          reached <- isLeft <$> race (Bus.requestWaitUntil clock (lastHeard+ceiling (threshold*1000000)))
            (atomically (readTVar activity >>= check . (\(current,_,_) -> current/=generation)))
          if reached then do
            accepted <- atomically $ do
              (current,_,_) <- readTVar activity
              if current/=generation then pure False else writeTQueue events (Stalled generation) >> pure True
            when accepted (atomically (readTVar activity >>= check . (\(current,_,_) -> current/=generation)))
            stallTimer threshold
          else stallTimer threshold
        failure value = throwIO (JobError Code.JobFailed (Just (jobFailCommandJobId value))
          (Just (jobFailCommandError value)) (jobFailCommandFailureClass value) Nothing)
        complete result = case result of
          Nothing -> throwIO (TransportError Code.TransportError "job completion is not the delegated verb's" Nothing Nothing)
          Just value -> report (Complete value) >> pure (Just value)
        consume identity parent frame
          | frameIdentity frame/=identity = pure Nothing
          | otherwise = case frame of
              Advanced value -> do
                mapM_ (report . Progress) (jobReportProgressCommandProgress value)
                silence parent identity
                resetStall parent
                pure Nothing
              Finished value -> complete (heard verb value)
              FailedAttempt value | jobFailCommandWillRetry value==Just True -> do
                report (Failed value)
                stopPoll
                resetStall parent
                pure Nothing
              FailedAttempt value -> failure value
        buffered identity held = case held of
          [] -> loop (Just identity) []
          (parent,value):rest -> consume identity parent value >>= maybe (buffered identity rest) pure
        loop known held = do
          event <- atomically (readTQueue events)
          case event of
            CreatedAnswer (Left problem) -> throwIO problem
            CreatedAnswer (Right value) -> do
              let created=jobCreatedResultResponse value
                  identity=jobCreatedResultResponseJobId created
              atomically (writeTVar activeId (Just identity))
              report (Created created)
              silence (Just caller) identity
              resetStall (Just caller)
              buffered identity (reverse held)
            Frame parent value -> case known of
              Nothing -> loop Nothing ((parent,value):held)
              Just identity -> consume identity parent value >>= maybe (loop known []) pure
            Status generation answer -> do
              current <- readTVarIO pollEpoch
              if current/=generation then loop known held else case answer of
                Left problem
                  | Just (_::BusRequestError) <- fromException problem -> loop known held
                  | Just (_::TransportError) <- fromException problem -> loop known held
                  | otherwise -> throwIO problem
                Right value | Just identity <- known, jobStatusResponseJobId value/=identity ->
                  throwIO (TransportError Code.TransportError "job status names another job" Nothing Nothing)
                Right value -> case jobStatusResponseStatus value of
                  JobStatusResponseStatusPending -> loop known held
                  JobStatusResponseStatusRunning -> loop known held
                  JobStatusResponseStatusComplete -> complete (learned verb value resource) >>= maybe (loop known held) pure
                  JobStatusResponseStatusFailed -> throwIO (JobError Code.JobFailed (Just (jobStatusResponseJobId value))
                    (jobStatusResponseError value) (jobStatusResponseFailureClass value) Nothing)
                  JobStatusResponseStatusCancelled -> throwIO (JobError Code.JobCancelled (Just (jobStatusResponseJobId value)) Nothing Nothing Nothing)
            Stalled generation -> do
              (current,_,parent) <- readTVarIO activity
              if current/=generation then loop known held else do
                identity <- readTVarIO activeId
                mapM_ (\jobId -> void $ Lifetime.start lifetime $ withParent parent $ do
                  result <- try (Bus.request wire JobCancelRequestedOperation (JobCancelRequest jobId mempty) (Timing.busRequestTimeoutMs timing))
                  case result of
                    Left problem | Just (_::SomeAsyncException) <- fromException problem -> throwIO problem
                    _ -> pure ()) identity
                throwIO (JobError Code.JobStalled identity Nothing Nothing stallMs)
    bracket (Local.tapLocal local (receive events)) id $ \_ ->
      tracedWithAsync (restore creation) $ \_ ->
      tracedWithAsync (restore pollTimer) $ \_ ->
      tracedWithAsync (restore pollWorker) $ \_ ->
      tracedWithAsync (restore (maybe (atomically retry) stallTimer stallMs)) $ \_ -> restore (loop Nothing [])
