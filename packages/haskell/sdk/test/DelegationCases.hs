{-# LANGUAGE GADTs, OverloadedStrings, ScopedTypeVariables #-}
module DelegationCases (delegationCases, followerClockCases) where

import Control.Concurrent.Async (async, wait, waitCatch, poll)
import Control.Concurrent.STM
import Control.Exception (bracket, try)
import Control.Monad (forM_, unless, void)
import Data.Aeson (FromJSON, Result(..), Value(..), fromJSON)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Semiont.Bus as Bus
import qualified Semiont.Channels as Channel
import qualified Semiont.Client as Client
import qualified Semiont.Content as Content
import qualified Semiont.Delegation as Report
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (TransportError(..), BusRequestError(..))
import qualified Semiont.Mark as Mark
import qualified Semiont.Running as Running
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types
import qualified Semiont.Yield as Yield
import qualified Streaming.Prelude as Stream
import qualified ControlledTime as Time
import ClockCases (clockCasesFor, Scenario(..))
import System.Timeout (timeout)

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
fixture :: FromJSON value => Map.Map Text Value -> Text -> IO value
fixture fixtures name = case Map.lookup name fixtures of
  Nothing -> ioError (userError ("missing follower fixture "++Text.unpack name))
  Just value -> case fromJSON value of Error message -> ioError (userError message); Success parsed -> pure parsed
payload :: Channel.Channel scope value -> value -> BusFramePayload
payload channel value = case Channel.encodePayload channel value of Object fields -> BusFramePayload fields; _ -> error "follower payload is not an object"

data Rig = Rig
  { client :: Client.Client, input :: Transport.TransportInput, time :: Time.ControlledTime
  , requests :: TQueue BusFrame, holdCreate :: TVar Bool, holdStatus :: TVar Bool
  , statusValue :: TVar JobStatusResponse, jobId :: JobId, resourceId :: ResourceId
  , fixtures :: Map.Map Text Value, statusCount :: TVar Integer
  }
newRig :: Map.Map Text Value -> Time.ControlledTime -> IO Rig
newRig samples clock = do
  calls <- newTQueueIO
  createHeld <- newTVarIO False
  statusHeld <- newTVarIO False
  count <- newTVarIO 0
  ids <- newTVarIO (0::Integer)
  sourceCell <- newEmptyTMVarIO
  identity <- either (ioError . userError) pure (mkJobId "followed-job")
  resource <- either (ioError . userError) pure (mkResourceId "followed-resource")
  base <- fixture samples "JobStatusResponse"
  current <- newTVarIO base { jobStatusResponseJobId=identity, jobStatusResponseStatus=JobStatusResponseStatusRunning, jobStatusResponseType=JobTypeMark }
  let answer :: Channel.Channel scope value -> Maybe Text -> value -> IO ()
      answer channel correlation value = do
        source <- atomically (readTMVar sourceCell)
        Transport.receive source (BusFrame (Channel.channelName channel) correlation (payload channel value) Nothing)
      send frame = do
        atomically (writeTQueue calls frame)
        let correlation=busFrameCorrelationId frame
        if busFrameChannel frame==Channel.channelName Channel.JobCreate then do
          held <- readTVarIO createHeld
          unless held (answer Channel.JobCreated correlation (JobCreatedResult (JobCreatedResultResponse identity mempty) mempty))
        else if busFrameChannel frame==Channel.channelName Channel.JobStatusRequested then do
          atomically (modifyTVar' count (+1))
          held <- readTVarIO statusHeld
          unless held (readTVarIO current >>= answer Channel.JobStatusResult correlation . (\value -> JobStatusResult value mempty))
        else if busFrameChannel frame==Channel.channelName Channel.JobCancelRequested then do
          value <- fixture samples "JobCancelResultBusEnvelope"
          answer Channel.JobCancelOk correlation value
        else ioError (userError ("unexpected follower request "++show frame))
        pure Nothing
      unexpected :: IO value
      unexpected = ioError (userError "unexpected content call in follower test")
      content = Content.ContentTransport (\_ _ _ _ -> unexpected) (\_ _ -> unexpected) (\_ _ _ -> unexpected)
        (\_ _ -> unexpected) (\_ _ -> unexpected) (\_ _ -> unexpected) (pure ())
      options = Bus.BusOptions (Time.now clock) (Time.waitUntil clock)
        (atomically $ do modifyTVar' ids (+1); Text.pack . show <$> readTVar ids)
  (carrier,source) <- Transport.newTransport (Transport.TransportOptions "local://follower" (Set.fromList Channel.channelNames) send (pure ()))
  atomically (putTMVar sourceCell source)
  Transport.setState source Transport.Connecting
  Transport.setState source Transport.Open
  owned <- Client.newClient carrier content Nothing options Timing.protocolSettings Nothing
  pure (Rig owned source clock calls createHeld statusHeld current identity resource samples count)
withRig :: Map.Map Text Value -> (Rig -> IO result) -> IO result
withRig samples action = Time.newTime >>= \clock -> bracket (newRig samples clock) (Client.dispose . client) action
markRun :: Rig -> IO (Running.Running (Report.JobEvent MarkJobCompleteCommand) MarkJobCompleteCommand)
markRun rig = fixture (fixtures rig) "MarkJobParams" >>= Mark.delegate (Client.mark (client rig)) (resourceId rig)
nextRequest :: Rig -> Text -> IO BusFrame
nextRequest rig expected = do
  frame <- atomically (readTQueue (requests rig))
  require "follower sent another request" (busFrameChannel frame==expected)
  pure frame
markDone :: Rig -> IO MarkJobCompleteCommand
markDone rig = do
  value <- fixture (fixtures rig) "MarkJobCompleteCommand"
  pure value { markJobCompleteCommandJobId=jobId rig, markJobCompleteCommandResourceId=resourceId rig }
progress :: Rig -> IO ()
progress rig = do
  value <- fixture (fixtures rig) "JobReportProgressCommand"
  detail <- fixture (fixtures rig) "JobProgress"
  Transport.receive (input rig) (BusFrame (Channel.channelName Channel.JobReportProgress) Nothing
    (payload Channel.JobReportProgress value { jobReportProgressCommandJobId=jobId rig, jobReportProgressCommandResourceId=resourceId rig, jobReportProgressCommandProgress=Just detail }) Nothing)
complete :: Rig -> MarkJobCompleteCommand -> IO ()
complete rig value = Transport.receive (input rig) (BusFrame (Channel.channelName Channel.JobComplete) Nothing
  (payload Channel.JobComplete (JobCompleteCommandBranch1 value)) Nothing)
creationAnswer :: Rig -> BusFrame -> IO ()
creationAnswer rig frame = Transport.receive (input rig) (BusFrame (Channel.channelName Channel.JobCreated) (busFrameCorrelationId frame)
  (payload Channel.JobCreated (JobCreatedResult (JobCreatedResultResponse (jobId rig) mempty) mempty)) Nothing)

bufferedCases :: Map.Map Text Value -> IO ()
bufferedCases samples = withRig samples $ \rig -> do
  atomically (writeTVar (holdCreate rig) True)
  operation <- markRun rig
  atomically (isEmptyTQueue (requests rig)) >>= require "constructing a delegation created a job"
  reports <- newTQueueIO
  consumer <- async (Running.withReports operation (\events -> Stream.mapM_ (atomically . writeTQueue reports) events))
  asked <- nextRequest rig (Channel.channelName Channel.JobCreate)
  progress rig
  done <- markDone rig
  complete rig done
  Time.settle
  atomically (isEmptyTQueue reports) >>= require "a lifecycle frame escaped before the creation report"
  creationAnswer rig asked
  wait consumer >>= require "report consumption lost its terminal result" . (==done)
  notices <- atomically (flushTQueue reports)
  require "early frames were not released in order after creation" (case notices of [Report.Created _,Report.Progress _,Report.Complete value] -> value==done; _ -> False)
  twice <- try (Running.await operation) :: IO (Either Running.ConsumptionError MarkJobCompleteCommand)
  require "a delegated job could be created twice" (twice==Left Running.AlreadyConsumed)
  Time.advance (time rig) (3600*1000000000)
  atomically (isEmptyTQueue (requests rig)) >>= require "an ended delegation kept polling"

retryCases :: Map.Map Text Value -> IO ()
retryCases samples = withRig samples $ \rig -> do
  operation <- markRun rig
  notices <- newTQueueIO
  consumer <- async (Running.withReports operation (Stream.mapM_ (atomically . writeTQueue notices)))
  void (nextRequest rig (Channel.channelName Channel.JobCreate))
  atomically (readTQueue notices) >>= \notice -> require "creation was not the first report" (case notice of Report.Created _ -> True; _ -> False)
  atomically (writeTVar (holdStatus rig) True)
  Time.advance (time rig) (Timing.jobSilenceMs Timing.protocolSettings*1000000)
  oldAsk <- nextRequest rig (Channel.channelName Channel.JobStatusRequested)
  failure <- fixture samples "JobFailCommand"
  Transport.receive (input rig) (BusFrame (Channel.channelName Channel.JobFail) Nothing
    (payload Channel.JobFail failure { jobFailCommandJobId=jobId rig, jobFailCommandResourceId=resourceId rig, jobFailCommandWillRetry=Just True }) Nothing)
  atomically (readTQueue notices) >>= \notice -> require "retryable failure ended the stream" (case notice of Report.Failed _ -> True; _ -> False)
  oldStatus <- readTVarIO (statusValue rig)
  let failed=oldStatus { jobStatusResponseStatus=JobStatusResponseStatusFailed }
  Transport.receive (input rig) (BusFrame (Channel.channelName Channel.JobStatusResult) (busFrameCorrelationId oldAsk)
    (payload Channel.JobStatusResult (JobStatusResult failed mempty)) Nothing)
  Time.advance (time rig) (Timing.jobSilenceMs Timing.protocolSettings*1000000)
  atomically (isEmptyTQueue (requests rig)) >>= require "a failed attempt continued polling before another progress report"
  progress rig
  atomically (readTQueue notices) >>= \notice -> require "progress after a retry was lost" (case notice of Report.Progress _ -> True; _ -> False)
  done <- markDone rig
  complete rig done
  wait consumer >>= require "a retry changed the completed job" . (==done)

statusCases :: Map.Map Text Value -> IO ()
statusCases samples = do
  forM_ [Nothing,Just JobStatusResponseStatusCancelled,Just JobStatusResponseStatusFailed] $ \ending -> withRig samples $ \rig -> do
    atomically $ modifyTVar' (statusValue rig) (\value -> value { jobStatusResponseStatus=maybe JobStatusResponseStatusComplete id ending })
    operation <- markRun rig
    worker <- async (try (Running.await operation) :: IO (Either Report.JobError MarkJobCompleteCommand))
    void (nextRequest rig (Channel.channelName Channel.JobCreate))
    Time.advance (time rig) (Timing.jobSilenceMs Timing.protocolSettings*1000000)
    outcome <- wait worker
    case ending of
      Nothing -> require "a status completion lost its unreported result" (either (const False) ((==Nothing) . markJobCompleteCommandResult) outcome)
      Just expected -> require "terminal status did not give its typed job failure" (either
        (\problem -> Report.jobErrorCode problem==(if expected==JobStatusResponseStatusCancelled then Code.JobCancelled else Code.JobFailed)) (const False) outcome)
  forM_ [True,False] $ \wrongType -> withRig samples $ \rig -> do
    otherResult <- fixture samples "YieldJobDone"
    atomically $ modifyTVar' (statusValue rig) (\value -> value
      { jobStatusResponseStatus=JobStatusResponseStatusComplete
      , jobStatusResponseType=if wrongType then JobTypeYield else JobTypeMark
      , jobStatusResponseResult=if wrongType then Nothing else Just (JobStoredResultBranch1 (JobResultBranch2 otherResult)) })
    operation <- markRun rig
    worker <- async (try (Running.await operation) :: IO (Either TransportError MarkJobCompleteCommand))
    void (nextRequest rig (Channel.channelName Channel.JobCreate))
    Time.advance (time rig) (Timing.jobSilenceMs Timing.protocolSettings*1000000)
    wait worker >>= require "another verb's status became this job's completion" . either ((==Code.TransportError) . transportErrorCode) (const False)

stallCases :: Map.Map Text Value -> IO ()
stallCases samples = forM_ [False,True] $ \beforeCreation -> withRig samples $ \rig -> do
  atomically (writeTVar (holdCreate rig) beforeCreation)
  params <- fixture samples "GenerationJobParams"
  operation <- Yield.delegate (Client.yield (client rig)) params (Just 17)
  worker <- async (try (Running.await operation) :: IO (Either Report.JobError YieldJobCompleteCommand))
  void (nextRequest rig (Channel.channelName Channel.JobCreate))
  Time.advance (time rig) 16000000
  Time.advance (time rig) 1000000
  outcome <- wait worker
  require "a stalled generation lost its deadline or known job identity" (either
    (\problem -> Report.jobErrorCode problem==Code.JobStalled && Report.jobErrorDeadlineMs problem==Just 17
      && Report.jobErrorJobId problem==(if beforeCreation then Nothing else Just (jobId rig))) (const False) outcome)
  Time.settle
  if beforeCreation then atomically (isEmptyTQueue (requests rig)) >>= require "a stalled unanswered creation fabricated a cancellation id"
    else void (nextRequest rig (Channel.channelName Channel.JobCancelRequested))


defaultStallCase :: Map.Map Text Value -> IO ()
defaultStallCase samples = withRig samples $ \rig -> do
  params <- fixture samples "GenerationJobParams"
  let settings=Timing.protocolSettings
      floorMs=Timing.generationStallFloorMs settings
  require "the floor case no longer has a sub-floor token budget" (floorMs>Timing.generationStallPerTokenMs settings)
  operation <- Yield.delegate (Client.yield (client rig)) params { generationJobParamsMaxTokens=Just 1 } Nothing
  worker <- async (try (Running.await operation) :: IO (Either Report.JobError YieldJobCompleteCommand))
  void (nextRequest rig (Channel.channelName Channel.JobCreate))
  Time.advance (time rig) ((floorMs-1)*1000000)
  poll worker >>= require "default generation guard fired before its protocol floor" . maybe True (const False)
  progress rig
  Time.advance (time rig) ((floorMs-1)*1000000)
  poll worker >>= require "a progress frame did not restart the generation guard" . maybe True (const False)
  Time.advance (time rig) 1000000
  outcome <- wait worker
  require "default generation guard did not end at its restarted deadline" (either
    (\problem -> Report.jobErrorCode problem==Code.JobStalled && Report.jobErrorDeadlineMs problem==Just (fromInteger floorMs)) (const False) outcome)

disposalCases :: Map.Map Text Value -> IO ()
disposalCases samples = withRig samples $ \rig -> do
  atomically (writeTVar (holdCreate rig) True)
  operation <- markRun rig
  worker <- async (try (Running.await operation) :: IO (Either BusRequestError MarkJobCompleteCommand))
  void (nextRequest rig (Channel.channelName Channel.JobCreate))
  Client.dispose (client rig)
  wait worker >>= require "disposing a client left a follower waiting" . either ((==Code.BusRequestClosed) . busRequestErrorCode) (const False)

delegationCases :: Map.Map Text Value -> IO ()
delegationCases samples = do
  outcome <- timeout 15000000 (bufferedCases samples >> retryCases samples >> statusCases samples >> stallCases samples >> defaultStallCase samples >> disposalCases samples)
  require "delegation lifecycle did not settle" (outcome==Just ())
  putStrLn "PASS lazy delegation, ordered early reports, retry recovery, status fallback, typed endings, stall cancellation and joined disposal"

-- Runs client/clock-cases.json through the shared controlled-clock step runner.
followerClockCases :: FilePath -> Map.Map Text Value -> IO [Text]
followerClockCases root samples = clockCasesFor root ["jobFollower"] $ \clock _ -> do
  rig <- newRig samples clock
  operation <- markRun rig
  worker <- async (Running.await operation)
  pure (Scenario (progress rig) (readTVarIO (statusCount rig)) (Client.dispose (client rig) >> void (waitCatch worker)))
