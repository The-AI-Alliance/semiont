{-# LANGUAGE DataKinds, GADTs, OverloadedStrings, ScopedTypeVariables, RankNTypes #-}

-- | One lazy, single-reader worker. Stop it before closing its transport.
module Semiont.Worker
  ( Claims, WorkerOptions(..), newClaims, next, refused, stalled, vitals, stop
  , HeldJob, SomeHeldJob(..), WorkerError(..)
  , jobId, jobType, resourceId, params, completedUnits, unitCursors, retryCount
  , maxRetries, attempt, annotationId, trace, cancelled, settled
  , start, progress, checkpoint, commit, complete, fail, cancel
  ) where

import Prelude hiding (fail)
import Control.Concurrent.Async (Async, async, waitCatch)
import qualified Control.Concurrent.Async as Async
import Control.Concurrent.MVar
import Control.Concurrent.STM
import Control.Exception
import Control.Monad.IO.Class (liftIO)
import Control.Monad (forM_, forever, unless, void, when)
import Data.Aeson (Result(..), Value(..), fromJSON, toJSON)
import qualified Data.Aeson.KeyMap as KM
import Data.List.NonEmpty (NonEmpty)
import qualified Data.List.NonEmpty as NE
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import qualified Data.Text as T
import qualified OpenTelemetry.Context as Context
import OpenTelemetry.Context.ThreadLocal (attachContext, detachContext)
import Semiont.Channels hiding (JobCheckpoint, JobComplete)
import qualified Semiont.Channels as Ch
import Semiont.Claims (jobClaimChannels, willRetryAfter)
import Semiont.ErrorCodes
import Semiont.Errors (BusRequestError(..))
import qualified Semiont.Internal.Broadcast as Broadcast
import qualified Semiont.Internal.Bus as Bus
import Semiont.JobFilter (jobMatchesFilter)
import qualified Semiont.StateValue as State
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types hiding (annotationId, JobComplete)
import qualified Semiont.Types as Types
import Semiont.Worker.Types
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream

data WorkerOptions = WorkerOptions
  { workerAccepts :: NonEmpty JobFilter
  , workerBusOptions :: Bus.BusOptions
  , workerTiming :: Timing.Settings
  , workerTimestamp :: IO Text
  -- ^ Current wall time as an ISO 8601 timestamp. Deadlines use the bus's monotonic clock.
  }
data WorkerError = ClaimsAlreadyReading | JobAlreadySettled | StartAlreadySaid | InvalidWorkerTiming deriving (Eq, Show)
instance Exception WorkerError

data Phase = Unread | Claiming | Stopped deriving Eq
data JobPhase = Claimed | Begun | Settled deriving Eq
data Completion result where
  MarkCompletion :: Completion MarkJobResult
  YieldCompletion :: Completion YieldJobResult
data SomeHeldJob = HeldMark (HeldJob MarkJobResult) | HeldYield (HeldJob YieldJobResult)
data HeldJob result = HeldJob
  { heldClaims :: Claims
  , heldRecord :: JobRunning
  , heldCompletion :: Completion result
  , heldTrace :: Maybe TraceCarrier
  , heldState :: TVar JobPhase
  , heldCancelled :: TVar Bool
  , heldDurability :: TVar (Maybe DurabilityEvidence)
  , heldGate :: MVar ()
  }
data Runtime = Runtime
  { phase :: Phase
  , held :: Maybe SomeHeldJob
  , heldAt :: Maybe (Integer, Text)
  , lastActive :: Maybe (Integer, Text)
  , lastQueued :: Maybe Text
  , lastClaim :: Maybe Text
  , lastFinished :: Maybe Text
  , completedCount :: Integer
  , stallReported :: Bool
  }
data Claims = Claims
  { options :: WorkerOptions
  , transport :: Transport.Transport
  , wire :: Bus.Bus
  , runtime :: TVar Runtime
  , wake :: TMVar ()
  , jobs :: TQueue SomeHeldJob
  , refusals :: Broadcast.Broadcast ClaimRefusal
  , stalls :: Broadcast.Broadcast HeldJobStall
  , workers :: MVar [Async ()]
  , reading :: MVar ()
  , stopping :: MVar (Maybe (Async ()))
  , fatal :: TMVar SomeException
  }

newClaims :: Transport.Transport -> WorkerOptions -> IO Claims
newClaims carrier configuration = do
  let timing = workerTiming configuration
  when (Timing.heldJobStallCheckMs timing <= 0 || any (< 0) [Timing.jobClaimTimeoutMs timing, Timing.heldJobStallMs timing, Timing.markCommitTimeoutMs timing])
    (throwIO InvalidWorkerTiming)
  cell <- newTVarIO (Runtime Unread Nothing Nothing Nothing Nothing Nothing Nothing 0 False)
  Claims configuration carrier (Bus.newBus (workerBusOptions configuration) carrier) cell
    <$> newEmptyTMVarIO <*> newTQueueIO <*> atomically Broadcast.newEvents <*> atomically Broadcast.newEvents
    <*> newMVar [] <*> newMVar () <*> newMVar Nothing <*> newEmptyTMVarIO

jobId :: HeldJob result -> JobId
jobId = jobMetadataId . jobRunningMetadata . heldRecord
jobType :: HeldJob result -> JobType
jobType = jobMetadataType . jobRunningMetadata . heldRecord
resourceId :: HeldJob result -> ResourceId
resourceId = jobParamsResourceId . params
params :: HeldJob result -> JobParams
params = jobRunningParams . heldRecord
completedUnits :: HeldJob result -> [Text]
completedUnits = fromMaybe [] . jobMetadataCompletedUnits . jobRunningMetadata . heldRecord
unitCursors :: HeldJob result -> KM.KeyMap UnitCursor
unitCursors = maybe KM.empty jobMetadataUnitCursorsAdditionalProperties . jobMetadataUnitCursors . jobRunningMetadata . heldRecord
retryCount :: HeldJob result -> Integer
retryCount = jobMetadataRetryCount . jobRunningMetadata . heldRecord
maxRetries :: HeldJob result -> Integer
maxRetries = jobMetadataMaxRetries . jobRunningMetadata . heldRecord
attempt :: HeldJob result -> Integer
attempt = (+ 1) . retryCount
annotationId :: HeldJob result -> Maybe AnnotationId
annotationId job = case jobType job of
  JobTypeMark -> Nothing
  JobTypeYield -> do
    Object context <- KM.lookup "context" (jobParamsAdditionalProperties (params job))
    Object focus <- KM.lookup "focus" context
    String "annotation" <- KM.lookup "kind" focus
    Object annotation <- KM.lookup "annotation" focus
    value <- KM.lookup "id" annotation
    case fromJSON value of Success identity -> Just identity; Error _ -> Nothing
trace :: HeldJob result -> Maybe TraceCarrier
trace = heldTrace
cancelled :: HeldJob result -> STM Bool
cancelled = readTVar . heldCancelled
settled :: HeldJob result -> STM Bool
settled job = (== Settled) <$> readTVar (heldState job)

withSome :: SomeHeldJob -> (forall result. HeldJob result -> value) -> value
withSome (HeldMark job) f = f job
withSome (HeldYield job) f = f job

stamp :: Claims -> IO (Integer, Text)
stamp claims = (,) <$> Bus.requestNow (workerBusOptions (options claims)) <*> workerTimestamp (options claims)

wakeIdle :: Claims -> STM ()
wakeIdle claims = do
  current <- readTVar (runtime claims)
  when (phase current == Claiming && maybe True (const False) (held current)) (void (tryPutTMVar (wake claims) ()))

observe :: Broadcast.Broadcast value -> (Stream (Of value) IO () -> IO result) -> IO result
observe broadcast consume = Broadcast.withSubscription broadcast $ \reader ->
  let loop = do
        value <- liftIO (atomically (Broadcast.next reader))
        case value of Nothing -> pure (); Just item -> Stream.yield item >> loop
  in consume loop
refused :: Claims -> (Stream (Of ClaimRefusal) IO () -> IO result) -> IO result
refused = observe . refusals
stalled :: Claims -> (Stream (Of HeldJobStall) IO () -> IO result) -> IO result
stalled = observe . stalls

next :: Claims -> IO (Maybe SomeHeldJob)
next claims = mask $ \restore -> do
  acquired <- tryTakeMVar (reading claims)
  unless (acquired == Just ()) (throwIO ClaimsAlreadyReading)
  restore (begin claims >> atomically
    ((Just <$> readTQueue (jobs claims)) `orElse` (readTMVar (fatal claims) >>= throwSTM) `orElse` do
      current <- readTVar (runtime claims)
      check (phase current == Stopped)
      pure Nothing)) `onException` stop claims `finally` putMVar (reading claims) ()

begin :: Claims -> IO ()
begin claims = modifyMVar_ (workers claims) $ \existing -> mask $ \restore -> do
  fresh <- atomically $ do
    current <- readTVar (runtime claims)
    case phase current of
      Unread -> writeTVar (runtime claims) current { phase = Claiming } >> pure True
      Claiming -> pure False
      Stopped -> pure False
  if not fresh then pure existing else do
    forM_ jobClaimChannels $ \channel -> unless (Transport.isSubscribed (transport claims) channel) $ do
      atomically $ do
        modifyTVar' (runtime claims) (\s -> s { phase = Stopped })
        Broadcast.close (refusals claims)
        Broadcast.close (stalls claims)
      throwIO (Bus.unsubscribed channel)
    readyQueued <- newEmptyMVar
    readyCancel <- newEmptyMVar
    readyState <- newEmptyMVar
    readyStall <- newEmptyMVar
    let spawn action = async (restore action `catch` \(problem :: SomeException) ->
          case fromException problem :: Maybe SomeAsyncException of
            Just _ -> throwIO problem
            Nothing -> atomically (void (tryPutTMVar (fatal claims) problem)))
    queuedWorker <- spawn $ Transport.stream (transport claims) (channelName JobQueued) $ \events -> do
      putMVar readyQueued ()
      Stream.mapM_ (either (const (refusedAnnouncement claims)) (announced claims)) events
    cancelWorker <- spawn $ Transport.stream (transport claims) (channelName JobCancelRequested) $ \events -> do
      putMVar readyCancel ()
      Stream.mapM_ (either (const (pure ())) (cancellation claims)) events
    stateWorker <- spawn $ State.watch (Transport.state (transport claims)) $ \states -> do
      putMVar readyState ()
      let loop wasOpen source = do
            item <- Stream.next source
            case item of
              Left () -> pure ()
              Right (value, rest) -> do
                let isOpen = value == Transport.Open
                when (isOpen && not wasOpen) (atomically (wakeIdle claims))
                loop isOpen rest
      loop False states
    stallWorker <- spawn (checkStalls claims (putMVar readyStall ()))
    let monitors = [queuedWorker,cancelWorker,stateWorker,stallWorker]
    restore (void (Async.race (mapM_ takeMVar [readyQueued,readyCancel,readyState,readyStall])
      (atomically (readTMVar (fatal claims)) >>= throwIO))) `onException` mapM_ Async.cancel monitors
    actor <- spawn (claimLoop claims)
    pure (actor : monitors)

refusedAnnouncement :: Claims -> IO ()
refusedAnnouncement claims = do
  timestamp <- workerTimestamp (options claims)
  atomically $ do
    modifyTVar' (runtime claims) (\current -> current { lastQueued = Just timestamp })
    wakeIdle claims

announced :: Claims -> KM.KeyMap Value -> IO ()
announced claims payload = do
  timestamp <- workerTimestamp (options claims)
  atomically $ do
    modifyTVar' (runtime claims) (\current -> current { lastQueued = Just timestamp })
    case decodePayload JobQueued (Object payload) of
      Left _ -> wakeIdle claims
      Right _ -> when (any (\filterValue -> jobMatchesFilter filterValue (Object payload)) (workerAccepts (options claims))) (wakeIdle claims)

cancellation :: Claims -> KM.KeyMap Value -> IO ()
cancellation claims payload = atomically $ do
  current <- readTVar (runtime claims)
  forM_ (held current) $ \job -> withSome job $ \value ->
    when (KM.lookup "jobId" payload == Just (toJSON (jobId value))) $ do
      over <- settled value
      unless over (writeTVar (heldCancelled value) True)

trySync :: IO value -> IO (Either SomeException value)
trySync action = try action >>= \result -> case result of
  Left problem | Just (_ :: SomeAsyncException) <- fromException problem -> throwIO problem
  _ -> pure result

claimLoop :: Claims -> IO ()
claimLoop claims = forever $ mask $ \restore -> do
  atomically $ do
    current <- readTVar (runtime claims)
    check (phase current == Claiming && maybe True (const False) (held current))
    connection <- State.current (Transport.state (transport claims))
    check (connection == Transport.Open)
    takeTMVar (wake claims)
  let configuration = options claims
      command = JobClaimCommand Nothing Nothing (NE.toList (workerAccepts configuration)) KM.empty
      rooted action = bracket (attachContext Context.empty) detachContext (const action)
  outcome <- restore $ rooted $ trySync $ Bus.requestDelivered (wire claims) JobClaimOperation command
    (Timing.jobClaimTimeoutMs (workerTiming configuration))
  case outcome of
    Left problem -> case fromException problem of
      Just refusal | busRequestErrorCode refusal == BusRequestNonePending -> pure ()
      maybeRefusal -> atomically $ do
        current <- readTVar (runtime claims)
        when (phase current == Claiming) $ Broadcast.publish (refusals claims)
          (ClaimRefusal (busRequestErrorCode <$> maybeRefusal) (maybe (T.pack (displayException problem)) busRequestErrorMessage maybeRefusal))
    Right delivered -> do
      let record = jobClaimedResultResponse (Bus.deliveredPayload delivered)
      state <- newTVarIO Claimed
      cancellationCell <- newTVarIO False
      durability <- newTVarIO Nothing
      gate <- newMVar ()
      let make :: Completion result -> HeldJob result
          make completion = HeldJob claims record completion (Transport.frameTrace (Bus.deliveredFrame delivered)) state cancellationCell durability gate
          job = case jobMetadataType (jobRunningMetadata record) of
            JobTypeMark -> HeldMark (make MarkCompletion)
            JobTypeYield -> HeldYield (make YieldCompletion)
      now <- restore (stamp claims)
      kept <- atomically $ do
        current <- readTVar (runtime claims)
        if phase current /= Claiming then pure False else do
          _ <- tryTakeTMVar (wake claims)
          writeTVar (runtime claims) current { held = Just job, heldAt = Just now, lastActive = Just now, lastClaim = Just (snd now), stallReported = False }
          writeTQueue (jobs claims) job
          pure True
      unless kept (void (restore (trySync (withSome job (\value -> fail value stoppedMessage Nothing)))))

checkStalls :: Claims -> IO () -> IO ()
checkStalls claims ready = do
  now <- Bus.requestNow clock
  ready
  loop now
  where
    clock = workerBusOptions (options claims)
    timing = workerTiming (options claims)
    loop before = do
      Bus.requestWaitUntil clock (before + Timing.heldJobStallCheckMs timing * 1000000)
      currentTime <- Bus.requestNow clock
      atomically $ do
        current <- readTVar (runtime claims)
        case (held current, heldAt current, lastActive current) of
          (Just job, Just (_, since), Just (active, activeStamp))
            | not (stallReported current) && currentTime - active > Timing.heldJobStallMs timing * 1000000 -> do
              Broadcast.publish (stalls claims) (withSome job $ \value -> HeldJobStall (jobId value) (jobType value) since activeStamp
                (fromRational (toRational (currentTime-active) / 1000000)) (fromInteger (Timing.heldJobStallMs timing)))
              writeTVar (runtime claims) current { stallReported = True }
          _ -> pure ()
      loop currentTime

vitals :: Claims -> IO WorkerVitals
vitals claims = atomically $ do
  current <- readTVar (runtime claims)
  let active = case (held current,heldAt current) of
        (Just job, Just (_,since)) -> Just (withSome job $ \value -> WorkerVitalsActiveJob (jobId value) (jobType value) since)
        _ -> Nothing
  pure (WorkerVitals (lastQueued current) (lastClaim current) (lastFinished current) (snd <$> lastActive current) active (fromInteger (completedCount current)))

stoppedMessage :: Text
stoppedMessage = "The worker stopped while it held the job"

stop :: Claims -> IO ()
stop claims = mask $ \restore -> do
  closer <- modifyMVar (stopping claims) $ \previous -> case previous of
    Just child -> pure (previous, child)
    Nothing -> do
      child <- async (stopNow claims)
      pure (Just child, child)
  restore (Async.wait closer)

stopNow :: Claims -> IO ()
stopNow claims = mask $ \restore -> do
  previous <- atomically $ do
    current <- readTVar (runtime claims)
    writeTVar (runtime claims) current { phase = Stopped }
    _ <- flushTQueue (jobs claims)
    pure (held current)
  active <- modifyMVar (workers claims) (\running -> pure ([],running))
  let finish = atomically (Broadcast.close (refusals claims) >> Broadcast.close (stalls claims))
  (do
    mapM_ Async.cancel active
    mapM_ waitCatch active
    forM_ previous $ \job -> withSome job $ \value -> do
      over <- atomically (settled value)
      unless over (void (restore (trySync (fail value stoppedMessage Nothing))))) `finally` finish

unsettled :: HeldJob result -> STM ()
unsettled job = settled job >>= \over -> when over (throwSTM JobAlreadySettled)

emit :: HeldJob result -> Channel 'Global payload -> payload -> IO ()
emit job channel payload = void (Bus.emit (wire (heldClaims job)) channel payload NoScope Nothing)

markActivity :: HeldJob result -> IO ()
markActivity job = do
  now <- stamp (heldClaims job)
  atomically (modifyTVar' (runtime (heldClaims job)) (\current -> current { lastActive = Just now }))

start :: HeldJob result -> IO ()
start job = withMVar (heldGate job) $ \() -> do
  atomically $ do
    unsettled job
    before <- readTVar (heldState job)
    unless (before == Claimed) (throwSTM StartAlreadySaid)
    writeTVar (heldState job) Begun
  emit job JobStart (JobStartCommand Nothing (annotationId job) (Just (attempt job)) (jobId job) (jobType job) (resourceId job) KM.empty)

progress :: HeldJob result -> JobProgress -> IO ()
progress job value = withMVar (heldGate job) $ \() -> do
  atomically (unsettled job >> writeTVar (heldState job) Begun)
  markActivity job
  let report = case annotationId job of Nothing -> value; Just identity -> value { jobProgressAnnotationId = Just identity }
  emit job JobReportProgress (JobReportProgressCommand Nothing (annotationId job) (Just (attempt job)) (jobId job) (jobType job)
    (jobProgressPercentage value) (Just report) (resourceId job) KM.empty)

checkpoint :: HeldJob result -> JobCheckpoint -> IO ()
checkpoint job value = withMVar (heldGate job) $ \() -> do
  atomically (unsettled job >> writeTVar (heldState job) Begun)
  markActivity job
  emit job Ch.JobCheckpoint (JobCheckpointCommand Nothing (jobCheckpointCompletedUnits value) (jobId job)
    (JobCheckpointCommandUnitCursors <$> jobCheckpointUnitCursors value) KM.empty)

weakness :: DurabilityEvidence -> Int
weakness DurabilityEvidenceAcknowledged = 0
weakness DurabilityEvidenceProbeU2d_confirmed = 1
weakness DurabilityEvidenceProbeU2d_refused = 2
weakness DurabilityEvidenceProbeU2d_unreachable = 2

observeDurability :: HeldJob result -> DurabilityEvidence -> IO ()
observeDurability job observed = atomically $ modifyTVar' (heldDurability job) $ \prior ->
  case prior of Just value | weakness value >= weakness observed -> prior; _ -> Just observed

commit :: HeldJob result -> ResourceId -> [Annotation] -> IO ()
commit job resource annotations = withMVar (heldGate job) $ \() -> do
  atomically (unsettled job)
  case reverse annotations of
    [] -> pure ()
    lastAnnotation : _ -> do
      let claims = heldClaims job
          timeoutMs = Timing.markCommitTimeoutMs (workerTiming (options claims))
          send = Bus.request (wire claims) MarkCommitOperation (MarkCommitCommand Nothing Nothing annotations (Just (jobId job)) resource KM.empty) timeoutMs
      result <- try send
      case result of
        Right _ -> observeDurability job DurabilityEvidenceAcknowledged
        Left (problem :: BusRequestError) | busRequestErrorCode problem == BusRequestTimeout -> do
          probe <- trySync (Bus.request (wire claims) BrowseAnnotationRequestedOperation
            (BrowseAnnotationRequest (Types.annotationId lastAnnotation) resource KM.empty) timeoutMs)
          let evidence = case probe of
                Right _ -> DurabilityEvidenceProbeU2d_confirmed
                Left failure | Just refusedProbe <- fromException failure, busRequestErrorCode refusedProbe == BusRequestRejected -> DurabilityEvidenceProbeU2d_refused
                Left _ -> DurabilityEvidenceProbeU2d_unreachable
          observeDurability job evidence
          unless (evidence == DurabilityEvidenceProbeU2d_confirmed) (throwIO problem)
        Left problem -> throwIO problem

release :: HeldJob result -> Bool -> IO ()
release job completed = do
  now <- stamp (heldClaims job)
  let claims = heldClaims job
  atomically $ do
    current <- readTVar (runtime claims)
    when (maybe False (\value -> withSome value (\other -> jobId other == jobId job)) (held current)) $ do
      writeTVar (runtime claims) current { held = Nothing, heldAt = Nothing, lastFinished = Just (snd now), lastActive = Just now
        , completedCount = completedCount current + if completed then 1 else 0 }
      wakeIdle claims

settle :: HeldJob result -> Bool -> IO () -> IO ()
settle job completed action = withMVar (heldGate job) $ \() -> mask $ \restore -> do
  atomically (unsettled job >> writeTVar (heldState job) Settled)
  restore action `finally` release job completed

complete :: HeldJob result -> result -> IO ()
complete job result = settle job True $ do
  durability <- readTVarIO (heldDurability job)
  let payload = case heldCompletion job of
        MarkCompletion -> JobCompleteCommandBranch1 (MarkJobCompleteCommand Nothing (Just (attempt job)) durability (jobId job)
          MarkJobCompleteCommandJobTypeMark (resourceId job) (Just result) KM.empty)
        YieldCompletion -> JobCompleteCommandBranch2 (YieldJobCompleteCommand Nothing (annotationId job) (Just (attempt job)) durability (jobId job)
          YieldJobCompleteCommandJobTypeYield (resourceId job) (Just result) KM.empty)
  emit job Ch.JobComplete payload

fail :: HeldJob result -> Text -> Maybe JobFailure -> IO ()
fail job message failure = settle job False $ do
  observed <- readTVarIO (heldDurability job)
  let durability = observed >>= \value -> if weakness value > weakness DurabilityEvidenceProbeU2d_confirmed then Just value else Nothing
      classification = failure >>= jobFailureFailureClass
      units = failure >>= jobFailureCompletedUnits
      cursors = JobFailCommandUnitCursors <$> (failure >>= jobFailureUnitCursors)
  emit job JobFail (JobFailCommand Nothing (annotationId job) (Just (attempt job)) units durability message classification
    (jobId job) (jobType job) (resourceId job) cursors (Just (willRetryAfter (jobRunningMetadata (heldRecord job)) classification)) KM.empty)

cancel :: HeldJob result -> Maybe JobReached -> IO ()
cancel job reached = settle job False $
  emit job JobCancel (JobCancelCommand Nothing (annotationId job) (reached >>= jobReachedCompletedUnits)
    (jobId job) (jobType job) (resourceId job) (JobCancelCommandUnitCursors <$> (reached >>= jobReachedUnitCursors)) KM.empty)
