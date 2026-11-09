{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module SessionCases (jwt, sessionCases, sessionClockCases) where

import Control.Concurrent.Async (async, wait, replicateConcurrently)
import Control.Concurrent.STM
import Control.Exception (bracket, finally, throwIO, try, IOException)
import Control.Monad (forM_, unless)
import Data.Aeson (FromJSON, Result(..), Value(..), eitherDecodeStrict', encode, fromJSON, object, (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.ByteString.Base64.URL as Base64
import Data.Foldable (toList)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Scientific (Scientific)
import Data.Text (Text)
import Data.Text.Encoding (decodeUtf8)
import qualified Semiont.Bus as Bus
import qualified Semiont.Client as Client
import qualified Semiont.Content as Content
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors
import qualified Semiont.Retry as Retry
import qualified Semiont.Session as Session
import qualified Semiont.SignIn as SignIn
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.Registry.Stored as Stored
import qualified Semiont.StateValue as State
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types
import qualified ControlledTime as Time
-- Runs protocol/specs/src/client/clock-cases.json through the shared clock runner.
import ClockCases (clockCasesFor, Scenario(..))
import System.FilePath ((</>))

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
member :: Text -> Value -> Value
member name (Object fields) = maybe (error "missing session-case member") Prelude.id (KM.lookup (Key.fromText name) fields)
member _ _ = error "session case is not an object"
array :: Value -> [Value]
array (Array values) = toList values
array _ = error "session cases are not an array"
readValue :: FromJSON value => Value -> IO value
readValue value = case fromJSON value of Error message -> ioError (userError message); Success parsed -> pure parsed
jwt :: Scientific -> Integer -> Text
jwt lifetime serial = "e30."<>decodeUtf8 (Base64.encodeUnpadded (Lazy.toStrict
  (encode (object ["iat" .= (1800000000::Scientific), "exp" .= (1800000000+lifetime), "n" .= serial]))))<>"."
kb :: IO KbTarget
kb = readValue (object ["id" .= String "session-cases", "label" .= String "Sessions",
  "endpoint" .= object ["kind" .= String "http", "host" .= String "localhost", "port" .= (4000::Integer), "protocol" .= String "http"]])

timeOptions :: Time.ControlledTime -> Retry.RetryOptions
timeOptions time = Retry.RetryOptions (Time.now time) (Time.waitUntil time) (pure 0)
withClient :: Time.ControlledTime -> (Client.Client -> IO result) -> IO result
withClient time action = do
  let unused = ioError (userError "the session used a client operation its case never called")
      contents = Content.ContentTransport (\_ _ _ _ -> unused) (\_ _ -> unused) (\_ _ _ -> unused)
        (\_ _ -> unused) (\_ _ -> unused) (\_ _ -> unused) (pure ())
      options = Bus.BusOptions (Time.now time) (Time.waitUntil time) (pure "session-case")
  (transport,_) <- Transport.newTransport (Transport.TransportOptions "http://localhost:4000" Set.empty (const unused) (pure ()))
  bracket (Client.newClient transport contents Nothing options Timing.protocolSettings Nothing) Client.dispose action

stored :: Text -> StoredSession
stored access = StoredSession access "session-cases" "refresh-credential" Nothing "https://issuer.test/token" KM.empty

sessionCases :: FilePath -> Map.Map Text Value -> IO ()
sessionCases root fixtures = do
  table <- Bytes.readFile (root </> "protocol/specs/src/session/cases.json") >>= either (ioError . userError) pure . eitherDecodeStrict'
  target <- kb
  person <- maybe (ioError (userError "session cases lack UserResponse fixture")) readValue (Map.lookup "UserResponse" fixtures)
  forM_ ["startup","refusal"] $ \section -> forM_ (array (member section table)) $ \row -> do
    time <- Time.newTime
    withClient time $ \owned -> do
      storage <- Storage.newMemoryStorage
      start <- if section == "refusal" then pure "unexpired" else readValue (member "stored" row)
      case start :: Text of
        "none" -> pure ()
        "unexpired" -> Stored.storeSession storage (kbTargetId target) (stored (jwt 3600 0))
        "expired" -> Stored.storeSession storage (kbTargetId target) (stored (jwt (-300) 0))
        _ -> ioError (userError "unknown startup credential kind")
      asks <- newTVarIO (0::Integer)
      renewals <- newTVarIO (0::Integer)
      beginning <- newTVarIO (section=="refusal")
      told <- newTVarIO []
      failures <- newTVarIO []
      answered <- newTVarIO Nothing
      let script name count = case array (member name row) of
            [] -> ioError (userError "empty session answer script")
            values -> readValue (values !! min (fromInteger count) (length values-1))
          validate _ = do
            before <- readTVarIO beginning
            count <- atomically $ do n <- readTVar asks; unless before (writeTVar asks (n+1)); pure n
            said <- if before then pure "accepts" else script "gateway" count
            case said :: Text of
              "accepts" -> do
                let current = person { userResponseName = Just (decodeUtf8 (Lazy.toStrict (encode count))) }
                atomically (writeTVar answered (Just current))
                pure (Just current)
              "refuses" -> throwIO (TransportError Code.TransportUnauthorized "refused" (Just 401) Nothing)
              "unreachable" -> throwIO (TransportError Code.TransportUnavailable "no answer" Nothing Nothing)
              _ -> ioError (userError "unknown gateway script answer")
          renew = do
            count <- atomically $ do n <- readTVar renewals; writeTVar renewals (n+1); pure n
            said <- script "issuer" count
            case said :: Text of
              "renews" -> pure (Just (jwt 3600 (count+1)))
              "refuses" -> throwIO (SignInError Code.SignInExchange "refused" (Just 400))
              "unreachable" -> throwIO (SignInError Code.SignInExchange "no answer" Nothing)
              _ -> ioError (userError "unknown issuer script answer")
          options = Session.SessionOptions "case" target (Stored.keptIn storage (kbTargetId target)) Nothing (Just (const renew)) (Just (\_ -> validate))
            (\reason -> atomically (modifyTVar' told (<>[reason])))
            (\failure -> atomically (modifyTVar' failures (<>[Code.sessionCode (sessionErrorCode failure)])))
            (pure 1800000000)
          checkState expected = do
            actualAsks <- readTVarIO asks
            actualRenewals <- readTVarIO renewals
            expectedAsks <- readValue (member "asks" expected)
            expectedRenewals <- readValue (member "renewals" expected)
            require ("session asks/renewals differ: "++show row++" actual "++show (actualAsks,actualRenewals))
              ((actualAsks,actualRenewals)==(expectedAsks,expectedRenewals))
          checkEnd session expected = do
            held <- atomically (State.current (Session.token session))
            signedIn <- atomically (State.current (Session.user session))
            ends <- readValue (member "ends" expected)
            require ("session end differs: "++show row) ((case held of Nothing -> "signed-out"; Just _ -> if signedIn==Nothing then "unconfirmed" else "signed-in")==(ends::Text))
            whenSignedIn ends $ require "session did not keep the gateway's latest person" . (==signedIn) =<< readTVarIO answered
      bracket (Session.newSession owned options (timeOptions time) Timing.protocolSettings) Session.dispose $ \session -> do
        Session.ready session
        whenSignedIn (if section=="refusal" then "signed-in" else "") $ do
          atomically (writeTVar beginning False)
          held <- atomically (State.current (Session.token session))
          refused <- readValue (member "refused" row) :: IO Text
          let previous=case refused of
                "held" -> held
                "replaced" -> Just (jwt 3600 (-1))
                _ -> error "unknown refused-token selector"
          given <- Session.refresh session previous
          expected <- readValue (member "given" row)
          require "refusal returned the wrong credential presence" (maybe False (const True) given==expected)
        Time.settle
        checkState row
        checkEnd session row
        expectedTold <- readValue (member "told" row)
        expectedError <- readValue (member "error" row)
        require "session end notification differs" . (==maybe [] (:[]) expectedTold) =<< readTVarIO told
        require "session error differs" . (==maybe [] (:[]) expectedError) =<< readTVarIO failures
        kept <- Stored.storedSession storage (kbTargetId target)
        expectedKept <- readValue (member "kept" row)
        require "session forgot a usable credential or kept a refused one" (maybe False (const True) kept==expectedKept)
        case row of
          Object fields | Just later <- KM.lookup "then" fields -> do
            Time.advance time (Timing.reconnectMs Timing.protocolSettings*1200000)
            checkState later
            checkEnd session later
          _ -> do
            ends <- readValue (member "ends" row)
            whenSignedIn (if ends==("signed-out"::Text) then "signed-in" else "") $ do
              Time.advance time (2*60*60*1000000000)
              checkState row
  concurrentCases target person
  externalCases target person
  putStrLn "PASS every shared session startup/refusal case, bounded renewal, reconnect recovery and disposal"
  where
    whenSignedIn text action = if text==("signed-in"::Text) then action else pure ()

concurrentCases :: KbTarget -> UserResponse -> IO ()
concurrentCases target person = do
  time <- Time.newTime
  withClient time $ \owned -> do
    storage <- Storage.newMemoryStorage
    Stored.storeSession storage (kbTargetId target) (stored (jwt 3600 0))
    calls <- newTVarIO (0::Integer)
    gate <- newEmptyTMVarIO
    let renew = atomically (modifyTVar' calls (+1)) >> atomically (readTMVar gate) >> pure (Just (jwt 3600 1))
        options = Session.SessionOptions "concurrent" target (Stored.keptIn storage (kbTargetId target)) Nothing (Just (const renew)) (Just (\_ _ -> pure (Just person)))
          (const (pure ())) (const (pure ())) (pure 1800000000)
    bracket (Session.newSession owned options (timeOptions time) Timing.protocolSettings) Session.dispose $ \session -> do
      Session.ready session
      pending <- async (replicateConcurrently 20 (Session.refresh session Nothing))
      Time.settle
      require "concurrent refusals rotated the grant more than once" . (==1) =<< readTVarIO calls
      atomically (putTMVar gate ())
      answers <- wait pending
      require "concurrent refusals did not share the issued credential" (all (==Just (jwt 3600 1)) answers)
      Session.dispose session
      Time.advance time (2*60*60*1000000000)
      require "disposed session renewed" . (==1) =<< readTVarIO calls
      require "session disposal disposed its client's transport" . (/=Transport.Closed) =<< atomically (State.current (Client.state owned))

externalCases :: KbTarget -> UserResponse -> IO ()
externalCases target person = do
  time <- Time.newTime
  withClient time $ \owned -> do
    memory <- Storage.newMemoryStorage
    listener <- newEmptyTMVarIO
    detached <- newTVarIO (0::Integer)
    let storage = memory { Storage.subscribe = \observe -> do
          atomically (putTMVar listener observe)
          pure (Just (atomically (modifyTVar' detached (+1)))) }
    Stored.storeSession storage (kbTargetId target) (stored (jwt 3600 0))
    gate <- newEmptyTMVarIO
    started <- newEmptyTMVarIO
    let issue = atomically (putTMVar started ()) >> atomically (readTMVar gate) >> pure (Just (jwt 3600 1))
        options = Session.SessionOptions "external" target (Stored.keptIn storage (kbTargetId target)) Nothing (Just (const issue)) (Just (\_ _ -> pure (Just person)))
          (const (ioError (userError "external sign-out notified expiry")))
          (const (ioError (userError "a replaced renewal reported a failure"))) (pure 1800000000)
    session <- Session.newSession owned options (timeOptions time) Timing.protocolSettings
    Session.ready session
    pending <- async (Session.refresh session Nothing)
    atomically (readTMVar started)
    Stored.clearStoredSession storage (kbTargetId target)
    observe <- atomically (readTMVar listener)
    observe (Stored.sessionKey (kbTargetId target)) Nothing
    require "external sign-out did not quarantine the in-flight credential immediately" . (==Nothing)
      =<< atomically (State.current (Session.token session))
    atomically (putTMVar gate ())
    require "an old renewal resurrected a signed-out session" . (==Nothing) =<< wait pending
    Session.dispose session
    Session.dispose session
    require "session detached its storage listener more than once" . (==1) =<< readTVarIO detached
    -- Disposal joins an issuer request and releases every waiter, including
    -- callers which did not themselves cancel their refusal request.
    Stored.storeSession memory (kbTargetId target) (stored (jwt 3600 0))
    waiting <- newEmptyTMVarIO
    let held = options { Session.sessionKept=Stored.keptIn memory (kbTargetId target),
          Session.sessionRefresh=Just (\_ -> atomically (putTMVar waiting ()) >> atomically retry) }
    blocked <- Session.newSession owned held (timeOptions time) Timing.protocolSettings
    Session.ready blocked
    refusal <- async (try (Session.refresh blocked Nothing) :: IO (Either BusRequestError (Maybe Text)))
    atomically (readTMVar waiting)
    Session.dispose blocked
    outcome <- wait refusal
    require "disposed renewal caller remained usable" (case outcome of Left failure -> busRequestErrorCode failure==Code.BusRequestClosed; _ -> False)
    Stored.storeSession memory (kbTargetId target) (stored (jwt (-300) 0))
    let broken = options { Session.sessionKept=Stored.keptIn memory (kbTargetId target),
          Session.sessionRefresh=Just (\_ -> throwIO (SignInError Code.SignInExchange "no answer" Nothing)),
          Session.sessionOnError=const (ioError (userError "host error handler failed")) }
    failed <- Session.newSession owned broken (timeOptions time) Timing.protocolSettings
    badReady <- try (Session.ready failed) :: IO (Either IOException ())
    require "a failed host callback made startup look successful" (case badReady of Left _ -> True; _ -> False)
    afterFailure <- try (Session.refresh failed Nothing) :: IO (Either BusRequestError (Maybe Text))
    require "a stopped session worker left later renewal callers waiting" (case afterFailure of Left failure -> busRequestErrorCode failure==Code.BusRequestClosed; _ -> False)
    Session.dispose failed
    grant <- SignIn.newMemorySignIn
    SignIn.keep grant (stored (jwt 3600 0))
    let forgotten=options { Session.sessionKept=grant, Session.sessionRefresh=Just (const (pure Nothing)) }
    missing <- Session.newSession owned forgotten (timeOptions time) Timing.protocolSettings
    Session.ready missing
    SignIn.forget grant
    answer <- Session.refresh missing Nothing
    require "forgotten grant remained usable" (answer==Nothing)
    require "forgotten grant retained its old person" . (==Nothing) =<< atomically (State.current (Session.user missing))
    Session.dispose missing

sessionClockCases :: FilePath -> Map.Map Text Value -> IO [Text]
sessionClockCases root fixtures = clockCasesFor root ["renewal"] $ \time row -> do
  target <- kb
  person <- maybe (ioError (userError "session clock lacks UserResponse")) readValue (Map.lookup "UserResponse" fixtures)
  lifetime <- readValue (member "lifetimeSeconds" (member "given" row))
  storage <- Storage.newMemoryStorage
  Stored.storeSession storage (kbTargetId target) (stored (jwt lifetime 0))
  calls <- newTVarIO (0::Integer)
  -- This subject supplies wall time as well, so freshly minted token claims
  -- track the issuer's clock while every wait stays on monotonic controlled time.
  let now = (1800000000+) . (/1000000000) . fromInteger <$> Time.now time
      issue = do
        count <- atomically $ do modifyTVar' calls (+1); readTVar calls
        issued <- now
        pure (Just ("e30."<>decodeUtf8 (Base64.encodeUnpadded (Lazy.toStrict
          (encode (object ["iat" .= issued, "exp" .= (issued+lifetime), "n" .= count]))))<>"."))
      unused = ioError (userError "renewal clock unexpectedly used the client")
      contents = Content.ContentTransport (\_ _ _ _ -> unused) (\_ _ -> unused) (\_ _ _ -> unused)
        (\_ _ -> unused) (\_ _ -> unused) (\_ _ -> unused) (pure ())
      busOptions = Bus.BusOptions (Time.now time) (Time.waitUntil time) (pure "session-clock")
  (transport,_) <- Transport.newTransport (Transport.TransportOptions "http://localhost:4000" Set.empty (const unused) (pure ()))
  owned <- Client.newClient transport contents Nothing busOptions Timing.protocolSettings Nothing
  let options = Session.SessionOptions "clock" target (Stored.keptIn storage (kbTargetId target)) Nothing (Just (const issue)) (Just (\_ _ -> pure (Just person)))
        (const (pure ())) (const (pure ())) now
  session <- Session.newSession owned options (timeOptions time) Timing.protocolSettings
  Session.ready session
  pure (Scenario (pure ()) (readTVarIO calls) (Session.dispose session `finally` Client.dispose owned))
