{-# LANGUAGE OverloadedStrings #-}
-- | protocol/specs/src/session/registry-errors-cases.json: a registry reads the errors of each session it activates,
-- from the first thing the session said, under a factory that reads none of them, and reads them to their end as it
-- closes. The factory's sessions are HTTP sessions over the stage whose clients keep, so each says its own errors as
-- a session does: for a write the storage it keeps in refuses, or a sign-in that cannot be read or cannot record the
-- person the gateway names. Its transport's failures are said on its transport as the transport says its own, and its
-- renewal records the token it is handed, so a case holds that the registry renewed nothing. A registry's close also
-- waits for a switch under way to finish closing the session it retired. A registry nobody reads keeps the latest
-- errorsKeptForFirstReaderCount it said for its first reader, and drops them as it closes.
module RegistryErrorsCases (registryErrorsCases) where

import Control.Concurrent.Async (Async, wait, withAsync)
import Control.Concurrent.STM
import Control.Exception (bracket, throwIO)
import Control.Monad (forM_, unless, when)
import Data.Aeson (Value(..), eitherDecodeStrict')
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.Map.Strict as Map
import Data.Maybe (isJust)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified ControlledTime as Time
import GatewayStage (newStage, stageHttp, registered)
import RegistryRunners
import qualified Semiont.Client as Client
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (SessionError(..), TransportError(..))
import qualified Semiont.Internal.Browse as BrowseState
import Semiont.Internal.Transport (reportFailure)
import qualified Semiont.Registry as Browser
import qualified Semiont.Registry.Factory as Factory
import qualified Semiont.Session as Session
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.State.SessionSignals as Signals
import qualified Semiont.StateValue as State
import Semiont.Timing (errorsKeptForFirstReaderCount)
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types
import qualified Streaming.Prelude as Stream
import System.FilePath ((</>))
import System.Timeout (timeout)

saying :: Text -> Value -> IO Saying
saying why (Object said) = case (KM.lookup "own" said, KM.lookup "transport" said, KM.lookup "message" said) of
  (Just (String code), Nothing, Nothing) | KM.size said == 1 ->
    maybe (failure why ("says " ++ show code ++ ", no code of the session group")) (pure . Own) (Code.parseSessionCode code)
  (Nothing, Just (String code), Just (String message)) | KM.size said == 2 ->
    maybe (failure why ("says " ++ show code ++ ", no code of the transport group")) (\parsed -> pure (Failing parsed message))
      (Code.parseTransportCode code)
  _ -> failure why ("says " ++ show (Object said) ++ ", which is neither an own error nor a failure of the transport")
saying why other = failure why ("says " ++ show other ++ ", which is no object")

-- | A registry over the stage whose one knowledge base is active, its sessions the factory's, its errors read from
-- before it activates anything: the registry's active session, its signals, and the codes said on its errors.
overTheStage :: Text -> Doubles -> Timing.Settings -> UserResponse -> [Saying]
  -> (Time.ControlledTime -> Browser.SemiontBrowser -> Async () -> TVar [Text] -> Session.Session -> Signals.SessionSignals -> IO ())
  -> IO ()
overTheStage why doubles timing person opening body = do
  stage <- newStage
  time <- Time.newTime
  http <- stageHttp stage time timing
  factory <- factoryOf why doubles http person opening (const (pure ()))
  store <- Storage.newMemoryStorage
  Browser.saveKnowledgeBases store [registered "kb-a"]
  Storage.set store Browser.activeKey "kb-a"
  said <- newTVarIO []
  bracket (Browser.newSemiontBrowser (Browser.SemiontBrowserConfig store factory http (pure 1800000000))) Browser.dispose $ \browser ->
    withAsync (reading doubles (Code.sessionCode . sessionErrorCode) said browser) $ \reader -> do
      atomically (readTMVar (listening doubles))
      session <- atomically (State.current (Browser.activeSession browser) >>= maybe retry pure)
      signals <- atomically (State.current (Browser.activeSignals browser)) >>= maybe (failure why "has an active session with no signals") pure
      body time browser reader said session signals

runCase :: Map.Map Text Value -> Value -> IO ()
runCase fixtures row = do
  why <- field "a case" "why" row
  while <- field why "while" row :: IO Text
  said <- field why "said" row >>= mapM (saying why) :: IO [Saying]
  expected <- field why "registryErrors" row :: IO [Text]
  denied <- stated why "permissionDenied" row :: IO (Maybe Text)
  (opening, active) <- case while of
    "opening" -> pure (said, [])
    "active" -> pure ([], said)
    _ -> failure why ("says what it says while " ++ show while ++ ", which the table does not name")
  forM_ opening $ \first -> case first of
    Own code | code /= Code.SessionKeepFailed ->
      failure why ("says " ++ show (Code.sessionCode code) ++ " as its factory builds it, before its client holds anything")
    _ -> pure ()
  final <- case reverse said of
    last' : _ -> pure last'
    [] -> failure why "says nothing"
  case final of
    Failing code _ | code /= Code.TransportForbidden ->
      failure why ("ends with " ++ show (Code.transportCode code) ++ ", which has no effect a runner can wait for")
    _ -> pure ()
  person <- fixture fixtures "UserResponse"
  doubles <- newDoubles False
  names <- newTVarIO (0 :: Int)
  overTheStage why doubles Timing.protocolSettings person opening $ \time _ _ registrySaid session signals -> do
    let fetchNext = do
          next <- atomically (modifyTVar' names (+1) >> readTVar names)
          holding why time session ("res-" <> Text.pack (show next))
        -- A fetch fails as flag says until failures grows, and the registry then says code before the next thing is
        -- said, so the next is met after it.
        failingWhile flag failures what code = do
          let registrySays = length . filter (== Code.sessionCode code) <$> readTVarIO registrySaid
          (failedBefore, saidBefore) <- (,) <$> atomically (writeTVar flag True >> readTVar failures) <*> registrySays
          fetchNext
          eventually time why what ((> failedBefore) <$> readTVarIO failures)
          atomically (writeTVar flag False)
          eventually time why ("the registry say " ++ show (Code.sessionCode code)) ((> saidBefore) <$> registrySays)
        sayActive saidNow = case saidNow of
          Own Code.SessionSaveRefused ->
            failingWhile (refusing doubles) (refused doubles) "the storage refuse a write" Code.SessionSaveRefused
          Own Code.SessionKeepFailed ->
            failingWhile (unreadable doubles) (unread doubles) "the sign-in fail to be read" Code.SessionKeepFailed
          Own code -> failure why ("says " ++ show (Code.sessionCode code) ++ ", which the runner has no way to have a session say")
          Failing code message -> do
            reportFailure (Client.transport (Session.client session)) (TransportError code message Nothing Nothing)
            Time.settle
        deniedNow = fmap permissionDeniedDetail <$> atomically (State.current (Signals.permissionDenied signals))
    mapM_ sayActive active
    case final of
      Own code -> do
        let times = length (filter (== Own code) said)
        eventually time why ("the registry say " ++ show (Code.sessionCode code))
          ((>= times) . length . filter (== Code.sessionCode code) <$> readTVarIO registrySaid)
      Failing _ _ -> eventually time why "a refusal for lack of permission said through the signals" (isJust <$> deniedNow)
    readTVarIO registrySaid >>= \found -> agreeOn why "said on the registry's errors" found expected
    readTVarIO (handed doubles) >>= \tokens -> agreeOn why "renewals the registry handed the session" tokens []
    deniedNow >>= \found -> agreeOn why "said through the signals as a refusal for lack of permission" found (Just <$> denied)

runClosing :: Map.Map Text Value -> Value -> IO ()
runClosing fixtures row = do
  why <- field "a closing case" "why" row
  owed <- field why "owed" row :: IO Bool
  expected <- field why "registryErrors" row :: IO [Text]
  person <- fixture fixtures "UserResponse"
  doubles <- newDoubles True
  let unsaved = Timing.protocolSettings { Timing.saveDebounceMs = 3600000 }
  overTheStage why doubles unsaved person [] $ \time browser reader registrySaid session _ -> do
    when owed (holding why time session "res-1")
    owes <- atomically (BrowseState.persistencePending (Client.browse (Session.client session)))
    agreeOn why "the client owes a save" owes owed
    before <- length <$> readTVarIO registrySaid
    Browser.dispose browser
    wait reader
    readTVarIO registrySaid >>= \found -> agreeOn why "said on the registry's errors as it closed" (drop before found) expected

-- | A registry that closes while a switch away from its knowledge base is still closing the session it retired waits
-- for that close. The save the retired session's client owes is held by the storage until the registry's close has
-- gone as far as it goes without it, then refused, and the refusal is said on the registry's errors before they end.
runRetiredClosing :: Map.Map Text Value -> IO ()
runRetiredClosing fixtures = do
  let why = "a registry's close waits for a switch under way to finish closing the session it retired"
  person <- fixture fixtures "UserResponse"
  doubles <- newDoubles True
  let unsaved = Timing.protocolSettings { Timing.saveDebounceMs = 3600000 }
  overTheStage why doubles unsaved person [] $ \time browser reader registrySaid session _ -> do
    holding why time session "res-1"
    owes <- atomically (BrowseState.persistencePending (Client.browse (Session.client session)))
    unless owes (failure why "has a client that owes no save")
    before <- length <$> readTVarIO registrySaid
    atomically (writeTVar (withholding doubles) True)
    withAsync (Browser.setActiveKb browser Nothing) $ \_ -> do
      atomically (readTVar (withheld doubles) >>= check . (> 0))
      withAsync (Browser.dispose browser) $ \disposal -> do
        Time.settle
        atomically (writeTVar (withholding doubles) False)
        wait disposal
    wait reader
    found <- drop before <$> readTVarIO registrySaid
    unless (found == [Code.sessionCode Code.SessionSaveRefused])
      (failure why ("said " ++ show found ++ " on the registry's errors as it closed, not the retired session's refused save"))

-- | A registry over one knowledge base whose factory refuses each session it is asked for, saying why on the
-- registry's errors, which nobody reads: it refuses count, then body is handed the registry.
refusedBuilds :: Text -> Int -> (Browser.SemiontBrowser -> IO ()) -> IO ()
refusedBuilds why count body = do
  stage <- newStage
  time <- Time.newTime
  http <- stageHttp stage time Timing.protocolSettings
  builds <- newTVarIO (0 :: Int)
  let refuse _ = do
        build <- atomically (modifyTVar' builds (+1) >> readTVar builds)
        throwIO (SessionError Code.SessionConstructFailed ("build " <> Text.pack (show build) <> " refused") "kb-a")
  store <- Storage.newMemoryStorage
  Browser.saveKnowledgeBases store [registered "kb-a"]
  bracket (Browser.newSemiontBrowser (Browser.SemiontBrowserConfig store (Factory.SessionFactory refuse (const (pure ()))) http (pure 1800000000)))
    Browser.dispose $ \browser -> do
      -- The registry activates its knowledge base as it opens, and again each time it is selected with no session live.
      atomically $ do
        built <- readTVar builds
        activating <- State.current (Browser.sessionActivating browser)
        check (built >= 1 && not activating)
      forM_ [2 .. count] (\_ -> Browser.setActiveKb browser (Just "kb-a"))
      built <- readTVarIO builds
      unless (built == count) (failure why ("was asked for " ++ show built ++ " sessions, not " ++ show count))
      body browser

-- | A registry nobody reads says more than it keeps for a first reader: the first reader is given the latest
-- errorsKeptForFirstReaderCount, in the order said, and no more. What one keeps as it closes is dropped: a reader who
-- comes after hears nothing.
runKeptForFirstReader :: IO ()
runKeptForFirstReader = do
  let why = "a registry's first reader is given the latest it said before it came, in order, and no more"
      beyond = 3 :: Int
      count = fromInteger errorsKeptForFirstReaderCount + beyond
  refusedBuilds why count $ \browser -> do
    heard <- Browser.errors browser (\given -> Browser.dispose browser >> Stream.toList_ given)
    agreeOn why "heard by the first reader" (map sessionErrorMessage heard)
      ["build " <> Text.pack (show build) <> " refused" | build <- [beyond + 1 .. count]]
  let dropped = "a registry drops what it kept for a first reader as it closes"
  refusedBuilds dropped 1 $ \browser -> do
    Browser.dispose browser
    afterClose <- Browser.errors browser Stream.toList_
    agreeOn dropped "heard by a reader who came after the close" (map sessionErrorMessage afterClose) []

registryErrorsCases :: FilePath -> Map.Map Text Value -> IO ()
registryErrorsCases root fixtures = do
  table <- Bytes.readFile (root </> "protocol/specs/src/session/registry-errors-cases.json")
    >>= either (ioError . userError) pure . eitherDecodeStrict'
  cases <- field "the registry-errors table" "cases" table :: IO [Value]
  closing <- field "the registry-errors table" "closing" table :: IO [Value]
  outcome <- timeout 60000000
    (mapM_ (runCase fixtures) cases >> mapM_ (runClosing fixtures) closing >> runRetiredClosing fixtures >> runKeptForFirstReader)
  maybe (ioError (userError "the registry-errors cases did not finish in a minute")) pure outcome
  putStrLn ("PASS " ++ show (length cases) ++ " shared registry-errors cases and " ++ show (length closing)
    ++ " of a registry's close, a close that waits for a switch to finish closing the session it retired, and what a"
    ++ " registry keeps for its first reader")
