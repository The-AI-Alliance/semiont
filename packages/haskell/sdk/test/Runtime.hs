{-# LANGUAGE OverloadedStrings #-}

module Runtime (runtimeCases) where

import Control.Concurrent.Async (async, cancel, wait, waitCatch)
import Control.Concurrent.STM
import Control.Exception (Exception, SomeException, SomeAsyncException, AsyncException(UserInterrupt), IOException, finally, fromException, throwIO, try)
import Control.Monad (forM_, unless)
import qualified Data.ByteString as Bytes
import qualified Data.Aeson.KeyMap as KM
import Data.List (mapAccumL)
import Data.Text.Encoding (encodeUtf8)
import qualified Data.Set as Set
import qualified Semiont.Channels as Channels
import qualified Semiont.Internal.Broadcast as Broadcast
import qualified Semiont.Internal.Delivery as Delivery
import qualified Semiont.Internal.Running as Running
import qualified Semiont.Retry as Retry
import qualified Semiont.Timing as Timing
import Semiont.Internal.Sse
import Semiont.Types (BusFrame(..), BusFramePayload(..))
import System.Timeout (timeout)
import Streaming (Of(..))
import qualified Streaming.Prelude as Stream

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))

sseCases :: IO ()
sseCases = do
  let wire = encodeUtf8 "\xfeff:comment\r\nid: evt-1\revent: update\rdata: α\ndata: β\r\n\r\ndata: second\n\nretry: 0015\nretry: no\nid:\ndata:\n\nid: bad\0id\ndata: last\n\n"
      expected =
        [ Message (Event "update" (Just "evt-1") "evt-1" "α\nβ")
        , Message (Event "message" Nothing "evt-1" "second")
        , RetryAfterMs 15
        , Message (Event "message" (Just "") "" "")
        , Message (Event "message" Nothing "" "last")
        ]
      parse chunks = concat (snd (mapAccumL feed newParser chunks))
  forM_ [0 .. Bytes.length wire] $ \index ->
    require ("SSE split failed at byte " ++ show index) (parse [Bytes.take index wire, Bytes.drop index wire] == expected)
  require "SSE bytewise UTF-8 or CRLF parse failed" (parse (map Bytes.singleton (Bytes.unpack wire)) == expected)
  require "SSE ended a partial event at EOF" (null (parse ["data: incomplete\n"]))
  require "SSE removed more than one leading space" (parse ["data:  value\n\n"] == [Message (Event "message" Nothing "" " value")])
  require "SSE refused a field without a colon" (parse ["data\n\n"] == [Message (Event "message" Nothing "" "")])
  require "SSE did not replace malformed UTF-8" (parse [Bytes.pack [100,97,116,97,58,32,255,10,10]] == [Message (Event "message" Nothing "" "\xfffd")])

broadcastCases :: IO ()
broadcastCases = do
  scoped <- atomically Broadcast.newEvents
  escaped <- Broadcast.withSubscription scoped $ \reader -> do
    atomically (Broadcast.publish scoped (1 :: Int))
    pure reader
  abandoned <- atomically (Broadcast.next escaped)
  require "escaped subscription remained usable after scope exit" (abandoned == Nothing)
  bus <- atomically Broadcast.newEvents
  Broadcast.withSubscription bus $ \one -> Broadcast.withSubscription bus $ \two -> do
    atomically $ mapM_ (Broadcast.publish bus) [1 :: Int, 2]
    first <- atomically (sequence [Broadcast.next one, Broadcast.next one])
    second <- atomically (sequence [Broadcast.next two, Broadcast.next two])
    require "ordered readers lost or shared events" (first == [Just 1, Just 2] && first == second)
    ready <- newEmptyTMVarIO
    waiter <- async $ Broadcast.withSubscription bus $ \reader -> do
      atomically (putTMVar ready ())
      atomically (Broadcast.next reader)
    atomically (takeTMVar ready)
    cancel waiter
    outcome <- waitCatch waiter
    require "cancelled subscription swallowed its exception" $ case outcome of
      Left exception -> case fromException exception :: Maybe SomeAsyncException of Just _ -> True; Nothing -> False
      Right _ -> False
    atomically (Broadcast.publish bus 3 >> Broadcast.close bus >> Broadcast.close bus >> Broadcast.publish bus 4)
    final <- atomically (sequence [Broadcast.next one, Broadcast.next one, Broadcast.next two, Broadcast.next two])
    require "close lost queued events or accepted later publications" (final == [Just 3, Nothing, Just 3, Nothing])
  state <- atomically (Broadcast.newState ("initial" :: String))
  Broadcast.withSubscription state $ \reader -> do
    initial <- atomically (Broadcast.next reader)
    atomically (Broadcast.publish state "initial")
    repeated <- atomically (Broadcast.next reader)
    require "state subscription lost initial or equal notice" (initial == Just "initial" && repeated == initial)
  atomically (Broadcast.close state)
  Broadcast.withSubscription state $ \reader -> do
    final <- atomically (sequence [Broadcast.next reader, Broadcast.next reader])
    require "closed state did not replay its final observation" (final == [Just "initial", Nothing])
  waiting <- atomically Broadcast.newEvents
  started <- newEmptyTMVarIO
  reader <- async $ Broadcast.withSubscription waiting $ \subscription -> do
    atomically (putTMVar started ())
    atomically (Broadcast.next subscription)
  atomically (takeTMVar started >> Broadcast.close waiting)
  ended <- wait reader
  require "close did not wake a blocked reader" (ended == (Nothing :: Maybe Int))

runningCases :: IO ()
runningCases = do
  starts <- newTVarIO (0 :: Int)
  lazy <- Running.newRunning $ \report -> do
    atomically (modifyTVar' starts (+ 1))
    report (1 :: Int)
    report 2
    pure (3 :: Int)
  before <- readTVarIO starts
  require "constructing Running started its operation" (before == 0)
  result <- Running.withReports lazy Stream.toList
  require "reports or terminal result were lost or reordered" (result == ([1, 2] :> 3))
  twice <- try (Running.await lazy)
  require "a second consumption started the operation" (twice == Left Running.AlreadyConsumed)
  after <- readTVarIO starts
  require "Running started more than once" (after == 1)
  awaited <- Running.newRunning (\report -> report 'x' >> pure True)
  value <- Running.await awaited
  require "await did not return the terminal value" value
  failed <- Running.newRunning (\report -> report 'x' >> throwIO (userError "operation failed"))
  failure <- try (Running.withReports failed (\stream -> do
    first <- Stream.next stream
    case first of
      Right ('x', rest) -> Stream.effects rest
      _ -> ioError (userError "failure lost its prior report"))) :: IO (Either IOException ())
  require "producer failure was swallowed" $ case failure of Left exception -> show exception == "user error (operation failed)"; Right _ -> False
  entered <- newEmptyTMVarIO
  released <- newEmptyTMVarIO
  blocked <- Running.newRunning $ \report ->
    (report 'a' >> atomically (putTMVar entered ()) >> atomically retry)
      `finally` atomically (putTMVar released ())
  escaped <- Running.withReports blocked $ \stream -> do
    atomically (takeTMVar entered)
    pure stream
  joined <- atomically (tryTakeTMVar released)
  require "leaving report scope did not cancel and join the producer" (joined == Just ())
  ended <- try (Stream.effects escaped) :: IO (Either Running.ConsumptionError ())
  require "escaped reports remained usable" (ended == Left Running.ObservationEnded)
  ready <- newEmptyTMVarIO
  stopped <- newEmptyTMVarIO
  cancellable <- Running.newRunning $ \_ ->
    (atomically (putTMVar ready ()) >> atomically retry)
      `finally` atomically (putTMVar stopped ())
  consumer <- async (Running.await cancellable :: IO ())
  atomically (takeTMVar ready)
  duplicate <- try (Running.withReports cancellable Stream.effects)
  require "simultaneous consumer was not refused" (duplicate == Left Running.AlreadyConsumed)
  cancel consumer
  cancelled <- waitCatch consumer
  require "await swallowed consumer cancellation" $ case cancelled of
    Left exception -> case fromException exception :: Maybe SomeAsyncException of Just _ -> True; Nothing -> False
    Right _ -> False
  cleaned <- atomically (tryTakeTMVar stopped)
  require "await cancellation did not release producer resources" (cleaned == Just ())

deliveryCases :: IO ()
deliveryCases = do
  wire <- atomically Delivery.newHub
  local <- atomically Delivery.newHub
  replies <- atomically Delivery.newReplies
  let (_, resultChannel, failureChannel) = Channels.operationChannels Channels.FrameAddEntityTypeOperation
      resultName = Channels.channelName resultChannel
      replyChannels = Set.fromList [resultName, Channels.channelName failureChannel]
      reply = BusFrame resultName (Just "request-1") (BusFramePayload KM.empty) Nothing
      signal = reply { busFrameCorrelationId = Nothing }
  Delivery.withFrames wire resultName $ \wireFrames -> Delivery.withFrames local resultName $ \localFrames ->
    Delivery.withReply replies "request-1" replyChannels $ \pending -> do
      ids <- atomically (Delivery.awaited replies)
      require "tracked reply did not appear in the resumption snapshot" (ids == ["request-1"])
      conflict <- try (Delivery.withReply replies "request-1" replyChannels (const (pure ())))
      require "duplicate correlation replaced a pending request" (conflict == Left Delivery.CorrelationConflict)
      continuation <- async $ do
        frame <- atomically (Delivery.awaitReply pending)
        require "request received the wrong frame" (frame == Just reply)
        atomically (Delivery.publish local signal)
      atomically $ do
        Delivery.deliver [wire, local] replies reply
        Delivery.deliver [wire, local] replies (reply { busFrameChannel = Channels.channelName Channels.BeckonFocus })
      wait continuation
      atomically (Delivery.closeHub wire >> Delivery.closeHub local)
      seenWire <- atomically (sequence [Broadcast.next wireFrames, Broadcast.next wireFrames])
      seenLocal <- atomically (sequence [Broadcast.next localFrames, Broadcast.next localFrames, Broadcast.next localFrames])
      require "wire received a local signal" (seenWire == [Just reply, Nothing])
      require "request continuation overtook the raw reply" (seenLocal == [Just reply, Just signal, Nothing])
      idsAfter <- atomically (Delivery.awaited replies)
      require "settled reply remained tracked" (null idsAfter)
  Delivery.withReply replies "wrong-channel" replyChannels $ \pending -> do
    atomically (Delivery.deliver [] replies (reply { busFrameCorrelationId = Just "wrong-channel", busFrameChannel = Channels.channelName Channels.BeckonFocus }))
    unanswered <- atomically ((Just <$> Delivery.awaitReply pending) `orElse` pure Nothing)
    require "an unrelated channel settled a request" (unanswered == Nothing)
  abandoned <- atomically (Delivery.awaited replies)
  require "scope exit retained a pending request" (null abandoned)
  ready <- newEmptyTMVarIO
  waiter <- async $ Delivery.withReply replies "cancelled" replyChannels $ \pending -> do
    atomically (putTMVar ready ())
    atomically (Delivery.awaitReply pending)
  atomically (takeTMVar ready)
  cancel waiter
  afterCancel <- atomically (Delivery.awaited replies)
  require "cancelled request remained tracked" (null afterCancel)
  Delivery.withReply replies "closed" replyChannels $ \pending -> do
    atomically (Delivery.closeReplies replies >> Delivery.closeReplies replies)
    outcome <- atomically (Delivery.awaitReply pending)
    require "closing replies left a request waiting" (outcome == Nothing)
  Delivery.withReply replies "late" replyChannels $ \pending -> do
    outcome <- atomically (Delivery.awaitReply pending)
    require "a request tracked after close did not end" (outcome == Nothing)
  Delivery.withFrames local resultName $ \reader -> do
    outcome <- atomically (Broadcast.next reader)
    require "a reader attached to a closed hub did not end" (outcome == Nothing)

data RetryProbeFailure = RetryProbeFailure deriving (Eq, Show)
instance Exception RetryProbeFailure

retryRuntimeCases :: IO ()
retryRuntimeCases = do
  clock <- newTVarIO 0
  waits <- newTQueueIO
  attempts <- newTVarIO (0 :: Integer)
  let budget = Timing.emitRetry
      options = Retry.RetryOptions
        { Retry.retryNow = readTVarIO clock
        , Retry.retryWaitUntil = \deadline -> do
            atomically (writeTQueue waits deadline)
            atomically (readTVar clock >>= check . (>= deadline))
        , Retry.retryRandom = pure 0
        }
      accepts :: RetryProbeFailure -> Bool
      accepts _ = True
      action = atomically (modifyTVar' attempts (+ 1)) >> throwIO RetryProbeFailure
  working <- async (try (Retry.retryWithBackoff options budget accepts (const Nothing) action) :: IO (Either RetryProbeFailure ()))
  let checkWait made cap = do
        before <- readTVarIO clock
        deadline <- atomically (readTQueue waits)
        require "retry ignored supplied jitter or absolute clock" (deadline == before + cap * 500000)
        atomically (writeTVar clock (deadline - 1))
        counted <- readTVarIO attempts
        require "retry ran before its caller-controlled deadline" (counted == made)
        atomically (writeTVar clock deadline)
        if made + 1 >= Timing.retryAttempts budget then pure () else
          checkWait (made + 1) (min (Timing.retryMaxDelayMs budget) (cap * 2))
  checkWait 1 (Timing.retryInitialDelayMs budget)
  exhausted <- wait working
  counted <- readTVarIO attempts
  require "retry lost the last failure or exceeded its budget" (exhausted == Left RetryProbeFailure && counted == Timing.retryAttempts budget)
  atomically (writeTVar attempts 0)
  let advancing = options { Retry.retryWaitUntil = \deadline -> atomically (writeTQueue waits deadline >> writeTVar clock deadline) }
  beforeStated <- readTVarIO clock
  answer <- Retry.retryWithBackoff advancing budget accepts (const (Just 5000)) $ do
    made <- atomically (modifyTVar' attempts (+ 1) >> readTVar attempts)
    if made == 1 then throwIO RetryProbeFailure else pure True
  statedDeadline <- atomically (readTQueue waits)
  require "Retry-After did not take precedence over jitter" (answer && statedDeadline == beforeStated + 5000 * 1000000)
  atomically (writeTVar attempts 0)
  let acceptsAny :: SomeException -> Bool
      acceptsAny _ = True
  interrupted <- try (Retry.retryWithBackoff advancing budget acceptsAny (const Nothing)
    (atomically (modifyTVar' attempts (+ 1)) >> throwIO UserInterrupt)) :: IO (Either AsyncException ())
  countedInterrupt <- readTVarIO attempts
  require "retry treated an asynchronous exception as a request failure" (interrupted == Left UserInterrupt && countedInterrupt == 1)
  ready <- newEmptyTMVarIO
  let parked = options { Retry.retryWaitUntil = \_ -> atomically (putTMVar ready ()) >> atomically retry }
  cancelled <- async (Retry.retryWithBackoff parked budget accepts (const Nothing) action :: IO ())
  atomically (takeTMVar ready)
  cancel cancelled
  cancelledOutcome <- waitCatch cancelled
  require "retry swallowed cancellation of its wait" $ case cancelledOutcome of
    Left exception -> case fromException exception :: Maybe SomeAsyncException of Just _ -> True; Nothing -> False
    Right _ -> False
  invalid <- try (Retry.retryWithBackoff options (budget { Timing.retryAttempts = 0 }) accepts (const Nothing) action) :: IO (Either Retry.RetryConfigurationError ())
  require "invalid retry budget was accepted" (invalid == Left Retry.InvalidRetryBudget)

runtimeCases :: IO ()
runtimeCases = do
  sseCases
  outcome <- timeout 5000000 (broadcastCases >> runningCases >> deliveryCases >> retryRuntimeCases)
  require "runtime liveness deadline expired" (outcome == Just ())
  putStrLn "PASS SSE, subscriptions, operation ownership, atomic reply delivery and controlled retry waits"
