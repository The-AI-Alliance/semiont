{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module ClockCases (clockCasesFor, Scenario(..), cacheClockCases, httpClockCases, discoveryClockCases) where

import Control.Concurrent.Async (async, cancel)
import Control.Concurrent.STM
import Control.Exception (SomeException, bracket, finally, try)
import Control.Monad (forM_, unless, when)
import Data.Aeson (Value(..), eitherDecodeStrict', toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Char8 as Char8
import Data.Foldable (toList)
import Data.IORef
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8)
import qualified Data.UUID.Types as UUID
import qualified Data.Set as Set
import Network.HTTP.Client (defaultManagerSettings, managerRawConnection, noProxy)
import Network.HTTP.Client.Internal (makeConnection)
import qualified Semiont.Cache as Cache
import qualified Semiont.Channels as Channel
import qualified Semiont.Discovery as Discovery
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Http as Http
import qualified Semiont.Http.Routes as Route
import qualified Semiont.Retry as Retry
import qualified Semiont.StateValue as State
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types
import qualified Streaming.Prelude as Stream
import System.FilePath ((</>))
import System.Timeout (timeout)
import qualified ControlledTime as Time

data Scenario = Scenario { act :: IO (), counted :: IO Integer, close :: IO () }

member :: Text -> Value -> Value
member name (Object fields) = maybe (error ("missing clock case member " ++ Text.unpack name)) id (KM.lookup (Key.fromText name) fields)
member _ _ = error "clock case is not an object"
array :: Value -> [Value]
array (Array values) = toList values
array _ = error "clock case list is not an array"
number :: Value -> Rational
number (Number value) = toRational value
number _ = error "clock case number is not a number"

clockCasesFor :: FilePath -> [Text] -> (Time.ControlledTime -> Value -> IO Scenario) -> IO ()
clockCasesFor root subjects make = do
  table <- Bytes.readFile (root </> "protocol/specs/src/client/clock-cases.json")
    >>= either (ioError . userError) pure . eitherDecodeStrict'
  let cases = [row | row <- array (member "cases" table), String subject <- [member "subject" row], subject `elem` subjects]
      settings = toJSON Timing.protocolSettings
      duration (Object fields) =
        let name = case KM.lookup "timing" fields of Just (String text) -> text; _ -> error "clock duration names no timing"
            timing = foldl (flip member) settings (Text.splitOn "." name)
            stated key fallback = maybe fallback number (KM.lookup key fields)
        in number timing * stated "times" 1 + stated "plusMs" 0
      duration value = number value
  unless (all (\subject -> any ((== String subject) . member "subject") cases) subjects)
    (ioError (userError "a controlled-clock subject has no authority cases"))
  forM_ cases $ \row -> do
    outcome <- timeout 10000000 $ do
      clock <- Time.newTime
      bracket (make clock row) close $ \scenario -> do
        Time.settle
        forM_ (array (member "steps" row)) $ \step -> do
          case step of
            String "act" -> act scenario
            String "settle" -> pure ()
            Object fields | Just passed <- KM.lookup "pass" fields -> Time.advance clock (round (duration passed * 1000000))
            Object fields | Just count <- KM.lookup "counted" fields -> do
              Time.settle
              actual <- counted scenario
              unless (toRational actual == number count) (ioError (userError
                ("controlled clock mismatch: " ++ show row ++ "; expected " ++ show count ++ ", got " ++ show actual)))
            _ -> ioError (userError ("unhandled controlled clock step: " ++ show step))
          Time.settle
    unless (outcome == Just ()) (ioError (userError ("controlled clock subject did not settle: " ++ show row)))
  putStrLn ("PASS shared clock cases: " ++ show subjects)

-- An in-memory HTTP connection holds real http-client requests and responses.
-- Time, including the open-headers deadline, belongs to the public HttpOptions.
httpClockCases :: FilePath -> IO ()
httpClockCases root = clockCasesFor root
  ["refusedStream", "unansweredStream", "degradedStream", "scopeTaken", "scopeLetGo", "handoffLinger", "unansweredRequest", "unansweredEmit"] $ \clock row -> do
    let subject = case member "subject" row of String name -> name; _ -> error "subject has no name"
        given = case row of
          Object fields -> case KM.lookup "given" fields of
            Just (Object values) -> values
            Nothing -> KM.empty
            _ -> error "invalid clock given"
          _ -> error "invalid clock case"
    asks <- newTVarIO 0
    closed <- newTVarIO 0
    degraded <- newTVarIO 0
    failures <- newTVarIO 0
    ids <- newTVarIO 0
    let fresh = atomically $ do
          modifyTVar' ids (+1)
          value <- readTVar ids
          pure (UUID.fromWords 0 0 0 (fromInteger value))
        requestStart route = Route.routeMethod route <> " " <> encodeUtf8 (Route.routePath route) <> " "
        connect _ _ _ = do
          seen <- newIORef Bytes.empty
          assigned <- newIORef False
          output <- newTQueueIO
          stopped <- newTVarIO False
          let readBytes = atomically (readTQueue output `orElse` (readTVar stopped >>= check >> pure Bytes.empty))
              writeBytes bytes = do
                accumulated <- atomicModifyIORef' seen (\prior -> let next = prior <> bytes in (next,next))
                sent <- readIORef assigned
                when (not sent && "\r\n\r\n" `Bytes.isInfixOf` accumulated) $ do
                  writeIORef assigned True
                  let header = Char8.takeWhile (/='\r') accumulated
                      subscribe = requestStart Route.SubscribeToBus `Bytes.isPrefixOf` header
                      emit = requestStart Route.EmitOnBus `Bytes.isPrefixOf` header
                      health = requestStart Route.GetHealth `Bytes.isPrefixOf` header
                  when (if subject == "unansweredEmit" then emit else if subject == "unansweredRequest" then health else subscribe)
                    (atomically (modifyTVar' asks (+1)))
                  if subscribe then case subject of
                    "unansweredStream" -> pure ()
                    "refusedStream" -> refuse output
                    "degradedStream" -> refuse output
                    _ -> atomically (writeTQueue output "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
                    else unless (emit || health) (ioError (userError ("unexpected controlled HTTP request " ++ show header)))
              stop = atomically $ do
                prior <- readTVar stopped
                unless prior $ do
                  writeTVar stopped True
                  modifyTVar' closed (+1)
          makeConnection readBytes writeBytes stop
        refuse output = do
          let retryHeader = case KM.lookup "retryAfterSeconds" given of
                Nothing -> Bytes.empty
                Just value -> "Retry-After: " <> Char8.pack (show (round (number value) :: Integer)) <> "\r\n"
          atomically (writeTQueue output ("HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 2\r\n" <> retryHeader <> "\r\n{}"))
        time = Retry.RetryOptions (Time.now clock) (Time.waitUntil clock) (pure 0)
    pool <- Http.newHttpClient noProxy defaultManagerSettings { managerRawConnection = pure connect }
    let token = if subject == "unansweredRequest" then Nothing else Just "clock-token"
        options = Http.HttpOptions "http://clock.test" pool (pure token) (const (pure Nothing)) time Timing.protocolSettings fresh
          (Set.fromList Channel.globalChannels) (pure Map.empty) (\_ _ -> pure ())
    http <- Http.newHttpTransport options
    watcher <- async (State.watch (Transport.state (Http.transport http)) (Stream.mapM_ (\state ->
      when (state == Transport.Degraded) (atomically (modifyTVar' degraded (+1))))))
    owned <- case subject of
      "unansweredRequest" -> Just <$> async (do
        result <- try (Gateway.healthCheck (Http.gateway http)) :: IO (Either SomeException HealthResponse)
        case result of Left _ -> atomically (modifyTVar' failures (+1)); Right _ -> ioError (userError "unanswered health request returned"))
      "unansweredEmit" -> Just <$> async (do
        result <- try (Transport.emit (Http.transport http)
          (BusFrame (Channel.channelName Channel.FrameAddEntityType) Nothing (BusFramePayload (KM.singleton "entityType" (String "clock"))) Nothing)) :: IO (Either SomeException (Maybe Integer))
        case result of Left _ -> pure (); Right _ -> ioError (userError "unanswered emit returned"))
      _ -> pure Nothing
    resource <- either (ioError . userError) pure (mkResourceId "clock-resource")
    release <- newIORef (pure ())
    when (subject == "scopeLetGo") $ do
      Time.settle
      Transport.subscribeToResource (Http.transport http) resource >>= writeIORef release
    let action = case subject of
          "scopeTaken" -> Transport.subscribeToResource (Http.transport http) resource >>= writeIORef release
          "scopeLetGo" -> readIORef release >>= id
          "handoffLinger" -> Transport.subscribeToResource (Http.transport http) resource >>= writeIORef release
          _ -> pure ()
        count = readTVarIO (if subject == "degradedStream" then degraded else if subject == "handoffLinger" then closed else if subject == "unansweredRequest" then failures else asks)
        finish = (readIORef release >>= id) `finally`
          (mapM_ cancel owned `finally` (cancel watcher `finally` Http.dispose http))
    pure (Scenario action count finish)

discoveryClockCases :: FilePath -> DiscoveredKB -> IO ()
discoveryClockCases root kb = clockCasesFor root ["discovery"] $ \clock _ -> do
  readCount <- newTVarIO 0
  let transport = Discovery.DiscoveryTransport $ atomically $ do
        count <- readTVar readCount
        writeTVar readCount (count+1)
        pure (if count == 0 then Discovery.Read (Discovery.Managed [kb]) else Discovery.Unchanged)
      options = Discovery.DiscoveryOptions (Time.now clock) (Time.waitUntil clock) (Timing.discoveryIntervalMs Timing.protocolSettings)
  worker <- async (Stream.effects (Discovery.subscribeDiscovery options transport))
  pure (Scenario (pure ()) (readTVarIO readCount) (cancel worker))

cacheClockCases :: FilePath -> IO ()
cacheClockCases root = clockCasesFor root ["saveDebounce"] $ \clock _ -> do
  saves <- newTVarIO 0
  values <- newIORef (0::Int)
  let persister = Cache.CachePersister (pure []) (\_ -> atomically (modifyTVar' saves (+1)))
      options = Cache.CacheOptions (Time.now clock) (Time.waitUntil clock)
        (Timing.saveDebounceMs Timing.protocolSettings) (Just persister) (const (pure (pure ())))
  cache <- Cache.newCache (pure :: Int -> IO Int) options
  let action = atomicModifyIORef' values (\n -> (n+1,n+1)) >>= Cache.set cache 1
  pure (Scenario action (readTVarIO saves) (Cache.dispose cache))
