{-# LANGUAGE OverloadedStrings #-}
-- | Composition and delegated marking for one resource. A quiet job remains
-- followed; a silence notice does not turn it into a failed job.
module Semiont.State.Mark
  ( MarkStateUnit, PendingAnnotation(..), newMarkStateUnit
  , pendingAnnotation, delegatingMotivation, progress, progressMotivation, failure, jobId
  , requestDelegate, cancelPending, dismissProgress, dispose
  ) where

import Control.Concurrent.Async (race)
import Control.Concurrent.STM
import Control.Exception (SomeException, catches, Handler(..), finally, toException, try, throwIO)
import Control.Monad (unless, when)
import Data.Aeson (Value(..))
import qualified Semiont.Client as Client
import qualified Semiont.Channels as Channel
import qualified Semiont.Delegation as Delegation
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (BusRequestError(..), TransportError(..))
import qualified Semiont.Internal.Local as Local
import Semiont.Internal.Generated.PendingAnnotation (PendingAnnotation(..))
import Semiont.Internal.Generated.MarkMotivation (markMotivation)
import qualified Semiont.Internal.StateTasks as Tasks
import qualified Semiont.Internal.StateValue as State
import qualified Semiont.Internal.Transport as Transport
import qualified Semiont.Mark as Mark
import Semiont.Retry (RetryOptions(..))
import qualified Semiont.Running as Running
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types
import OpenTelemetry.Context.ThreadLocal.Propagation (tracedWithAsync)
import qualified Streaming.Prelude as Stream

data MarkStateUnit = MarkStateUnit Tasks.Tasks Client.Client ResourceId RetryOptions Timing.Settings
  (State.StateValue (Maybe PendingAnnotation)) (State.StateValue (Maybe Motivation)) (State.StateValue (Maybe JobProgress))
  (State.StateValue (Maybe Motivation)) (State.StateValue (Maybe SomeException)) (State.StateValue (Maybe JobId))

newMarkStateUnit :: Client.Client -> ResourceId -> RetryOptions -> Timing.Settings -> IO MarkStateUnit
newMarkStateUnit client resource clock timing = do
  tasks <- Tasks.newTasks "mark state unit is closed"
  unit <- atomically (MarkStateUnit tasks client resource clock timing <$> State.newStateValue Nothing <*> State.newStateValue Nothing
    <*> State.newStateValue Nothing <*> State.newStateValue Nothing <*> State.newStateValue Nothing <*> State.newStateValue Nothing)
  Tasks.listen tasks (Client.bus client) [Channel.channelName Channel.MarkRequested,Channel.channelName Channel.MarkSubmit] $ \frame -> do
    let envelope=Transport.wireFrame frame
        payload=Object (busFramePayloadAdditionalProperties (busFramePayload envelope))
    if busFrameChannel envelope==Channel.channelName Channel.MarkRequested then case Channel.decodePayload Channel.MarkRequested payload of
      Left _ -> pure ()
      Right value -> when (markRequestedEventSource value==resource) (atomically
        (State.update (pendingAnnotation unit) (Just (PendingAnnotation (markRequestedEventSelector value) (markRequestedEventMotivation value)))))
    else case Channel.decodePayload Channel.MarkSubmit payload of
      Left _ -> pure ()
      Right value -> when (markSubmitEventSource value==resource) (Tasks.fork tasks (create unit value))
  pure unit

pendingAnnotation :: MarkStateUnit -> State.StateValue (Maybe PendingAnnotation)
pendingAnnotation (MarkStateUnit _ _ _ _ _ value _ _ _ _ _) = value
delegatingMotivation, progressMotivation :: MarkStateUnit -> State.StateValue (Maybe Motivation)
delegatingMotivation (MarkStateUnit _ _ _ _ _ _ value _ _ _ _) = value
progressMotivation (MarkStateUnit _ _ _ _ _ _ _ _ value _ _) = value
progress :: MarkStateUnit -> State.StateValue (Maybe JobProgress)
progress (MarkStateUnit _ _ _ _ _ _ _ value _ _ _) = value
failure :: MarkStateUnit -> State.StateValue (Maybe SomeException)
failure (MarkStateUnit _ _ _ _ _ _ _ _ _ value _) = value
jobId :: MarkStateUnit -> State.StateValue (Maybe JobId)
jobId (MarkStateUnit _ _ _ _ _ _ _ _ _ _ value) = value

create :: MarkStateUnit -> MarkSubmitEvent -> IO ()
create unit@(MarkStateUnit _ client resource _ _ _ _ _ _ _ _) submission = do
  let target=AnnotationTarget (Just (markSubmitEventSelector submission)) resource Nothing mempty
      request=CreateAnnotationRequest (markSubmitEventBody submission) (markSubmitEventMotivation submission) target mempty
      work=Mark.annotation (Client.mark client) request >> atomically (State.update (pendingAnnotation unit) Nothing)
      failed message=atomically (Local.signal (Client.bus client) Channel.MarkCreateError (ResourceErrorEvent message resource mempty) Channel.NoScope)
  work `catches` [Handler (failed . busRequestErrorMessage),Handler (failed . transportErrorMessage)]

requestDelegate :: MarkStateUnit -> MarkJobParams -> IO ()
requestDelegate unit@(MarkStateUnit tasks _ _ _ _ _ _ _ _ _ _) params = do
  let motivation=markMotivation params
  accepted <- atomically $ do
    over <- Tasks.closed tasks
    unless over $ do
      State.update (delegatingMotivation unit) (Just motivation)
      State.update (progress unit) Nothing
      State.update (progressMotivation unit) (Just motivation)
      State.update (failure unit) Nothing
      State.update (jobId unit) Nothing
    pure (not over)
  when accepted (Tasks.submit tasks (follow unit params motivation))

follow :: MarkStateUnit -> MarkJobParams -> Motivation -> IO () -> IO ()
follow unit@(MarkStateUnit _ client resource clock timing _ _ _ _ _ _) params motivation acceptedJob = do
  created <- newTVarIO Nothing
  let report event=do
        case event of Delegation.Created _ -> acceptedJob; _ -> pure ()
        atomically $ case event of
          Delegation.Created value -> writeTVar created (Just (jobCreatedResultResponseJobId value)) >> State.update (jobId unit) (Just (jobCreatedResultResponseJobId value))
          Delegation.Progress value -> State.update (progress unit) (Just value)
          Delegation.Failed _ -> pure ()
          Delegation.Complete _ -> pure ()
      quiet=atomically $ do
        current <- State.current (progress unit)
        when (current==Nothing) (State.update (progress unit) (Just (JobProgress Nothing Nothing Nothing Nothing Nothing Nothing Nothing 0 Nothing Nothing Nothing mempty)))
        Local.signal (Client.bus client) Channel.MarkDelegateTimeout (MarkDelegateTimeoutEvent motivation resource mempty) Channel.NoScope
      work=do
        run <- Mark.delegate (Client.mark client) resource params
        Running.withReports run $ \reports -> do
          queue <- newTQueueIO
          let pump values = do
                next <- Stream.next values
                case next of
                  Left _ -> atomically (writeTQueue queue (Right Nothing))
                  Right (event,rest) -> atomically (writeTQueue queue (Right (Just event))) >> pump rest
              readEvents = do
                result <- try (pump reports)
                case result of Left problem -> atomically (writeTQueue queue (Left (problem::SomeException))); Right () -> pure ()
              monitor listening due = do
                ready <- if listening then race (atomically (peekTQueue queue)) (retryWaitUntil clock due)
                  else Left <$> atomically (peekTQueue queue)
                case ready of
                  Right () -> quiet >> monitor False due
                  Left _ -> do
                    item <- atomically (readTQueue queue)
                    case item of
                      Left problem -> throwIO problem
                      Right Nothing -> pure ()
                      Right (Just event) -> do
                        report event
                        now <- retryNow clock
                        monitor True (now + Timing.delegateSilenceMs timing * 1000000)
          now <- retryNow clock
          tracedWithAsync readEvents (\_ -> monitor True (now + Timing.delegateSilenceMs timing * 1000000))
      failed problem cancelled=atomically $ do
        State.update (failure unit) (Just problem)
        unless cancelled (State.update (progress unit) Nothing >> State.update (progressMotivation unit) Nothing)
  work `catches`
    [Handler (\problem -> failed (toException problem) (Delegation.jobErrorCode problem==Code.JobCancelled))
    ,Handler (\problem -> failed (toException (problem::BusRequestError)) False)
    ,Handler (\problem -> failed (toException (problem::TransportError)) False)]
  atomically $ do
    State.update (delegatingMotivation unit) Nothing
    ours <- readTVar created
    current <- State.current (jobId unit)
    when (ours/=Nothing && ours==current) (State.update (jobId unit) Nothing)

cancelPending :: MarkStateUnit -> STM ()
cancelPending unit@(MarkStateUnit tasks _ _ _ _ _ _ _ _ _ _) = Tasks.closed tasks >>= \over -> unless over (State.update (pendingAnnotation unit) Nothing)
dismissProgress :: MarkStateUnit -> STM ()
dismissProgress unit@(MarkStateUnit tasks _ _ _ _ _ _ _ _ _ _) = Tasks.closed tasks >>= \over -> unless over
  (State.update (progress unit) Nothing >> State.update (progressMotivation unit) Nothing >> State.update (failure unit) Nothing)
dispose :: MarkStateUnit -> IO ()
dispose unit@(MarkStateUnit tasks _ _ _ _ _ _ _ _ _ _) = Tasks.dispose tasks `finally` atomically
  (State.complete (pendingAnnotation unit) >> State.complete (delegatingMotivation unit) >> State.complete (progress unit)
    >> State.complete (progressMotivation unit) >> State.complete (failure unit) >> State.complete (jobId unit))
