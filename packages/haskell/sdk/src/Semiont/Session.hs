{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
-- | One connection's token and confirmed person. Disposal ends the session's
-- work and observations; the client remains owned by whoever constructed it.
module Semiont.Session
  ( Session, SessionOptions(..), OpenedSession(..), SessionEndReason(..), sessionEndReason
  , newSession, fromHttp, fromIssuedSession, signInDevice, signInAgent, id, kb, client, token, user, streamState, errors, ready
  , expiresAt, refresh, renewer, dispose
  ) where

import Prelude hiding (id)
import qualified Prelude
import Control.Concurrent.Async (race)
import Control.Concurrent.STM
import Control.Exception (SomeException, SomeAsyncException, fromException, throwIO, try, mask, onException, finally, toException)
import Control.Monad (forM_, unless, void, when)
import Data.Aeson (eitherDecodeStrict')
import Data.IORef
import Data.Scientific (Scientific)
import Data.Text (Text)
import Data.Text.Encoding (encodeUtf8)
import qualified Semiont.Client as Client
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors
import qualified Semiont.Http as Http
import qualified Semiont.Issuer as Issuer
import qualified Semiont.ServiceToken as Service
import qualified Semiont.Auth as Auth
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Internal.Lifetime as Lifetime
import Semiont.Internal.Generated.Stored (SessionEndReason(..), sessionEndReason)
import qualified Semiont.Internal.StateValue as State
import qualified Semiont.Retry as Retry
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.Registry.Stored as Stored
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Tokens as Tokens
import qualified Semiont.Transport as Transport
import Semiont.Timing (RetryBudget)
import Semiont.Types (KbTarget(..), StoredSession(..), UserResponse, KbEndpoint(..), HttpEndpoint, DeviceCode, IssuerEndpoints(..), IssuedTokens(..))
import Streaming (Of, Stream)

data SessionOptions = SessionOptions
  { sessionId :: Text
  , sessionKb :: KbTarget
  , sessionStorage :: Storage.SessionStorage
  , sessionInitialToken :: Maybe Text
  , sessionRefresh :: Maybe (Maybe Text -> IO (Maybe Text))
  , sessionValidate :: Maybe (Client.Client -> Text -> IO (Maybe UserResponse))
  , sessionOnAuthFailed :: SessionEndReason -> IO ()
  , sessionOnError :: SessionError -> IO ()
  , sessionWallNow :: IO Scientific
  -- ^ Epoch seconds. Waits use the separate monotonic clock, never this reading.
  }

data OpenedSession = OpenedSession
  { openedSession :: Session
  , closeOpenedSession :: IO ()
  }

data Session = Session
  { configuration :: SessionOptions
  , owner :: Client.Client
  , clock :: Retry.RetryOptions
  , timings :: Timing.Settings
  , life :: Lifetime.Lifetime
  , heldToken :: State.StateValue (Maybe Text)
  , heldUser :: State.StateValue (Maybe UserResponse)
  , initialized :: TMVar (Either SomeException ())
  , commands :: TQueue Command
  , refusing :: TVar (Maybe (TMVar (Either SomeException (Maybe Text))))
  , revision :: TVar Integer
  , unsubscribe :: IO ()
  }

data Command = Refusal (Maybe Text) (TMVar (Either SomeException (Maybe Text))) | Changed Integer (Maybe StoredSession)
data Wake = Scheduled | Unanswered
data Schedule = Schedule (Maybe (Integer, Wake)) Integer

data Renewal = Renewed Text | Unrenewed Bool | Superseded
-- The Bool distinguishes a final refusal (including no remaining grant)
-- from a failure that left the issuer's answer unknown.

id :: Session -> Text
id = sessionId . configuration
kb :: Session -> KbTarget
kb = sessionKb . configuration
client :: Session -> Client.Client
client = owner
token :: Session -> State.StateValue (Maybe Text)
token = heldToken
user :: Session -> State.StateValue (Maybe UserResponse)
user = heldUser
streamState :: Session -> State.StateValue Transport.ConnectionState
streamState = Client.state . owner
errors :: Session -> (Stream (Of TransportError) IO () -> IO result) -> IO result
errors = Transport.errors . Client.transport . owner
ready :: Session -> IO ()
ready session = atomically (readTMVar (initialized session)) >>= either throwIO pure
expiresAt :: Session -> STM (Maybe Scientific)
expiresAt session = (>>= Tokens.tokenExpiry) <$> State.current (token session)

newSession :: Client.Client -> SessionOptions -> Retry.RetryOptions -> Timing.Settings -> IO Session
newSession owned options time settings = do
  initial <- seed options
  shared <- atomically (State.newStateValue initial)
  construct owned options time settings shared

seed :: SessionOptions -> IO (Maybe Text)
seed options = do
  stored <- Stored.storedSession (sessionStorage options) (kbTargetId (sessionKb options))
  now <- sessionWallNow options
  pure $ case sessionInitialToken options of
    Just value -> Just value
    Nothing -> case stored of
      Just value | not (Tokens.isTokenExpired (storedSessionAccess value) now) -> Just (storedSessionAccess value)
      _ -> Nothing

-- | The transport reads the session's actual token cell. Its renewal callback
-- waits for construction, so even a refusal on the first stream uses this
-- session. The returned closer joins both owners, session before client.
fromHttp :: Http.HttpOptions -> SessionOptions -> IO OpenedSession
fromHttp http options = mask $ \restore -> do
  initial <- restore (seed options)
  shared <- atomically (State.newStateValue initial)
  holder <- newEmptyTMVarIO :: IO (TMVar (Either SomeException Session))
  let readToken = atomically (State.current shared)
      refreshRefused refused = do
        current <- readToken
        if current /= Just refused then pure current else do
          session <- atomically (readTMVar holder) >>= either throwIO pure
          refresh session
      actual = http { Http.httpToken=readToken, Http.httpRenewToken=refreshRefused }
  owned <- restore (Client.fromHttp actual)
  outcome <- try (restore (construct owned options (Http.httpTime http) (Http.httpTiming http) shared))
  atomically (putTMVar holder outcome)
  case outcome of
    Left problem -> Client.dispose owned >> throwIO problem
    Right session -> pure (OpenedSession session (dispose session `finally` Client.dispose owned))

-- | Persist an issued grant and own its rotating refresh callback. A person's
-- confirmation, when required, is the validate callback in SessionOptions.
fromIssuedSession :: Http.HttpOptions -> SessionOptions -> StoredSession -> IO OpenedSession
fromIssuedSession http options issued = do
  endpoint <- httpTarget options
  base <- either (\message -> throwIO (SessionError Code.SessionConstructFailed message (kbTargetId (sessionKb options)))) pure
    (Gateway.gatewayUrl endpoint)
  let issuer = Issuer.IssuerOptions (Http.httpClient http) (Http.httpTime http) (Http.httpTiming http)
      storage = sessionStorage options
      identity = kbTargetId (sessionKb options)
      actual = options { sessionInitialToken=Just (storedSessionAccess issued),
        sessionRefresh=Just (\_ -> Issuer.refreshStoredSession issuer storage identity) }
  Stored.storeSession storage identity issued
  opened <- fromHttp http { Http.httpBaseUrl=base } actual
  ready (openedSession opened) `onException` closeOpenedSession opened
  pure opened

signInDevice :: Http.HttpOptions -> SessionOptions -> (DeviceCode -> IO ()) -> IO OpenedSession
signInDevice http options onCode = do
  endpoint <- httpTarget options
  let issuerOptions = Issuer.IssuerOptions (Http.httpClient http) (Http.httpTime http) (Http.httpTiming http)
  (issuer,issued) <- Issuer.signInWithDeviceGrant issuerOptions endpoint onCode
  let stored = StoredSession (issuedTokensAccess issued) Issuer.scriptClientId (issuedTokensRefresh issued)
        (issuerEndpointsRevocation issuer) (issuerEndpointsToken issuer) mempty
  fromIssuedSession http options stored

-- | An account proves itself to its issuer, and the gateway names that account.
-- This factory owns the credential callbacks; its ServiceToken remains borrowed.
signInAgent :: Http.HttpOptions -> SessionOptions -> RetryBudget -> Service.ServiceToken -> IO OpenedSession
signInAgent http options budget service = Retry.retryWithBackoff (Http.httpTime http) budget accepts delay $ do
  endpoint <- httpTarget options
  base <- either (\message -> throwIO (SessionError Code.SessionConstructFailed message (kbTargetId (sessionKb options)))) pure
    (Gateway.gatewayUrl endpoint)
  access <- Service.token service
  refused <- newIORef Nothing
  let validateAgent owned credential = case Client.auth owned of
        Nothing -> throwIO (SessionError Code.SessionConstructFailed "The agent's client has no HTTP identity operation" (kbTargetId (sessionKb options)))
        Just auth -> do
          answer <- trySync (Auth.me auth (Just credential))
          case answer of
            Left failure -> writeIORef refused (Just failure) >> throwIO failure
            Right person -> pure (Just person)
      actual=options { sessionInitialToken=Just access,
        sessionRefresh=Just (\held -> Just <$> maybe (Service.token service) (Service.renew service) held),
        sessionValidate=Just validateAgent }
  opened <- fromHttp http { Http.httpBaseUrl=base } actual
  ready (openedSession opened) `onException` closeOpenedSession opened
  person <- atomically (State.current (user (openedSession opened)))
  case person of
    Just _ -> pure opened
    Nothing -> do
      closeOpenedSession opened
      failure <- readIORef refused
      maybe (throwIO (SessionError Code.SessionAuthFailed "The gateway did not confirm the account" (kbTargetId (sessionKb options)))) throwIO failure
  where
    accepts :: SomeException -> Bool
    accepts failure = case fromException failure of
      Just problem -> transportErrorCode problem/=Code.TransportUnauthorized
        && (httpStatus problem==Nothing || Retry.retryable Retry.Boot (httpStatus problem) Nothing False)
      Nothing -> case fromException failure of
        Just problem -> signInErrorCode problem `elem` [Code.SignInDiscovery,Code.SignInExchange]
          && (signInStatus problem==Nothing || Retry.retryable Retry.Boot (signInStatus problem) Nothing False)
        Nothing -> False
    delay :: SomeException -> Maybe Integer
    delay failure = fromException failure >>= retryAfterMs

httpTarget :: SessionOptions -> IO HttpEndpoint
httpTarget options = case kbTargetEndpoint (sessionKb options) of
  KbEndpointBranch1 endpoint -> pure endpoint
  KbEndpointBranch2 _ -> throwIO (SessionError Code.SessionConstructFailed
    "This sign-in requires an HTTP knowledge base" (kbTargetId (sessionKb options)))

construct :: Client.Client -> SessionOptions -> Retry.RetryOptions -> Timing.Settings
  -> State.StateValue (Maybe Text) -> IO Session
construct owned options time settings shared = mask $ \restore -> do
  lifetime <- Lifetime.newLifetime "Session is closed"
  person <- atomically (State.newStateValue Nothing)
  done <- newEmptyTMVarIO
  queue <- newTQueueIO
  flight <- newTVarIO Nothing
  generation <- newTVarIO 0
  detach <- restore (Storage.subscribe (sessionStorage options) $ \key value ->
    when (key == Stored.sessionKey (kbTargetId (sessionKb options))) $ do
      let parsed = case value of
            Nothing -> Just Nothing
            Just encoded -> either (const Nothing) (Just . Just) (eitherDecodeStrict' (encodeUtf8 encoded))
      forM_ parsed $ \stored -> atomically $ do
        closed <- Lifetime.isClosed lifetime
        unless closed $ do
          modifyTVar' generation (+1)
          version <- readTVar generation
          State.update shared (storedSessionAccess <$> stored)
          when (stored==Nothing) (State.update person Nothing)
          writeTQueue queue (Changed version stored)) `onException` Lifetime.close lifetime
  released <- newTVarIO False
  let detachOnce = do
        first <- atomically $ do
          previous <- readTVar released
          writeTVar released True
          pure (not previous)
        when first (maybe (pure ()) Prelude.id detach)
      session = Session options owned time settings lifetime shared person done queue flight generation detachOnce
      finish = do
        atomically $ do
          let failure = Left (toException (BusRequestError Code.BusRequestClosed "Session is closed" Nothing))
          void (tryPutTMVar done failure)
          pending <- readTVar flight
          mapM_ (\result -> void (tryPutTMVar result failure)) pending
          writeTVar flight Nothing
        unsubscribe session `finally` (atomically (State.complete shared >> State.complete person)
          `finally` Lifetime.close lifetime)
      work = do
        schedule <- newIORef (Schedule Nothing (Timing.reconnectMs settings))
        started <- try (startup session schedule)
        atomically (putTMVar done started)
        either throwIO (const (loop session schedule)) started
  void (Lifetime.start lifetime (restore work `finally` finish))
    `onException` (unsubscribe session `finally` Lifetime.close lifetime)
  pure session

refresh :: Session -> IO (Maybe Text)
refresh session = Lifetime.run (life session) $ do
  result <- atomically $ do
    closed <- Lifetime.isClosed (life session)
    when closed (throwSTM (BusRequestError Code.BusRequestClosed "Session is closed" Nothing))
    active <- readTVar (refusing session)
    case active of
      Just pending -> pure pending
      Nothing -> do
        pending <- newEmptyTMVar
        writeTVar (refusing session) (Just pending)
        expected <- State.current (token session)
        writeTQueue (commands session) (Refusal expected pending)
        pure pending
  atomically (readTMVar result) >>= either throwIO pure

renewer :: Session -> Text -> IO (Maybe Text)
renewer session refused = do
  current <- atomically (State.current (token session))
  if current /= Just refused then pure current else refresh session

loop :: Session -> IORef Schedule -> IO ()
loop session schedule = do
  Schedule timer _ <- readIORef schedule
  next <- case timer of
    Nothing -> Left <$> atomically (readTQueue (commands session))
    Just (due,kind) -> do
      answer <- race (atomically (peekTQueue (commands session))) (Retry.retryWaitUntil (clock session) due)
      case answer of Left _ -> Left <$> atomically (readTQueue (commands session)); Right () -> pure (Right kind)
  case next of
    Left (Refusal expected result) -> do
      answer <- try $ do
        current <- atomically (State.current (token session))
        if current /= expected then pure current else renew session schedule True False
      atomically $ do
        void (tryPutTMVar result answer)
        writeTVar (refusing session) Nothing
      either throwIO (const (pure ())) answer
    Left (Changed version stored) -> do
      current <- readTVarIO (revision session)
      when (current==version) $ do
        clear session schedule
        forM_ stored (scheduleToken session schedule . storedSessionAccess)
    Right kind -> do
      modifyIORef' schedule (\(Schedule _ step) -> Schedule Nothing step)
      ask <- case kind of Scheduled -> pure False; Unanswered -> (==Nothing) <$> atomically (State.current (user session))
      void (renew session schedule ask False)
  loop session schedule

attempt :: Session -> IO Renewal
attempt session = case sessionRefresh (configuration session) of
  Nothing -> pure (Unrenewed True)
  Just action -> do
    version <- readTVarIO (revision session)
    currentAccess <- atomically (State.current (token session))
    outcome <- trySync (action currentAccess)
    current <- readTVarIO (revision session)
    pure $ if current/=version then Superseded else case outcome of
      Right (Just value) -> Renewed value
      Right Nothing -> Unrenewed True
      Left problem -> Unrenewed $ case fromException problem of
        Just failure -> signInErrorCode failure == Code.SignInExchange
          && maybe False (\status -> not (Retry.retryable Retry.Refresh (Just status) Nothing False)) (signInStatus failure)
        Nothing -> False

trySync :: IO value -> IO (Either SomeException value)
trySync action = do
  outcome <- try action
  case outcome of
    Left problem | Just (_ :: SomeAsyncException) <- fromException problem -> throwIO problem
    _ -> pure outcome

startup :: Session -> IORef Schedule -> IO ()
startup session schedule = do
  current <- atomically (State.current (token session))
  mapM_ (scheduleToken session schedule) current
  stored <- Stored.storedSession (sessionStorage (configuration session)) (kbTargetId (kb session))
  case stored of
    Nothing -> forM_ current (\access -> validate session schedule access True True)
    Just value -> do
      now <- sessionWallNow (configuration session)
      let expired = Tokens.isTokenExpired (storedSessionAccess value) now
      if not expired then validate session schedule (storedSessionAccess value) False True else do
        outcome <- attempt session
        case outcome of
          Renewed access -> accept session schedule access >> validate session schedule access True True
          Superseded -> pure ()
          Unrenewed True -> forget session >> clear session schedule
          Unrenewed False -> do
            atomically (State.update (token session) Nothing)
            later session schedule
            report session Code.SessionAuthFailed "The issuer could not renew the stored credential"

validate :: Session -> IORef Schedule -> Text -> Bool -> Bool -> IO ()
validate session schedule access justIssued reportUnreachable = case sessionValidate (configuration session) of
  Nothing -> pure ()
  Just action -> do
    version <- readTVarIO (revision session)
    answer <- trySync (action (client session) access)
    latest <- readTVarIO (revision session)
    current <- atomically (State.current (token session))
    when (current == Just access && latest==version) $ case answer of
      Right person -> atomically (State.update (user session) person)
      Left problem -> case fromException problem of
        Just failure | transportErrorCode failure == Code.TransportUnauthorized ->
          if justIssued then signedOut session schedule Refused Code.SessionCredentialRefused
            else void (renew session schedule True reportUnreachable)
        _ -> when reportUnreachable (report session Code.SessionAuthFailed "The gateway could not confirm the credential")

renew :: Session -> IORef Schedule -> Bool -> Bool -> IO (Maybe Text)
renew session schedule ask reportUnreachable = do
  hadToken <- (/=Nothing) <$> atomically (State.current (token session))
  hadPerson <- (/=Nothing) <$> atomically (State.current (user session))
  outcome <- attempt session
  case outcome of
    Superseded -> pure ()
    Renewed access -> do
      accept session schedule access
      when ask (validate session schedule access True reportUnreachable)
    Unrenewed terminal -> do
      stored <- Stored.storedSession (sessionStorage (configuration session)) (kbTargetId (kb session))
      case stored of
        Nothing | not hadToken && not hadPerson -> atomically (State.update (token session) Nothing) >> clear session schedule
        _ | terminal -> signedOut session schedule Expired Code.SessionRefreshExhausted
        _ -> do
          atomically (State.update (token session) Nothing)
          later session schedule
          report session Code.SessionRefreshExhausted "The issuer could not renew the credential"
  atomically (State.current (token session))

accept :: Session -> IORef Schedule -> Text -> IO ()
accept session schedule access = do
  clear session schedule
  atomically (modifyTVar' (revision session) (+1) >> State.update (token session) (Just access))
  scheduleToken session schedule access

forget :: Session -> IO ()
forget session = do
  Stored.clearStoredSession (sessionStorage (configuration session)) (kbTargetId (kb session))
  atomically (modifyTVar' (revision session) (+1) >> State.update (token session) Nothing >> State.update (user session) Nothing)

signedOut :: Session -> IORef Schedule -> SessionEndReason -> Code.SessionCode -> IO ()
signedOut session schedule reason code = do
  clear session schedule
  forget session
  sessionOnAuthFailed (configuration session) reason
  report session code (case reason of Expired -> "The credential could not be renewed"; Refused -> "The gateway refused a newly issued credential")

report :: Session -> Code.SessionCode -> Text -> IO ()
report session code message = sessionOnError (configuration session) (SessionError code message (kbTargetId (kb session)))

clear :: Session -> IORef Schedule -> IO ()
clear session schedule = writeIORef schedule (Schedule Nothing (Timing.reconnectMs (timings session)))
scheduleToken :: Session -> IORef Schedule -> Text -> IO ()
scheduleToken session schedule access = do
  now <- sessionWallNow (configuration session)
  due <- case Tokens.refreshDelay (timings session) access now of
    Nothing -> pure Nothing
    Just delay -> do
      instant <- Retry.retryNow (clock session)
      pure (Just (instant + ceiling (delay*1000000000),Scheduled))
  modifyIORef' schedule (\(Schedule _ step) -> Schedule due step)
later :: Session -> IORef Schedule -> IO ()
later session schedule = do
  Schedule _ step <- readIORef schedule
  draw <- Retry.retryRandom (clock session)
  unless (draw>=0 && draw<=1) (throwIO Retry.InvalidJitter)
  now <- Retry.retryNow (clock session)
  let wait = ceiling (fromInteger (step*1000000)*(1+toRational draw)/2)
  writeIORef schedule (Schedule (Just (now+wait,Unanswered)) (min (2*step) (Timing.maxReconnectMs (timings session))))

dispose :: Session -> IO ()
dispose session = Lifetime.close (life session) `finally`
  (unsubscribe session `finally` atomically (State.complete (token session) >> State.complete (user session)))
