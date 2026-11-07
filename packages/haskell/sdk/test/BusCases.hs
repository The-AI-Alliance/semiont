{-# LANGUAGE OverloadedStrings #-}

module BusCases (busCases) where

import Control.Concurrent.Async (async, cancel, wait)
import Control.Concurrent.STM
import Control.Exception (AsyncException(UserInterrupt), bracket, finally, throwIO, try)
import Control.Monad (unless)
import Data.Aeson (Value(..), toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.Set as Set
import qualified Data.Text as Text
import qualified OpenTelemetry.Context as Context
import OpenTelemetry.Context.ThreadLocal (getContext, attachContext, detachContext)
import qualified Semiont.Internal.Running as Running
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors
import qualified Semiont.EventBus as Local
import qualified Semiont.StateValue as State
import qualified Semiont.Timing as Timing
import qualified Semiont.Transport as Transport
import Semiont.Transport.Facts (traceField, userField)
import Semiont.Types
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream
import System.Timeout (timeout)

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))

body :: Value -> BusFramePayload
body (Object fields) = BusFramePayload fields
body _ = error "test payload is not an object"

ready :: Transport.TransportInput -> IO ()
ready input = Transport.setState input Transport.Connecting >> Transport.setState input Transport.Open

-- The failure report's first observation is a marker reported after a request settled, so the
-- request's refusal was never published to it.
unreported :: Transport.TransportInput -> Stream (Of TransportError) IO () -> IO ()
unreported input observations = do
  let marker = TransportError Code.TransportError "reported after the request settled" Nothing Nothing
  Transport.reportError input marker
  noticed <- Stream.toList_ (Stream.take 1 observations)
  require "a refused reply was published to the transport's failure report" (noticed == [marker])

rig :: (BusFrame -> IO (Maybe Integer)) -> IO () -> (Transport.Transport -> Transport.TransportInput -> IO result) -> IO result
rig send shutdown action = bracket
  (Transport.newTransport (Transport.TransportOptions "local://haskell" (Set.fromList channelNames) send shutdown))
  (Transport.dispose . fst) (uncurry action)

requestOptions :: TVar Integer -> TQueue Integer -> IO Bus.BusOptions
requestOptions clock waits = do
  ids <- newTVarIO (0 :: Integer)
  pure Bus.BusOptions
    { Bus.requestNow = readTVarIO clock
    , Bus.requestWaitUntil = \deadline -> do
        atomically (writeTQueue waits deadline)
        atomically (readTVar clock >>= check . (>= deadline))
    , Bus.nextCorrelationId = atomically $ do
        modifyTVar' ids (+ 1)
        number <- readTVar ids
        pure ("request-" <> Text.pack (show number))
    }

busCases :: FrameAddEntityTypeCommand -> BrowseResourceRequest -> Value -> [(Maybe Text.Text, Code.BusRequestCode)] -> IO ()
busCases command browse event failureRows = do
  result <- timeout 10000000 (requests command >> requestFailures command browse failureRows >> scopesAndFrames event >> lifecycle >> contextCases command)
  require "typed bus liveness deadline expired" (result == Just ())
  putStrLn "PASS typed bus attachment, correlation, deadlines, scopes, identity, traces and disposal"

requestFailures :: FrameAddEntityTypeCommand -> BrowseResourceRequest -> [(Maybe Text.Text, Code.BusRequestCode)] -> IO ()
requestFailures command browse failureRows = do
  let operation = FrameAddEntityTypeOperation
      (_, _, failure) = operationChannels operation
  mapM_ (\(stated, expected) -> do
    inputCell <- newEmptyTMVarIO
    let payload = KM.fromList (("message", String "peer refused") : ("details", String "preserved")
          : maybe [] (\code -> [("code", String code)]) stated)
        send frame = do
          input <- atomically (readTMVar inputCell)
          Transport.receive input (BusFrame (channelName failure) (busFrameCorrelationId frame) (BusFramePayload payload) Nothing)
          pure Nothing
    rig send (pure ()) $ \transport input -> do
      atomically (putTMVar inputCell input)
      ready input
      clock <- newTVarIO 0
      waits <- newTQueueIO
      options <- requestOptions clock waits
      outcome <- try (Bus.request (Bus.newBus options transport) operation command Timing.busRequestTimeoutMs) :: IO (Either BusRequestError EmptyBusPayload)
      case outcome of
        Left problem -> require "peer failure lost its code, words or original payload"
          (busRequestErrorCode problem == expected && busRequestErrorMessage problem == "peer refused" && busRequestFailure problem == Just payload)
        Right _ -> ioError (userError "failure reply became a successful result")) failureRows
  -- A failure that is not its channel's is refused, naming its first fault, and is never given words.
  -- It is told to the request awaiting it, and the transport's failure report carries nothing.
  mapM_ (\(payload, said) -> do
    inputCell <- newEmptyTMVarIO
    let send frame = do
          input <- atomically (readTMVar inputCell)
          Transport.receive input (BusFrame (channelName failure) (busFrameCorrelationId frame) (BusFramePayload payload) Nothing)
          pure Nothing
    rig send (pure ()) $ \transport input -> do
      atomically (putTMVar inputCell input)
      ready input
      clock <- newTVarIO 0
      waits <- newTQueueIO
      options <- requestOptions clock waits
      Transport.errors transport $ \observations -> do
        outcome <- try (Bus.request (Bus.newBus options transport) operation command Timing.busRequestTimeoutMs) :: IO (Either TransportError EmptyBusPayload)
        case outcome of
          Left problem -> require ("a failure that is not its channel's was not refused as " ++ Text.unpack said)
            (transportErrorCode problem == Code.TransportError
              && transportErrorMessage problem == "a payload on " <> channelName failure <> " is not that channel's: " <> said)
          Right _ -> ioError (userError "a failure that is not its channel's became a successful result")
        unreported input observations)
    [ (KM.empty, "it has no `message`")
    , (KM.fromList [("code", String "not-found")], "it has no `message`")
    , (KM.fromList [("message", String "peer refused"), ("code", Number 7)], "its `code` is malformed") ]
  -- A malformed result is an error at the typed boundary, told to the request awaiting it alone.
  inputCell <- newEmptyTMVarIO
  let (_, result, _) = operationChannels BrowseResourceRequestedOperation
      send frame = do
        input <- atomically (readTMVar inputCell)
        Transport.receive input (BusFrame (channelName result) (busFrameCorrelationId frame) (BusFramePayload KM.empty) Nothing)
        pure Nothing
  rig send (pure ()) $ \transport input -> do
    atomically (putTMVar inputCell input)
    ready input
    clock <- newTVarIO 0
    waits <- newTQueueIO
    options <- requestOptions clock waits
    Transport.errors transport $ \observations -> do
      outcome <- try (Bus.request (Bus.newBus options transport) BrowseResourceRequestedOperation browse Timing.busRequestTimeoutMs) :: IO (Either TransportError BrowseResourceResult)
      case outcome of
        Left problem -> require "malformed result did not name its missing member" (transportErrorCode problem == Code.TransportError && Text.isInfixOf "it has no `response`" (transportErrorMessage problem))
        Right _ -> ioError (userError "malformed result was accepted")
      unreported input observations
  bracket (Transport.newTransport (Transport.TransportOptions "local://unsubscribed" Set.empty
    (const (ioError (userError "unsubscribed request emitted"))) (pure ())))
    (Transport.dispose . fst) $ \(transport, _) -> do
      clock <- newTVarIO 0
      waits <- newTQueueIO
      options <- requestOptions clock waits
      outcome <- try (Bus.request (Bus.newBus options transport) operation command Timing.busRequestTimeoutMs) :: IO (Either BusRequestError EmptyBusPayload)
      require "unsubscribed request waited or emitted" (fmap busRequestErrorCode (either Just (const Nothing) outcome) == Just Code.BusRequestUnsubscribed)
  rig (const (ioError (userError "invalid-correlation request emitted"))) (pure ()) $ \transport input -> do
    ready input
    clock <- newTVarIO 0
    waits <- newTQueueIO
    options <- requestOptions clock waits
    let invalid = options { Bus.nextCorrelationId = pure "" }
    outcome <- try (Bus.request (Bus.newBus invalid transport) operation command Timing.busRequestTimeoutMs) :: IO (Either TransportError EmptyBusPayload)
    require "invalid correlation was not refused" (fmap transportErrorCode (either Just (const Nothing) outcome) == Just Code.TransportError)
    (_, _, pending, _) <- atomically (Transport.subscriptions input)
    require "invalid correlation entered the retention snapshot" (null pending)
  sent <- newEmptyTMVarIO
  rig (\_ -> atomically (putTMVar sent ()) >> pure Nothing) (pure ()) $ \transport input -> do
    ready input
    clock <- newTVarIO 0
    waits <- newTQueueIO
    options <- requestOptions clock waits
    let repeated = options { Bus.nextCorrelationId = pure "same-correlation" }
        bus = Bus.newBus repeated transport
    first <- async (Bus.request bus operation command Timing.busRequestTimeoutMs)
    atomically (takeTMVar sent)
    second <- try (Bus.request bus operation command Timing.busRequestTimeoutMs) :: IO (Either TransportError EmptyBusPayload)
    require "duplicate correlation replaced a live request" (fmap transportErrorCode (either Just (const Nothing) second) == Just Code.TransportConflict)
    (_, _, pending, _) <- atomically (Transport.subscriptions input)
    require "duplicate refusal forgot the first request" (pending == ["same-correlation"])
    cancel first
    (_, _, after, _) <- atomically (Transport.subscriptions input)
    require "cancelled duplicate-test request remained retained" (null after)

requests :: FrameAddEntityTypeCommand -> IO ()
requests command = do
  clock <- newTVarIO 0
  waits <- newTQueueIO
  options <- requestOptions clock waits
  inputCell <- newEmptyTMVarIO
  emitted <- newTQueueIO
  let operation = FrameAddEntityTypeOperation
      (_, result, _) = operationChannels operation
      resultName = channelName result
      reply frame payload = BusFrame resultName (busFrameCorrelationId frame) (body payload) Nothing
      send frame = do
        input <- atomically (readTMVar inputCell)
        (_, _, pending, _) <- atomically (Transport.subscriptions input)
        require "request was sent before its reply was tracked" (maybe False (`elem` pending) (busFrameCorrelationId frame))
        atomically (writeTQueue emitted frame)
        Transport.receive input (reply frame (encodePayload result EmptyBusPayload))
        pure (Just 1)
  rig send (pure ()) $ \transport input -> do
    atomically (putTMVar inputCell input)
    local <- Local.newEventBus
    releaseOne <- Transport.bridgeInto transport local
    releaseTwo <- Transport.bridgeInto transport local
    let bus = Bus.newBus options transport
    Local.events local resultName $ \observations -> do
      worker <- async $ do
        value <- Bus.request bus operation command Timing.busRequestTimeoutMs
        Local.local local (Transport.Frame (BusFrame resultName Nothing (body (toJSON value)) Nothing) Nothing)
        pure value
      deadline <- atomically (readTQueue waits)
      require "request deadline did not use the caller's time" (deadline == Timing.busRequestTimeoutMs * 1000000)
      before <- atomically (tryReadTQueue emitted)
      require "request emitted before the stream opened" (before == Nothing)
      ready input
      answer <- wait worker
      seen <- Stream.toList_ (Stream.take 2 observations)
      require "typed request returned the wrong result" (answer == EmptyBusPayload)
      require "a duplicate bridge duplicated a raw frame, or the continuation overtook it"
        (map Transport.carriedCorrelationId seen == [Just "request-1", Nothing])
      (_, _, pending, _) <- atomically (Transport.subscriptions input)
      require "settled request remained tracked" (null pending)
    releaseOne >> releaseOne >> releaseTwo
    Local.closeEventBus local
  firstEmits <- atomically (flushTQueue emitted)
  require "request emitted more than once" (length firstEmits == 1)
  -- Cancellation while attachment is pending leaves no later emit.
  sent <- newTVarIO (0 :: Int)
  rig (\_ -> atomically (modifyTVar' sent (+ 1)) >> pure Nothing) (pure ()) $ \transport input -> do
    busOptions <- requestOptions clock waits
    let bus = Bus.newBus busOptions transport
    worker <- async (Bus.request bus operation command Timing.busRequestTimeoutMs)
    _ <- atomically (readTQueue waits)
    cancel worker
    ready input
    count <- readTVarIO sent
    require "abandoned request emitted after attachment" (count == 0)
  -- The same deadline includes waiting for attachment.
  atomically (writeTVar clock 0)
  rig (\_ -> atomically (modifyTVar' sent (+ 1)) >> pure Nothing) (pure ()) $ \transport input -> do
    busOptions <- requestOptions clock waits
    let bus = Bus.newBus busOptions transport
    worker <- async (try (Bus.request bus operation command Timing.busRequestTimeoutMs) :: IO (Either BusRequestError EmptyBusPayload))
    deadline <- atomically (readTQueue waits)
    atomically (writeTVar clock deadline)
    outcome <- wait worker
    require "attachment did not expire at the request deadline" (fmap busRequestErrorCode (either Just (const Nothing) outcome) == Just Code.BusRequestTimeout)
    ready input
    count <- readTVarIO sent
    require "timed-out request emitted after attachment" (count == 0)
  -- Timeout after send releases the retention hold; it is one emit, with no retry.
  atomically (writeTVar clock 0)
  rig (\frame -> atomically (writeTQueue emitted frame) >> pure Nothing) (pure ()) $ \transport input -> do
    ready input
    busOptions <- requestOptions clock waits
    let bus = Bus.newBus busOptions transport
    worker <- async (try (Bus.request bus operation command Timing.busRequestTimeoutMs) :: IO (Either BusRequestError EmptyBusPayload))
    _ <- atomically (readTQueue emitted)
    deadline <- atomically (readTQueue waits)
    atomically (writeTVar clock (deadline - 1))
    (_, _, pending, _) <- atomically (Transport.subscriptions input)
    require "request released tracking before its deadline" (pending == ["request-1"])
    atomically (writeTVar clock deadline)
    outcome <- wait worker
    require "sent request did not time out" (fmap busRequestErrorCode (either Just (const Nothing) outcome) == Just Code.BusRequestTimeout)
    (_, _, after, _) <- atomically (Transport.subscriptions input)
    require "timed-out request retained its correlation" (null after)
  -- Closing during a blocked emit cancels that emit and reports closed.
  atomically (writeTVar clock 0)
  entered <- newEmptyTMVarIO
  released <- newEmptyTMVarIO
  rig (\_ -> (atomically (putTMVar entered ()) >> atomically retry) `finally` atomically (putTMVar released ())) (pure ()) $ \transport input -> do
    ready input
    busOptions <- requestOptions clock waits
    worker <- async (try (Bus.request (Bus.newBus busOptions transport) operation command Timing.busRequestTimeoutMs) :: IO (Either BusRequestError EmptyBusPayload))
    atomically (takeTMVar entered)
    Transport.dispose transport
    outcome <- wait worker
    require "closing during emit did not report closed" (fmap busRequestErrorCode (either Just (const Nothing) outcome) == Just Code.BusRequestClosed)
    cleanup <- atomically (tryTakeTMVar released)
    require "closing left the request's emit running" (cleanup == Just ())

scopesAndFrames :: Value -> IO ()
scopesAndFrames event = rig (const (pure Nothing)) (pure ()) $ \transport input -> do
  clock <- newTVarIO 0
  waits <- newTQueueIO
  options <- requestOptions clock waits
  resource <- either (ioError . userError) pure (mkResourceId "scope-one")
  other <- either (ioError . userError) pure (mkResourceId "scope-two")
  user <- either (ioError . userError) pure (mkUserId "did:web:example.org:users:alice")
  let carrier = TraceCarrier "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" (Just "vendor=one")
      payload = case event of Object fields -> Object (KM.insert (Key.fromText userField) (toJSON user) (KM.insert (Key.fromText traceField) (toJSON carrier) fields)); _ -> error "event fixture is not an object"
      frame scope value = BusFrame (channelName MarkAdded) Nothing (body value) (Just scope)
      bus = Bus.newBus options transport
  one <- Transport.subscribeToResource transport resource
  two <- Transport.subscribeToResource transport resource
  different <- Transport.subscribeToResource transport other
  one >> one
  (_, held, _, _) <- atomically (Transport.subscriptions input)
  require "scope references did not compose" (Set.fromList held == Set.fromList [resource, other])
  two >> different
  Bus.frames bus MarkAdded (InScope resource) $ \values -> do
    (_, attached, _, _) <- atomically (Transport.subscriptions input)
    require "typed observation did not hold its scope" (attached == [resource])
    Transport.receive input (frame other payload)
    Transport.receive input (frame resource (Object KM.empty))
    Transport.receive input (frame resource payload)
    seen <- Stream.toList_ (Stream.take 2 values)
    case seen of
      [Bus.Refused refusal, Bus.Heard delivered] -> do
        require "missing member refusal lost its path" (Bus.reason (Bus.fault refusal) == Bus.Lacks && Bus.member (Bus.fault refusal) /= "")
        require "frame lost its authenticated emitter" (Bus.emittedBy delivered == Just user)
        require "frame lost its trace carrier" (Transport.frameTrace (Bus.deliveredFrame delivered) == Just carrier)
        let raw = busFramePayloadAdditionalProperties (busFramePayload (Transport.wireFrame (Bus.deliveredFrame delivered)))
        require "trace metadata remained in the delivered payload" (not (KM.member (Key.fromText traceField) raw))
      _ -> ioError (userError "typed frame refusal stopped the stream or lost order")
  (_, attachedAfter, _, _) <- atomically (Transport.subscriptions input)
  require "typed observation leaked its scope" (null attachedAfter)
  interrupted <- try (Bus.frames bus MarkAdded (InScope resource) (const (throwIO UserInterrupt))) :: IO (Either AsyncException ())
  require "scope swallowed caller cancellation" (interrupted == Left UserInterrupt)
  (_, attachedCancelled, _, _) <- atomically (Transport.subscriptions input)
  require "cancelled observation leaked a scope" (null attachedCancelled)

lifecycle :: IO ()
lifecycle = do
  closed <- newTVarIO (0 :: Int)
  rig (const (pure Nothing)) (atomically (modifyTVar' closed (+ 1))) $ \transport input -> do
    observations <- State.watch (Transport.state transport) $ \values -> do
      ready input
      Stream.toList_ (Stream.take 3 values)
    require "state watcher lost its initial value or ordering" (observations == [Transport.Initial, Transport.Connecting, Transport.Open])
    handover <- State.watch (Transport.state transport) $ \values -> do
      Transport.setState input Transport.Open
      Transport.setState input Transport.Reconnecting
      Stream.toList_ (Stream.take 2 values)
    require "an unchanged stream advertised a false reopen" (handover == [Transport.Open, Transport.Reconnecting])
    Transport.setState input Transport.Connecting >> Transport.setState input Transport.Open
    ended <- newEmptyTMVarIO
    release <- Transport.on transport (channelName BeckonFocus) (\_ -> atomically (putTMVar ended ()) >> Transport.dispose transport)
    Transport.receive input (BusFrame (channelName BeckonFocus) Nothing (BusFramePayload KM.empty) Nothing)
    atomically (takeTMVar ended)
    Transport.dispose transport
    release >> release
    count <- readTVarIO closed
    require "owned callback disposal deadlocked or closed more than once" (count == 1)
    final <- atomically (State.current (Transport.state transport))
    require "closed state was not retained" (final == Transport.Closed)
    replay <- State.watch (Transport.state transport) Stream.toList_
    require "closed state observation did not complete" (replay == [Transport.Closed])
  -- Cancelling one close waiter does not abandon the transport's teardown.
  entered <- newEmptyTMVarIO
  finish <- newEmptyTMVarIO
  shutdowns <- newTVarIO (0 :: Int)
  rig (const (pure Nothing))
    (atomically (modifyTVar' shutdowns (+ 1) >> putTMVar entered ()) >> atomically (takeTMVar finish)) $ \transport _ -> do
      first <- async (Transport.dispose transport)
      atomically (takeTMVar entered)
      cancel first
      second <- async (Transport.dispose transport)
      atomically (putTMVar finish ())
      wait second
      count <- readTVarIO shutdowns
      require "close waiter cancellation abandoned or repeated driver teardown" (count == 1)
  -- A driver's own close callback can close its handle without joining itself.
  transportCell <- newEmptyTMVarIO
  rig (const (pure Nothing)) (atomically (readTMVar transportCell) >>= Transport.dispose) $ \transport _ -> do
    atomically (putTMVar transportCell transport)
    Transport.dispose transport
  -- Closing is observable before teardown finishes; a producer racing that
  -- teardown must not publish another failure into the still-open queue.
  shuttingDown <- newEmptyTMVarIO
  finishClose <- newEmptyTMVarIO
  rig (const (pure Nothing))
    (atomically (putTMVar shuttingDown ()) >> atomically (takeTMVar finishClose)) $ \transport input ->
      Transport.errors transport $ \observations -> do
        closer <- async (Transport.dispose transport)
        atomically (takeTMVar shuttingDown)
        Transport.reportError input (TransportError Code.TransportError "late producer failure" Nothing Nothing)
        atomically (putTMVar finishClose ())
        wait closer
        noticed <- Stream.toList_ observations
        require "a closing transport published a late producer failure" (null noticed)

contextCases :: FrameAddEntityTypeCommand -> IO ()
contextCases command = do
  key <- Context.newKey "sdk.context.case" :: IO (Context.Key Text.Text)
  outside <- getContext
  bracket (attachContext (Context.insert key "caller" outside)) detachContext $ \_ -> do
    let inherited = do
          context <- getContext
          require "SDK-owned async work lost its caller context" (Context.lookup key context == Just "caller")
    running <- Running.newRunning $ \report -> inherited >> report () >> pure ()
    Running.withReports running Stream.effects
    inputCell <- newEmptyTMVarIO
    let (_, result, _) = operationChannels FrameAddEntityTypeOperation
        send frame = do
          inherited
          input <- atomically (readTMVar inputCell)
          Transport.receive input (BusFrame (channelName result) (busFrameCorrelationId frame) (body (toJSON EmptyBusPayload)) Nothing)
          pure Nothing
    rig send inherited $ \transport input -> do
      atomically (putTMVar inputCell input)
      ready input
      clock <- newTVarIO 0
      waits <- newTQueueIO
      options <- requestOptions clock waits
      _ <- Bus.request (Bus.newBus options transport) FrameAddEntityTypeOperation command Timing.busRequestTimeoutMs
      heard <- newEmptyTMVarIO
      release <- Transport.on transport (channelName BeckonFocus) (\_ -> inherited >> atomically (putTMVar heard ()))
      Transport.receive input (BusFrame (channelName BeckonFocus) Nothing (BusFramePayload KM.empty) Nothing)
      atomically (takeTMVar heard)
      release
  after <- getContext
  require "SDK operation changed its caller context" (Context.lookup key after == Context.lookup key outside)
