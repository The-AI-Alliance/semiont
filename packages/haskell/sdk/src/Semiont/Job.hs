{-# LANGUAGE OverloadedStrings #-}
module Semiont.Job (JobNamespace, newJob, PollOptions(..), queued, progress, complete, fail, status, pollUntilComplete, cancel, claim) where

import Prelude hiding (fail)
import Control.Exception (throwIO)
import Control.Monad (when)
import Data.Maybe (fromMaybe)
import qualified Semiont.Bus as Bus
import Semiont.Channels hiding (JobComplete)
import qualified Semiont.Channels as Channel
import Semiont.ErrorCodes (BusRequestCode(BusRequestTimeout))
import Semiont.Errors (BusRequestError(..))
import Semiont.EventBus (EventBus)
import qualified Semiont.Internal.Local as Local
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types
import qualified Semiont.Worker as Worker
import Streaming (Of, Stream)

data JobNamespace = JobNamespace Bus.Bus EventBus Transport.Transport Bus.BusOptions Timing.Settings
newJob :: Bus.Bus -> EventBus -> Transport.Transport -> Bus.BusOptions -> Timing.Settings -> JobNamespace
newJob = JobNamespace
-- | An interval or a limit the caller does not name is the timing's
-- jobPollMs or jobPollTimeoutMs.
data PollOptions = PollOptions { pollIntervalMs :: Maybe Integer, pollTimeoutMs :: Maybe Integer, pollProgress :: JobStatusResponse -> IO () }

queued :: JobNamespace -> (Stream (Of (Bus.Heard JobQueuedEvent)) IO () -> IO result) -> IO result
queued (JobNamespace _ bus _ _ _) = Local.events bus JobQueued NoScope
progress :: JobNamespace -> (Stream (Of (Bus.Heard JobReportProgressCommand)) IO () -> IO result) -> IO result
progress (JobNamespace _ bus _ _ _) = Local.events bus JobReportProgress NoScope
complete :: JobNamespace -> (Stream (Of (Bus.Heard JobCompleteCommand)) IO () -> IO result) -> IO result
complete (JobNamespace _ bus _ _ _) = Local.events bus Channel.JobComplete NoScope
fail :: JobNamespace -> (Stream (Of (Bus.Heard JobFailCommand)) IO () -> IO result) -> IO result
fail (JobNamespace _ bus _ _ _) = Local.events bus JobFail NoScope
status :: JobNamespace -> JobId -> IO JobStatusResponse
status namespace@(JobNamespace _ _ _ _ timing) identity = statusWithin namespace identity (Timing.busRequestTimeoutMs timing)
statusWithin :: JobNamespace -> JobId -> Integer -> IO JobStatusResponse
statusWithin (JobNamespace wire _ _ _ _) identity timeoutMs = jobStatusResultResponse <$>
  Bus.request wire JobStatusRequestedOperation (JobStatusRequest identity mempty) timeoutMs
-- | Asks at once, then every interval, and fails as timed out at the limit
-- from its first ask: an ask then in flight, or a wait, ends there.
pollUntilComplete :: JobNamespace -> JobId -> PollOptions -> IO JobStatusResponse
pollUntilComplete namespace@(JobNamespace _ _ _ clock timing) identity options = do
  let interval = fromMaybe (Timing.jobPollMs timing) (pollIntervalMs options)
      limit = fromMaybe (Timing.jobPollTimeoutMs timing) (pollTimeoutMs options)
  when (interval < 0 || limit < 0) (ioError (userError "negative job polling interval or timeout"))
  began <- Bus.requestNow clock
  let deadline = began + limit * 1000000
      loop = do
        now <- Bus.requestNow clock
        when (now >= deadline) (throwIO (BusRequestError BusRequestTimeout "job polling deadline expired" Nothing))
        value <- statusWithin namespace identity (min (Timing.busRequestTimeoutMs timing) ((deadline - now + 999999) `div` 1000000))
        pollProgress options value
        if terminal (jobStatusResponseStatus value) then pure value else do
          asked <- Bus.requestNow clock
          Bus.requestWaitUntil clock (min deadline (asked + interval * 1000000))
          loop
  loop
  where
    terminal JobStatusResponseStatusPending = False
    terminal JobStatusResponseStatusRunning = False
    terminal JobStatusResponseStatusComplete = True
    terminal JobStatusResponseStatusFailed = True
    terminal JobStatusResponseStatusCancelled = True
cancel :: JobNamespace -> JobId -> IO Bool
cancel (JobNamespace wire _ _ _ timing) identity = jobCancelResultCancelled . jobCancelResultBusEnvelopeResponse <$>
  Bus.request wire JobCancelRequestedOperation (JobCancelRequest identity mempty) (Timing.busRequestTimeoutMs timing)
claim :: JobNamespace -> Worker.WorkerOptions -> IO Worker.Claims
claim (JobNamespace _ _ carrier _ _) = Worker.newClaims carrier
