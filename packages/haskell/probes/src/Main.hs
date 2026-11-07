{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Capabilities (cryptoProbe, telemetryProbe, simulationProbe)
import Control.Concurrent.Async (async, cancel, poll, race, wait, waitCatch)
import Control.Concurrent.STM hiding (check)
import qualified Control.Concurrent.STM as STM
import Control.Exception (SomeAsyncException, SomeException, bracket, finally, fromException, try)
import Control.Monad (unless, void)
import Data.Aeson (Value(..), eitherDecodeStrict', object, (.=))
import qualified Data.Aeson.KeyMap as KeyMap
import qualified Data.ByteString.Char8 as Bytes
import Data.IORef (atomicModifyIORef', modifyIORef', newIORef, readIORef)
import Data.Text (Text)
import Network.HTTP.Client
import Network.HTTP.Client.TLS (tlsManagerSettings)
import NativeLock (withNativeLock, withWaitingLock)
import ProbeTypes
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream
import System.Environment (getArgs)
import System.Exit (exitFailure)
import System.IO (hFlush, stdout)

assert :: String -> Bool -> IO ()
assert label passed = unless passed (ioError (userError label))

check :: String -> IO () -> IO ()
check label action = action >> putStrLn ("PASS " ++ label)

data Slot = Absent | ExplicitNull | Supplied Value deriving (Eq, Show)

slot :: Value -> Either String Slot
slot (Object fields) = Right $ case KeyMap.lookup "example" fields of
  Nothing -> Absent
  Just Null -> ExplicitNull
  Just value -> Supplied value
slot _ = Left "expected object"

encodeSlot :: Slot -> Value
encodeSlot Absent = object []
encodeSlot ExplicitNull = object ["example" .= Null]
encodeSlot (Supplied value) = object ["example" .= value]

jsonProbe :: IO ()
jsonProbe = mapM_ roundTrip ["{}", "{\"example\":null}", "{\"example\":false}"]
  where
    roundTrip bytes = case eitherDecodeStrict' bytes >>= \value -> (,) value <$> slot value of
      Left reason -> ioError (userError reason)
      Right (value, decoded) -> assert "lost absence or explicit null" (encodeSlot decoded == value)

type Clock = (IO Integer, Integer -> IO ())

clockProbe :: IO ()
clockProbe = do
  now <- newTVarIO (0 :: Integer)
  entered <- newEmptyTMVarIO
  let clock :: Clock
      clock = (readTVarIO now, \due -> do
        atomically (putTMVar entered ())
        atomically (readTVar now >>= \time -> STM.check (time >= due)))
      waitUntil = snd clock
  waiter <- async (waitUntil 100)
  atomically (takeTMVar entered)
  atomically (writeTVar now 99)
  premature <- poll waiter
  assert "deadline ended early" (case premature of Nothing -> True; Just _ -> False)
  atomically (writeTVar now 100)
  wait waiter
  fst clock >>= assert "clock did not expose advanced time" . (== 100)
  blocked <- async (waitUntil 200)
  atomically (takeTMVar entered)
  cancel blocked
  result <- waitCatch blocked
  assert "cancelled wait did not retain cancellation" $ case result of
    Left exception -> case fromException exception :: Maybe SomeAsyncException of
      Just _ -> True
      Nothing -> False
    Right _ -> False

streamProbe :: IO ()
streamProbe = do
  taken <- newTVarIO False
  closed <- newIORef False
  let acquire = atomically $ do
        used <- readTVar taken
        if used then throwSTM (userError "second consumer") else writeTVar taken True
      reports :: Stream (Of Int) IO ()
      reports = Stream.each [1, 2, 3]
      consume action = bracket acquire (\() -> atomicModifyIORef' closed (\_ -> (True, ()))) (\() -> action reports)
  values <- consume (Stream.toList_ . Stream.take 1)
  assert "early reader lost its event" (values == [1])
  readIORef closed >>= assert "early stream exit leaked its resource"
  second <- try (consume Stream.effects) :: IO (Either SomeException ())
  assert "second consumer was accepted" (case second of Left _ -> True; Right _ -> False)
  final <- Stream.effects (Stream.yield (1 :: Int) >> pure ("complete" :: Text))
  assert "stream lost its terminal result" (final == "complete")

noticeProbe :: IO ()
noticeProbe = do
  source <- newTVarIO (0 :: Integer, Nothing :: Maybe Text)
  -- A revision lets equal notices wake a reader, while the mutable cell remains private.
  let notify value = atomically $ modifyTVar' source (\(revision, _) -> (revision + 1, value))
      next after = atomically $ do
        (revision, value) <- readTVar source
        STM.check (revision > after)
        pure (revision, value)
  notify (Just "same")
  (first, one) <- next 0
  notify (Just "same")
  (_, two) <- next first
  assert "equal notices were suppressed" (one == two && two == Just "same")

httpProbe :: String -> IO ()
httpProbe origin = do
  manager <- newManager (managerSetProxy noProxy tlsManagerSettings)
  base <- parseRequest (origin ++ "/body")
  let requestBodyOnly = base { responseTimeout = responseTimeoutMicro 2000000 }
  response <- httpLbs requestBodyOnly manager
  assert "manager request failed" (responseBody response == "body")
  streamRequest <- parseRequest (origin ++ "/stream")
  entered <- newEmptyTMVarIO
  released <- newEmptyTMVarIO
  reader <- async $ (withResponse streamRequest { responseTimeout = responseTimeoutNone } manager $ \responseStream -> do
    first <- brRead (responseBody responseStream)
    assert "stream did not give its first chunk" (not (Bytes.null first))
    atomically (putTMVar entered ())
    void (brRead (responseBody responseStream))) `finally` atomically (putTMVar released ())
  atomically (takeTMVar entered)
  cancel reader
  atomically (takeTMVar released)
  usable <- httpLbs requestBodyOnly manager
  assert "cancelling response closed caller manager" (responseBody usable == "body")
  headers <- parseRequest (origin ++ "/headers")
  timed <- try (httpLbs headers { responseTimeout = responseTimeoutMicro 100000 } manager)
  assert "headers did not honor their timeout" $ case timed of
    Left (HttpExceptionRequest _ ResponseTimeout) -> True
    Left _ -> False
    Right _ -> False
  stalled <- parseRequest (origin ++ "/stall")
  headersArrived <- newEmptyTMVarIO
  deadline <- newEmptyTMVarIO
  bounded <- async $ withResponse stalled { responseTimeout = responseTimeoutNone } manager $ \body -> do
    atomically (putTMVar headersArrived ())
    race (atomically (takeTMVar deadline)) (brRead (responseBody body))
  atomically (takeTMVar headersArrived)
  atomically (putTMVar deadline ())
  wait bounded >>= assert "caller deadline did not bound the body read" . (== Left ())
  upload <- parseRequest (origin ++ "/upload")
  opened <- newIORef (0 :: Int)
  let source give = do
        modifyIORef' opened (+ 1)
        chunks <- newIORef ["one", "two"]
        give (atomicModifyIORef' chunks (\values -> case values of
          [] -> ([], Bytes.empty)
          chunk : rest -> (rest, chunk)))
      replayable = upload { method = "POST", requestBody = RequestBodyStreamChunked source }
  mapM_ (\_ -> httpLbs replayable manager >>= assert "upload body was not replayed" . (== "onetwo") . responseBody) [1 :: Int, 2]
  readIORef opened >>= assert "upload source did not reopen" . (== 2)

retryProbe :: String -> IO ()
retryProbe origin = mapM_ exercise [("default", tlsManagerSettings), ("off", tlsManagerSettings { managerRetryableException = const False })]
  where
    exercise (name, settings) = do
      manager <- newManager (managerSetProxy noProxy settings)
      warm <- parseRequest (origin ++ "/body")
      void (httpLbs warm manager)
      dropped <- parseRequest (origin ++ "/drop-" ++ name)
      result <- try (void (httpLbs dropped { method = "POST" } manager)) :: IO (Either HttpException ())
      assert "dropped response unexpectedly succeeded" (case result of Left _ -> True; Right _ -> False)

main :: IO ()
main = do
  args <- getArgs
  case args of
    ["try-lock", path] -> withNativeLock path $ \held -> if held then putStrLn "held" else exitFailure
    ["hold-lock", path] -> withNativeLock path $ \held -> do
      assert "could not hold native lock" held
      putStrLn "held"
      hFlush stdout
      void getLine
    ["wait-lock", path] -> do
      let retryAfterCommand = putStrLn "waiting" >> hFlush stdout >> void getLine
      withWaitingLock retryAfterCommand path (putStrLn "held")
    ["cancel-lock", path] -> do
      entered <- newEmptyTMVarIO
      let blocked = atomically (putTMVar entered ()) >> atomically STM.retry
      waiter <- async (withWaitingLock blocked path (ioError (userError "contended lock acquired")))
      atomically (takeTMVar entered)
      cancel waiter
      outcome <- waitCatch waiter
      assert "native lock wait swallowed cancellation" $ case outcome of
        Left exception -> case fromException exception :: Maybe SomeAsyncException of
          Just _ -> True
          Nothing -> False
        Right _ -> False
      putStrLn "cancelled"
    [origin] -> do
      check "SHA-256, RSA signing, CSPRNG and Unicode offsets" cryptoProbe
      check "host telemetry, context across async and custom propagation" telemetryProbe
      check "io-sim clock advancement and deadline cancellation" simulationProbe
      check "explicit JSON absence and null" jsonProbe
      check "caller-controlled IO wait and cancellation" clockProbe
      check "scoped stream, single consumer, terminal result" streamProbe
      check "repeated equal state notices" noticeProbe
      check "HTTP response cancellation and manager ownership" (httpProbe origin)
      check "HTTP retry policy (server checks attempt counts)" (retryProbe origin)
      check "typed scope and operation" $ do
        value <- request RenderProbe 12
        assert "wrong response" (value == "12")
        case parseProbeId "probe" of
          Nothing -> ioError (userError "checked constructor refused valid input")
          Just identifier -> receive (InScope identifier) ScopedProbe >>= assert "wrong scoped value" . (== 1)
    _ -> ioError (userError "expected base URL or a lock probe command and PATH")
