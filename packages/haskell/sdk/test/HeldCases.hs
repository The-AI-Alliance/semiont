{-# LANGUAGE DataKinds, GADTs, OverloadedStrings, ScopedTypeVariables #-}
module HeldCases (heldCases, heldClockCases) where

import Control.Concurrent (yield)
import Control.Concurrent.Async (async, cancel, wait, concurrently)
import Control.Concurrent.MVar
import Control.Concurrent.STM
import Control.Exception (IOException, bracket, try)
import Control.Monad (forM_, unless, when)
import Data.Aeson (FromJSON, Result(..), Value(..), fromJSON, toJSON)
import qualified Data.Aeson.KeyMap as KM
import qualified Data.List.NonEmpty as NE
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as T
import qualified Semiont.Bus as Bus
import Semiont.Channels hiding (JobComplete, JobCheckpoint)
import qualified Semiont.Channels as Ch
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (BusRequestError(..))
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types
import qualified Semiont.Worker as Worker
import Semiont.Worker.Types
import qualified Streaming.Prelude as Stream
import System.Timeout (timeout)
import ClockCases (Scenario(..), clockCasesFor)
import qualified ControlledTime as Time

require :: String -> Bool -> IO ()
require label value = unless value (ioError (userError label))
decode :: FromJSON value => Value -> IO value
decode value = case fromJSON value of Error message -> ioError (userError message); Success parsed -> pure parsed
fixture :: FromJSON value => Map.Map Text Value -> Text -> IO value
fixture values name = maybe (ioError (userError ("missing schema fixture " ++ T.unpack name))) decode (Map.lookup name values)

data Rig = Rig Worker.Claims Transport.TransportInput (TQueue BusFrame) (TVar Integer) (TVar Bool)

rig :: Map.Map Text Value -> (Rig -> IO result) -> IO result
rig fixtures action = do
  sent <- newTQueueIO
  clock <- newTVarIO 0
  ids <- newTVarIO (0 :: Integer)
  failEmission <- newTVarIO False
  filterValue <- fixture fixtures "JobFilter"
  let send frame = do
        broken <- readTVarIO failEmission
        when (broken && busFrameChannel frame /= channelName JobClaim) (ioError (userError "send refused"))
        atomically (writeTQueue sent frame)
        pure Nothing
      clockOptions = Bus.BusOptions (readTVarIO clock) (\due -> atomically (readTVar clock >>= check . (>= due)))
        (atomically $ do modifyTVar' ids (+1); number <- readTVar ids; pure (T.pack (show number)))
      timing = Timing.protocolSettings { Timing.jobClaimTimeoutMs = 100, Timing.markCommitTimeoutMs = 10,
        Timing.heldJobStallMs = 1000, Timing.heldJobStallCheckMs = 100 }
      configuration = Worker.WorkerOptions (filterValue NE.:| []) clockOptions timing (pure "2026-11-05T00:00:00Z")
  bracket (Transport.newTransport (Transport.TransportOptions "local://worker" (Set.fromList channelNames) send (pure ())))
    (Transport.dispose . fst) $ \(carrier,input) -> do
      Transport.setState input Transport.Connecting
      Transport.setState input Transport.Open
      bracket (Worker.newClaims carrier configuration) Worker.stop $ \worker -> action (Rig worker input sent clock failEmission)

outgoing :: Rig -> Text -> IO BusFrame
outgoing (Rig _ _ sent _ _) expected = do
  frame <- atomically (readTQueue sent)
  require ("unexpected worker channel: " ++ T.unpack (busFrameChannel frame)) (busFrameChannel frame == expected)
  pure frame

reply :: Rig -> BusFrame -> Channel 'Global payload -> payload -> IO ()
reply (Rig _ input _ _ _) request channel payload = case encodePayload channel payload of
  Object fields -> Transport.receive input (BusFrame (channelName channel) (busFrameCorrelationId request) (BusFramePayload fields) Nothing)
  _ -> ioError (userError "reply fixture is no object")

record :: Map.Map Text Value -> IO JobRunning
record fixtures = do
  value <- fixture fixtures "JobRunning"
  pure value { jobRunningMetadata = (jobRunningMetadata value) { jobMetadataType = JobTypeMark, jobMetadataRetryCount = 1, jobMetadataMaxRetries = 3 } }

acquire :: Map.Map Text Value -> Rig -> IO (Worker.HeldJob MarkJobResult)
acquire fixtures rigValue@(Rig worker _ _ _ _) = do
  reader <- async (Worker.next worker)
  asked <- outgoing rigValue (channelName JobClaim)
  running <- record fixtures
  reply rigValue asked JobClaimed (JobClaimedResult running)
  answer <- wait reader
  case answer of Just (Worker.HeldMark job) -> pure job; _ -> ioError (userError "claim did not hand over a typed mark job")

heldCases :: Map.Map Text Value -> IO ()
heldCases fixtures = do
  result <- timeout 15000000 (lifecycle fixtures >> commits fixtures >> failedSettle fixtures >> stopping fixtures >> idleAndStalled fixtures >> yieldJob fixtures)
  require "held-job liveness deadline expired" (result == Just ())
  putStrLn "PASS worker lifecycle, cancellation, commit evidence, atomic settlement and scoped shutdown"

lifecycle :: Map.Map Text Value -> IO ()
lifecycle fixtures = rig fixtures $ \rigValue@(Rig worker input sent _ _) -> do
  job <- acquire fixtures rigValue
  require "attempt was not read from the claimed record" (Worker.retryCount job == 1 && Worker.maxRetries job == 3 && Worker.attempt job == 2)
  require "first attempt checkpoint was manufactured" (null (Worker.completedUnits job) && KM.null (Worker.unitCursors job))
  require "claim identity changed" (Worker.resourceId job == jobParamsResourceId (Worker.params job) && Worker.jobType job == JobTypeMark)
  require "mark job was anchored to an annotation" (Worker.annotationId job == Nothing)
  Worker.start job
  _ <- outgoing rigValue (channelName JobStart)
  repeated <- try (Worker.start job)
  require "start was emitted twice" (repeated == Left Worker.StartAlreadySaid)
  value <- fixture fixtures "JobProgress"
  Worker.progress job value
  _ <- outgoing rigValue (channelName JobReportProgress)
  Worker.checkpoint job (JobCheckpoint ["done"] Nothing)
  _ <- outgoing rigValue (channelName Ch.JobCheckpoint)
  let cancelPayload identity = Object (KM.singleton "jobId" (toJSON identity))
  other <- (decode (String "another-job") :: IO JobId)
  let sendCancel identity = case cancelPayload identity of
        Object fields -> Transport.receive input (BusFrame (channelName JobCancelRequested) Nothing (BusFramePayload fields) Nothing)
        _ -> ioError (userError "cancel is not an object")
  sendCancel other
  atomically (Worker.cancelled job) >>= require "another job's cancellation was signalled" . not
  sendCancel (Worker.jobId job)
  atomically (Worker.cancelled job >>= check)
  Worker.commit job (Worker.resourceId job) []
  empty <- atomically (isEmptyTQueue sent)
  require "empty commit sent a request" empty
  result <- fixture fixtures "MarkJobResult"
  (first, second) <- concurrently (try (Worker.complete job result)) (try (Worker.complete job result))
  require "two settlements both took effect" ((first == Right () && second == Left Worker.JobAlreadySettled) || (second == Right () && first == Left Worker.JobAlreadySettled))
  _ <- outgoing rigValue (channelName Ch.JobComplete)
  _ <- outgoing rigValue (channelName JobClaim)
  stats <- Worker.vitals worker
  require "completed job remained held or uncounted" (workerVitalsJobsCompleted stats == 1 && workerVitalsActiveJob stats == Nothing && workerVitalsLastFinishedAt stats /= Nothing)
  after <- try (Worker.progress job value)
  require "settled job still reported progress" (after == Left Worker.JobAlreadySettled)

commits :: Map.Map Text Value -> IO ()
commits fixtures = forM_ [0 :: Int .. 3] $ \mode -> rig fixtures $ \rigValue@(Rig _ _ _ clock _) -> do
  job <- acquire fixtures rigValue
  annotation <- fixture fixtures "Annotation"
  running <- async (Worker.commit job (Worker.resourceId job) [annotation])
  asked <- outgoing rigValue (channelName MarkCommit)
  case mode of
    0 -> fixture fixtures "MarkCommitOk" >>= reply rigValue asked Ch.MarkCommitOk
    _ -> do
      atomically (writeTVar clock 10000000)
      probe <- outgoing rigValue (channelName BrowseAnnotationRequested)
      case mode of
        1 -> fixture fixtures "BrowseAnnotationResult" >>= reply rigValue probe Ch.BrowseAnnotationResult
        2 -> reply rigValue probe BrowseAnnotationFailed (CommandError Nothing Nothing "probe refused" KM.empty)
        _ -> atomically (writeTVar clock 20000000)
  outcome <- try (wait running) :: IO (Either BusRequestError ())
  require "commit outcome disagrees with its observation" (case outcome of Right () -> mode < 2; Left failure -> mode >= 2 && busRequestErrorCode failure == Code.BusRequestTimeout)
  Worker.fail job "finished test" Nothing
  said <- outgoing rigValue (channelName JobFail)
  payload <- decode (Object (busFramePayloadAdditionalProperties (busFramePayload said)))
  let expected = case mode of 2 -> Just DurabilityEvidenceProbeU2d_refused; 3 -> Just DurabilityEvidenceProbeU2d_unreachable; _ -> Nothing
  require "failed job misstated durability or retry budget" (jobFailCommandDurability payload == expected && jobFailCommandWillRetry payload == Just True)

failedSettle :: Map.Map Text Value -> IO ()
failedSettle fixtures = rig fixtures $ \rigValue@(Rig _ _ _ _ broken) -> do
  job <- acquire fixtures rigValue
  atomically (writeTVar broken True)
  failure <- try (Worker.fail job "work failed" (Just (JobFailure Nothing Nothing (Just FailureClassWithheld)))) :: IO (Either IOException ())
  require "settle emission unexpectedly succeeded" (either (const True) (const False) failure)
  atomically (Worker.settled job) >>= require "failed emission did not settle the job"
  _ <- outgoing rigValue (channelName JobClaim)
  pure ()

stopping :: Map.Map Text Value -> IO ()
stopping fixtures = rig fixtures $ \rigValue@(Rig worker _ _ _ _) -> do
  job <- acquire fixtures rigValue
  ((),()) <- concurrently (Worker.stop worker) (Worker.stop worker)
  said <- outgoing rigValue (channelName JobFail)
  payload <- decode (Object (busFramePayloadAdditionalProperties (busFramePayload said)))
  require "stop did not fail the held job for retry" (jobFailCommandWillRetry payload == Just True && jobFailCommandFailureClass payload == Nothing)
  atomically (Worker.settled job) >>= require "stop left an unsettled job"
  answer <- Worker.next worker
  require "stopped claims did not end" (case answer of Nothing -> True; _ -> False)
  observer <- async (Worker.refused worker Stream.toList_)
  readBack <- wait observer
  require "stopped worker retained its refusal stream" (null readBack)

idleAndStalled :: Map.Map Text Value -> IO ()
idleAndStalled fixtures = rig fixtures $ \rigValue@(Rig worker input _ clock _) -> do
  readyRefused <- newEmptyMVar
  refusalReader <- async $ Worker.refused worker $ \events -> putMVar readyRefused () >> Stream.head_ events
  takeMVar readyRefused
  reader <- async (Worker.next worker)
  firstClaim <- outgoing rigValue (channelName JobClaim)
  filterValue <- fixture fixtures "JobFilter"
  let announce = case toJSON (filterValue :: JobFilter) of
        Object fields -> Transport.receive input (BusFrame (channelName JobQueued) Nothing (BusFramePayload fields) Nothing)
        _ -> ioError (userError "filter was not an object")
      waitStamp = do
        stats <- Worker.vitals worker
        case workerVitalsLastQueuedEventAt stats of Nothing -> yield >> waitStamp; Just _ -> pure ()
  announce
  waitStamp
  reply rigValue firstClaim JobClaimFailed (CommandError (Just CommandErrorCodeNoneU2d_pending) Nothing "empty" KM.empty)
  secondClaim <- outgoing rigValue (channelName JobClaim)
  reply rigValue secondClaim JobClaimFailed (CommandError (Just CommandErrorCodeUnauthorized) Nothing "refused" KM.empty)
  refusal <- wait refusalReader
  require "none-pending was reported or refusal lost its code" (fmap claimRefusalCode refusal == Just (Just Code.BusRequestUnauthorized))
  Transport.setState input Transport.Reconnecting
  Transport.setState input Transport.Connecting
  Transport.setState input Transport.Open
  reopened <- outgoing rigValue (channelName JobClaim)
  running <- record fixtures
  reply rigValue reopened JobClaimed (JobClaimedResult running)
  received <- wait reader
  job <- case received of Just (Worker.HeldMark value) -> pure value; _ -> ioError (userError "reopen did not resume claiming")
  readyStalled <- newEmptyMVar
  stallReader <- async $ Worker.stalled worker $ \events -> putMVar readyStalled () >> Stream.head_ events
  takeMVar readyStalled
  atomically (writeTVar clock 1100000000)
  event <- wait stallReader
  require "held job stall was not reported" (fmap heldJobStallJobId event == Just (Worker.jobId job))
  Worker.cancel job (Just (JobReached (Just ["done"]) Nothing))
  frame <- outgoing rigValue (channelName JobCancel)
  value <- decode (Object (busFramePayloadAdditionalProperties (busFramePayload frame)))
  require "cancel checkpoint was not retained" (jobCancelCommandCompletedUnits value == Just ["done"])

yieldJob :: Map.Map Text Value -> IO ()
yieldJob fixtures = rig fixtures $ \rigValue@(Rig worker _ _ _ _) -> do
  reader <- async (Worker.next worker)
  asked <- outgoing rigValue (channelName JobClaim)
  running <- record fixtures
  let asYield = running { jobRunningMetadata = (jobRunningMetadata running) { jobMetadataType = JobTypeYield } }
  reply rigValue asked JobClaimed (JobClaimedResult asYield)
  received <- wait reader
  case received of
    Just (Worker.HeldYield job) -> do
      require "yield record had a spurious annotation anchor" (Worker.annotationId job == Nothing)
      value <- fixture fixtures "YieldJobResult"
      Worker.complete job value
      _ <- outgoing rigValue (channelName Ch.JobComplete)
      pure ()
    _ -> ioError (userError "yield job was not handed over with its own result type")

-- Public worker owner for the heldJobStall subjects of client/clock-cases.json.
heldClockCases :: FilePath -> Map.Map Text Value -> IO ()
heldClockCases root fixtures = clockCasesFor root ["heldJobStall"] $ \clock _ -> do
  sent <- newTQueueIO
  ids <- newTVarIO (0::Integer)
  stalls <- newTVarIO 0
  accepts <- fixture fixtures "JobFilter"
  running <- record fixtures
  progressValue <- fixture fixtures "JobProgress"
  let options = Bus.BusOptions (Time.now clock) (Time.waitUntil clock)
        (atomically (modifyTVar' ids (+1) >> T.pack . show <$> readTVar ids))
      config = Worker.WorkerOptions (accepts NE.:| []) options Timing.protocolSettings (pure "2026-11-05T00:00:00Z")
      send frame = atomically (writeTQueue sent frame) >> pure Nothing
  (carrier,input) <- Transport.newTransport (Transport.TransportOptions "local://clock-worker" (Set.fromList channelNames) send (pure ()))
  Transport.setState input Transport.Connecting
  Transport.setState input Transport.Open
  worker <- Worker.newClaims carrier config
  observer <- async (Worker.stalled worker (Stream.mapM_ (\_ -> atomically (modifyTVar' stalls (+1)))))
  reader <- async (Worker.next worker)
  asked <- atomically (readTQueue sent)
  require "clock worker did not claim" (busFrameChannel asked == channelName JobClaim)
  case encodePayload JobClaimed (JobClaimedResult running) of
    Object fields -> Transport.receive input (BusFrame (channelName JobClaimed) (busFrameCorrelationId asked) (BusFramePayload fields) Nothing)
    _ -> ioError (userError "clock claim reply is not an object")
  received <- wait reader
  job <- case received of Just (Worker.HeldMark value) -> pure value; _ -> ioError (userError "clock worker did not receive its held job")
  pure (Scenario (Worker.progress job progressValue) (readTVarIO stalls)
    (cancel observer >> Worker.stop worker >> Transport.dispose carrier))
