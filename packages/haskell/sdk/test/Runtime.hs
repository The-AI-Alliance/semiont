{-# LANGUAGE OverloadedStrings #-}

module Runtime (runtimeCases) where

import Control.Concurrent.Async (async, cancel, wait, waitCatch)
import Control.Concurrent.STM
import Control.Exception (SomeAsyncException, IOException, finally, fromException, throwIO, try)
import Control.Monad (forM_, unless)
import qualified Data.ByteString as Bytes
import Data.List (mapAccumL)
import Data.Text.Encoding (encodeUtf8)
import qualified Semiont.Internal.Broadcast as Broadcast
import qualified Semiont.Internal.Running as Running
import Semiont.Internal.Sse
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

runtimeCases :: IO ()
runtimeCases = do
  sseCases
  outcome <- timeout 5000000 (broadcastCases >> runningCases)
  require "runtime liveness deadline expired" (outcome == Just ())
  putStrLn "PASS incremental SSE, ordered STM subscriptions and single-consumer operations"
