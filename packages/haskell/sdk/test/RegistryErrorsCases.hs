{-# LANGUAGE OverloadedStrings #-}
-- | protocol/specs/src/session/registry-errors-cases.json: a registry reads the errors of each session it activates,
-- from the first thing the session said, under a factory that reads none of them, and reads them to their end as it
-- closes. The factory's sessions are HTTP sessions over the stage whose clients keep, so each says its own errors as
-- a session does: for a write the storage it keeps in refuses, or a sign-in that cannot be read or cannot record the
-- person the gateway names. Its transport's failures are said on its transport as the transport says its own, and its
-- renewal records the token it is handed, so a case holds that the registry renewed nothing. A registry's close also
-- waits for a switch under way to finish closing the session it retired.
module RegistryErrorsCases (registryErrorsCases) where

import Control.Concurrent.Async (Async, poll, wait, withAsync)
import Control.Concurrent.STM
import Control.Exception (bracket, onException)
import Control.Monad (forM_, unless, void, when)
import Data.Aeson (FromJSON, Value(..), eitherDecodeStrict', fromJSON, Result(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.Map.Strict as Map
import Data.Maybe (isJust)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified ControlledTime as Time
import GatewayStage (newStage, stageHttp, registered, signInOf)
import SessionCases (jwt)
import qualified Semiont.Browse as Browse
import qualified Semiont.Cache as Cache
import qualified Semiont.Client as Client
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (SessionError(..), TransportError(..))
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Http as Http
import qualified Semiont.Internal.Browse as BrowseState
import Semiont.Internal.Kept (personKey)
import Semiont.Internal.Transport (reportFailure)
import qualified Semiont.Issuer as Issuer
import qualified Semiont.Registry as Browser
import qualified Semiont.Registry.Factory as Factory
import qualified Semiont.Session as Session
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.SignIn as SignIn
import qualified Semiont.State.SessionSignals as Signals
import qualified Semiont.StateValue as State
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types
import qualified Streaming.Prelude as Stream
import System.FilePath ((</>))
import System.Timeout (timeout)

failure :: Text -> String -> IO result
failure why message = ioError (userError ("registry-errors case " ++ show why ++ ": " ++ message))

field :: FromJSON value => Text -> Text -> Value -> IO value
field why name (Object fields) = case KM.lookup (Key.fromText name) fields of
  Just value | Success parsed <- fromJSON value -> pure parsed
  _ -> failure why ("states no " ++ Text.unpack name ++ " of its kind")
field why _ _ = failure why "is no object"

-- | A member a row may leave out.
stated :: FromJSON value => Text -> Text -> Value -> IO (Maybe value)
stated why name (Object fields) = case KM.lookup (Key.fromText name) fields of
  Nothing -> pure Nothing
  Just value | Success parsed <- fromJSON value -> pure (Just parsed)
  Just _ -> failure why ("states a " ++ Text.unpack name ++ " of no kind the table names")
stated why _ _ = failure why "is no object"

fixture :: FromJSON result => Map.Map Text Value -> Text -> IO result
fixture fixtures name = case Map.lookup name fixtures of
  Just value | Success parsed <- fromJSON value -> pure parsed
  _ -> ioError (userError ("no " ++ Text.unpack name ++ " fixture for the registry-errors cases"))

agreeOn :: (Eq value, Show value) => Text -> String -> value -> value -> IO ()
agreeOn why what found tabled = unless (found == tabled) (failure why (what ++ ": " ++ show found ++ "; the table's is " ++ show tabled))

-- | Waits for probe, the controlled clock moved on by a reconnect's debounce at a time.
eventually :: Time.ControlledTime -> Text -> String -> IO Bool -> IO ()
eventually time why what probe = do
  seen <- Time.within time (Timing.reconnectDebounceMs Timing.protocolSettings * 1000000) probe
  unless seen (failure why ("never saw " ++ what))

-- | One thing a session says: one of its own errors, or a failure of its transport with its message.
data Saying = Own Code.SessionCode | Failing Code.TransportCode Text deriving Eq

saying :: Text -> Value -> IO Saying
saying why (Object said) = case (KM.lookup "own" said, KM.lookup "transport" said, KM.lookup "message" said) of
  (Just (String code), Nothing, Nothing) | KM.size said == 1 ->
    maybe (failure why ("says " ++ show code ++ ", no code of the session group")) (pure . Own) (Code.parseSessionCode code)
  (Nothing, Just (String code), Just (String message)) | KM.size said == 2 ->
    maybe (failure why ("says " ++ show code ++ ", no code of the transport group")) (\parsed -> pure (Failing parsed message))
      (Code.parseTransportCode code)
  _ -> failure why ("says " ++ show (Object said) ++ ", which is neither an own error nor a failure of the transport")
saying why other = failure why ("says " ++ show other ++ ", which is no object")

-- | The runner's hold on the sessions the factory builds.
data Doubles = Doubles
  { refusing :: TVar Bool
  -- ^ The storage the session's client keeps in refuses each write.
  , refused :: TVar Int
  -- ^ The writes it refused.
  , withholding :: TVar Bool
  -- ^ That storage answers no write until this is cleared.
  , withheld :: TVar Int
  -- ^ The writes it made wait.
  , unreadable :: TVar Bool
  -- ^ The session's sign-in cannot be read.
  , unread :: TVar Int
  -- ^ The reads of it that failed.
  , unrecordable :: TVar Bool
  -- ^ The session's sign-in cannot record the person the gateway names.
  , handed :: TVar [Maybe Text]
  -- ^ What each renewal of the session was handed.
  , listening :: TMVar ()
  -- ^ The registry's errors are being read; the factory builds nothing before.
  , asking :: TMVar ()
  -- ^ The session's startup may ask who its token is.
  }

newDoubles :: Bool -> IO Doubles
newDoubles refusingAll = atomically $ Doubles <$> newTVar refusingAll <*> newTVar 0 <*> newTVar False <*> newTVar 0
  <*> newTVar False <*> newTVar 0 <*> newTVar False <*> newTVar [] <*> newEmptyTMVar <*> newEmptyTMVar

-- | Fails for reason while flag holds, noting the failure first.
failWhile :: TVar Bool -> STM () -> String -> IO ()
failWhile flag noted reason = do
  failing <- atomically $ do
    on <- readTVar flag
    when on noted
    pure on
  when failing (ioError (userError reason))

-- | Waits while flag holds, noting the wait first.
waitWhile :: TVar Bool -> STM () -> IO ()
waitWhile flag noted = do
  waits <- atomically $ do
    on <- readTVar flag
    when on noted
    pure on
  when waits (atomically (readTVar flag >>= check . not))

-- | The knowledge base's HTTP session over the stage, for person, reading none of its errors. Its client keeps in a
-- storage the doubles hold and refuse writes to; its sign-in, in memory, names person and fails as the doubles say;
-- its renewal records what it is handed. What the case has it say as the factory builds it, it says then.
factoryOf :: Text -> Doubles -> Http.HttpOptions -> UserResponse -> [Saying] -> IO Factory.SessionFactory
factoryOf why doubles http person opening = do
  underlying <- Storage.newMemoryStorage
  let answer = waitWhile (withholding doubles) (modifyTVar' (withheld doubles) (+1))
        >> failWhile (refusing doubles) (modifyTVar' (refused doubles) (+1)) "the storage refuses every write"
      keeping = Storage.SessionStorage (Storage.get underlying) (\key value -> answer >> Storage.set underlying key value)
        (\key -> answer >> Storage.delete underlying key) (\key change -> answer >> Storage.update underlying key change)
        (Storage.subscribe underlying)
      named = personKey (userIdValue (userResponseDid person))
      open inputs = do
        atomically (readTMVar (listening doubles))
        let kb = Factory.sessionFactoryOptionsKb inputs
        endpoint <- case knowledgeBaseEndpoint kb of
          KbEndpointBranch1 value -> pure value
          KbEndpointBranch2 _ -> failure why "registers a knowledge base the stage does not serve"
        base <- either (failure why . Text.unpack) pure (Gateway.gatewayUrl endpoint)
        memory <- SignIn.newMemorySignIn
        SignIn.keep memory (signInOf Issuer.browserClientId (jwt 3600 1) "r1" (Just named))
        let kept = memory
              { SignIn.held = failWhile (unreadable doubles) (modifyTVar' (unread doubles) (+1)) "the sign-in cannot be read"
                  >> SignIn.held memory
              , SignIn.recordPersonKey = \access key -> failWhile (unrecordable doubles) (pure ()) "the sign-in cannot record a person"
                  >> SignIn.recordPersonKey memory access key
              }
            renew given = atomically (modifyTVar' (handed doubles) (<> [given])) >> pure (Just (jwt 7200 2))
            validate _ _ = atomically (readTMVar (asking doubles)) >> pure (Just person)
            settings = Session.SessionOptions (knowledgeBaseId kb)
              (KbTarget (knowledgeBaseEndpoint kb) (knowledgeBaseId kb) (knowledgeBaseLabel kb) mempty) kept Nothing (Just renew)
              (Just validate) (atomically . Signals.notifySessionEnded (Factory.sessionFactoryOptionsSignals inputs)) (pure 1800000000)
        opened <- Session.fromHttp http { Http.httpBaseUrl = base } (Just keeping) settings
        (mapM_ (sayOpening (Session.openedSession opened)) opening >> atomically (void (tryPutTMVar (asking doubles) ())))
          `onException` Session.closeOpenedSession opened
        pure opened
      -- The runner waits in a transaction while the factory builds, so this settling is of everything else.
      sayOpening session said = case said of
        Own Code.SessionKeepFailed -> do
          atomically (writeTVar (unrecordable doubles) True >> void (tryPutTMVar (asking doubles) ()))
          Session.ready session
          atomically (writeTVar (unrecordable doubles) False)
        Own code -> failure why ("says " ++ show (Code.sessionCode code) ++ " as its factory builds it, before its client holds anything")
        Failing code message -> reportFailure (Client.transport (Session.client session)) (TransportError code message Nothing Nothing)
          >> Time.settle
  pure (Factory.SessionFactory open (const (pure ())))

-- | The session's client asks the gateway for the resource of that name.
holding :: Text -> Time.ControlledTime -> Session.Session -> Text -> IO ()
holding why time session name = do
  identity <- either (failure why) pure (mkResourceId name)
  withAsync (Cache.fresh (Browse.resource (Client.browse (Session.client session)) identity)) $ \fetch -> do
    eventually time why (Text.unpack name ++ " fetched") (isJust <$> poll fetch)
    void (wait fetch)

-- | Every code said on the registry's errors, in order, until they end.
reading :: Doubles -> TVar [Text] -> Browser.SemiontBrowser -> IO ()
reading doubles said browser = Browser.errors browser $ \failures -> do
  atomically (putTMVar (listening doubles) ())
  Stream.mapM_ (\problem -> atomically (modifyTVar' said (<> [Code.sessionCode (sessionErrorCode problem)]))) failures

-- | A registry over the stage whose one knowledge base is active, its sessions the factory's, its errors read from
-- before it activates anything: the registry's active session, its signals, and the codes said on its errors.
overTheStage :: Text -> Doubles -> Timing.Settings -> UserResponse -> [Saying]
  -> (Time.ControlledTime -> Browser.SemiontBrowser -> Async () -> TVar [Text] -> Session.Session -> Signals.SessionSignals -> IO ())
  -> IO ()
overTheStage why doubles timing person opening body = do
  stage <- newStage
  time <- Time.newTime
  http <- stageHttp stage time timing
  factory <- factoryOf why doubles http person opening
  store <- Storage.newMemoryStorage
  Browser.saveKnowledgeBases store [registered "kb-a"]
  Storage.set store Browser.activeKey "kb-a"
  said <- newTVarIO []
  bracket (Browser.newSemiontBrowser (Browser.SemiontBrowserConfig store factory http (pure 1800000000))) Browser.dispose $ \browser ->
    withAsync (reading doubles said browser) $ \reader -> do
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

registryErrorsCases :: FilePath -> Map.Map Text Value -> IO ()
registryErrorsCases root fixtures = do
  table <- Bytes.readFile (root </> "protocol/specs/src/session/registry-errors-cases.json")
    >>= either (ioError . userError) pure . eitherDecodeStrict'
  cases <- field "the registry-errors table" "cases" table :: IO [Value]
  closing <- field "the registry-errors table" "closing" table :: IO [Value]
  outcome <- timeout 60000000 (mapM_ (runCase fixtures) cases >> mapM_ (runClosing fixtures) closing >> runRetiredClosing fixtures)
  maybe (ioError (userError "the registry-errors cases did not finish in a minute")) pure outcome
  putStrLn ("PASS " ++ show (length cases) ++ " shared registry-errors cases and " ++ show (length closing)
    ++ " of a registry's close, and a close that waits for a switch to finish closing the session it retired")
