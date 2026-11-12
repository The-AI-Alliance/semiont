{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
-- | One connection's token and confirmed person. Disposal ends the session's
-- work and observations; the client remains owned by whoever constructed it.
-- What went wrong, the session's own errors and its transport's failures, is
-- said once each on its one errors stream, in the order met.
module Semiont.Session
  ( Session, SessionOptions(..), OpenedSession(..), SessionEndReason(..)
  , newSession, fromHttp, fromIssuedSession, fromKeptSession, signInDevice, signInAgent, signOut, id, kb, client, token, user, streamState, errors, ready
  , expiresAt, refresh, dispose
  ) where

import Prelude hiding (id)
import qualified Prelude
import Control.Concurrent.Async (race)
import Control.Concurrent.MVar (MVar, newMVar, modifyMVar, modifyMVar_)
import Control.Concurrent.STM
import Control.Exception (SomeException, SomeAsyncException, displayException, fromException, throwIO, try, mask, onException, finally, toException)
import Control.Monad (forM_, unless, void, when)
import Control.Monad.IO.Class (liftIO)
import Data.Maybe (isJust)
import Data.IORef
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Semiont.Client as Client
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors
import qualified Semiont.Http as Http
import qualified Semiont.Internal.Issuer as Issuer
import qualified Semiont.ServiceToken as Service
import qualified Semiont.Auth as Auth
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Internal.Broadcast as Broadcast
import Semiont.Internal.Kept (personKey)
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.Internal.StateValue as State
import qualified Semiont.Retry as Retry
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.SignIn as SignIn
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Tokens as Tokens
import qualified Semiont.Transport as Transport
import qualified Semiont.Internal.Transport as Transport (relayErrors)
import Semiont.Timing (RetryBudget, errorsKeptForFirstReaderCount)
import Semiont.Types (KbTarget(..), StoredSession(..), UserResponse(..), userIdValue, KbEndpoint(..), HttpEndpoint, DeviceCode, IssuerEndpoints(..), IssuedTokens(..), SessionEndReason(..))
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream

data SessionOptions = SessionOptions
  { sessionId :: Text
  , sessionKb :: KbTarget
  , sessionKept :: SignIn.KeptSignIn
  , sessionInitialToken :: Maybe Text
  , sessionRefresh :: Maybe (Maybe Text -> IO (Maybe Text))
  , sessionValidate :: Maybe (Client.Client -> Text -> IO (Maybe UserResponse))
  , sessionOnAuthFailed :: SessionEndReason -> IO ()
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
  , renewing :: TVar (Maybe Text)
  -- ^ Handed to each renewal: the token held, expired or not, the one found
  -- stored at the start though expired, or, once a renewal that got no answer
  -- left none held, the one that renewal was for.
  , heldUser :: State.StateValue (Maybe UserResponse)
  , initialized :: TMVar (Either SomeException ())
  , commands :: TQueue Command
  , refusing :: TVar (Maybe (TMVar (Either SomeException (Maybe Text))))
  , revision :: TVar Integer
  , unsubscribe :: IO ()
  , said :: Broadcast.Broadcast (Either SessionError TransportError)
  , stopRelaying :: STM ()
  -- ^ Stops saying the transport's failures on the session's stream, where
  -- each is said within the transaction that reports it.
  }

data Command = Refusal (Maybe Text) (TMVar (Either SomeException (Maybe Text))) | Changed Integer (Maybe StoredSession)
data Wake = Scheduled | Unanswered
data Schedule = Schedule (Maybe (Integer, Wake)) Integer

data Renewal = Renewed Text | NoGrant | Unrenewed Bool | Superseded
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
-- | What went wrong, each said once, in the order met: the session's own
-- errors and its transport's failures, each said within the transaction
-- that reports it. The first reader is given first the latest
-- 'errorsKeptForFirstReaderCount' said before it came, in that order, the
-- oldest beyond them dropped. The stream ends when the session ends; for a
-- session this module opens with its client, once that client's closing
-- flush is done and what its transport's close met is said.
errors :: Session -> (Stream (Of (Either SessionError TransportError)) IO () -> IO result) -> IO result
errors session consume = Broadcast.withSubscription (said session) $ \reader ->
  let reading = do
        value <- liftIO (atomically (Broadcast.next reader))
        case value of Nothing -> pure (); Just next -> Stream.yield next >> reading
  in consume reading
ready :: Session -> IO ()
ready session = atomically (readTMVar (initialized session)) >>= either throwIO pure
expiresAt :: Session -> STM (Maybe Scientific)
expiresAt session = (>>= Tokens.tokenExpiry) <$> State.current (token session)

newSession :: Client.Client -> SessionOptions -> Retry.RetryOptions -> Timing.Settings -> IO Session
newSession owned options time settings = do
  initial <- SignIn.held (sessionKept options) >>= seed options
  shared <- atomically (State.newStateValue initial)
  stream <- atomically newSaid
  construct owned options time settings shared stream

-- | A session's errors stream, of which the latest
-- 'errorsKeptForFirstReaderCount' said before anyone reads are kept for the
-- first reader.
newSaid :: STM (Broadcast.Broadcast (Either SessionError TransportError))
newSaid = Broadcast.newKeptEvents (fromInteger errorsKeptForFirstReaderCount)

seed :: SessionOptions -> Maybe StoredSession -> IO (Maybe Text)
seed options stored = do
  now <- sessionWallNow options
  pure $ case sessionInitialToken options of
    Just value -> Just value
    Nothing -> case stored of
      Just value | not (Tokens.isTokenExpired (storedSessionAccess value) now) -> Just (storedSessionAccess value)
      _ -> Nothing

-- | The transport reads the session's actual token cell. Its renewal callback
-- waits for construction, so even a refusal on the first stream uses this
-- session. The returned closer closes the client, its closing flush done, and
-- only then ends the session: its work, and its errors once what the flush
-- met is said.
--
-- Given a storage, the session has its client keep its persisted queries'
-- values, and its stream's places, there for the person the kept sign-in
-- names (session/stored.json's per-person keys): from the start when the
-- sign-in names them already, or, for a session that asks who its token is,
-- once the gateway has named them and the sign-in has recorded it. A sign-in
-- that names nobody, of a session that does not ask, keeps for nobody. Each
-- write is checked and made
-- as one step, only while the sign-in names that person: once a write finds
-- it forgotten, naming nobody or another person, the client writes nothing
-- more there. A sign-in that cannot be read for that check, or cannot record
-- the person, is said once as session.keep-failed, and nothing more is kept.
-- Each write the storage refuses is said as session.save-refused, and stays
-- owed. The session's own forget of its sign-in waits for a write being made.
fromHttp :: Http.HttpOptions -> Maybe Storage.SessionStorage -> SessionOptions -> IO OpenedSession
fromHttp http storage options = mask $ \restore -> do
  stored <- restore (SignIn.held (sessionKept options))
  initial <- restore (seed options stored)
  shared <- atomically (State.newStateValue initial)
  stream <- atomically newSaid
  holder <- newEmptyTMVarIO :: IO (TMVar (Either SomeException Session))
  let readToken = atomically (State.current shared)
      refreshRefused refused = do
        session <- atomically (readTMVar holder) >>= either throwIO pure
        refresh session (Just refused)
      actual = http { Http.httpToken=readToken, Http.httpRenewToken=refreshRefused }
  owned <- restore (Client.fromHttp actual Nothing)
  keeps <- case storage of
    Just kept -> do
      keeper <- Keeper kept (sessionKept options) owned (kbTargetId (sessionKb options)) ((*1000) <$> sessionWallNow options) stream
        <$> newMVar Unnamed
      restore (mapM_ (attach keeper) (stored >>= storedSessionPersonKey)) `onException` Client.dispose owned
      pure (Just (keeper, options { sessionKept=forgetting keeper, sessionValidate=recording keeper <$> sessionValidate options }))
    Nothing -> pure Nothing
  outcome <- try (restore (construct owned (maybe options snd keeps) (Http.httpTime http) (Http.httpTiming http) shared stream))
  atomically (putTMVar holder outcome)
  let stopped = mapM_ (stop . fst) keeps
  case outcome of
    Left problem -> (Client.dispose owned `finally` stopped) >> throwIO problem
    Right session -> pure (OpenedSession session (Client.dispose owned `finally` (halt session
      `finally` (stopped `finally` (closeTold session `finally` silence session)))))

-- | What a session's client keeps for the person its sign-in names.
data Keeper = Keeper
  { keeperStorage :: Storage.SessionStorage
  , keeperSignIn :: SignIn.KeptSignIn
  , keeperClient :: Client.Client
  , keeperKbId :: Text
  , keeperWallNowMs :: IO Scientific
  , keeperSaid :: Broadcast.Broadcast (Either SessionError TransportError)
  , keeperState :: MVar Keeping
  -- ^ Held across each write's check and the write, and by every change.
  }

-- | Nothing kept yet; kept for one person; or nothing kept from now on.
data Keeping = Unnamed | Named Text | Over

-- | The client keeps for @person@ from now on, each persisted query beginning
-- with what was kept for them. Nothing is attached twice, or once over.
attach :: Keeper -> Text -> IO ()
attach keeper person = modifyMVar_ (keeperState keeper) $ \state -> case state of
  Unnamed -> do
    Client.keepIn (keeperClient keeper)
      (Client.CachePersistence (whileNamed keeper) (keeperKbId keeper) person (keeperWallNowMs keeper))
    pure (Named person)
  _ -> pure state

-- | The keeper's storage: each write made only while the sign-in names the
-- person kept for. A dropped update answers from what is stored, unchanged.
whileNamed :: Keeper -> Storage.SessionStorage
whileNamed keeper = Storage.SessionStorage (Storage.get underlying)
  (\key value -> made keeper (Storage.set underlying key value) (pure ()))
  (Storage.delete underlying)
  (\key change -> made keeper (Storage.update underlying key change) (snd . change <$> Storage.get underlying key))
  (Storage.subscribe underlying)
  where underlying = keeperStorage keeper

data Write result = Made result | Refused SomeException | Unreadable SomeException | Dropped

made :: Keeper -> IO result -> IO result -> IO result
made keeper write dropped = do
  outcome <- modifyMVar (keeperState keeper) $ \state -> case state of
    Named person -> do
      held <- trySync (SignIn.held (keeperSignIn keeper))
      case held of
        Left problem -> pure (Over, Unreadable problem)
        Right current | (current >>= storedSessionPersonKey) == Just person ->
          (,) state . either Refused Made <$> trySync write
        Right _ -> pure (Over, Dropped)
    _ -> pure (state, Dropped)
  case outcome of
    Made result -> pure result
    Refused problem -> do
      tell keeper Code.SessionSaveRefused ("The storage refused a write of what the client keeps: " <> Text.pack (displayException problem))
      throwIO problem
    Unreadable problem -> do
      tell keeper Code.SessionKeepFailed ("The sign-in could not be read before the client saved what it keeps: " <> Text.pack (displayException problem))
      dropped
    Dropped -> dropped

-- | Validate, and, once the gateway has said who a token is, that person
-- recorded on the sign-in and what was kept for them attached, before
-- validate's caller hears the answer.
recording :: Keeper -> (Client.Client -> Text -> IO (Maybe UserResponse)) -> Client.Client -> Text -> IO (Maybe UserResponse)
recording keeper validateWith owned access = do
  answer <- validateWith owned access
  forM_ answer $ \person -> do
    let named = personKey (userIdValue (userResponseDid person))
    recorded <- trySync (SignIn.recordPersonKey (keeperSignIn keeper) access named)
    case recorded of
      Right True -> attach keeper named
      Right False -> pure ()
      Left problem -> do
        ended <- modifyMVar (keeperState keeper) $ \state -> pure $ case state of Over -> (state, False); _ -> (Over, True)
        when ended $ tell keeper Code.SessionKeepFailed
          ("The sign-in could not record the person the gateway named: " <> Text.pack (displayException problem))
  pure answer

-- | The session's sign-in, whose forget stops what the client keeps first.
forgetting :: Keeper -> SignIn.KeptSignIn
forgetting keeper = (keeperSignIn keeper) { SignIn.forget = stop keeper >> SignIn.forget (keeperSignIn keeper) }

-- | Nothing more is kept, once a write being made is made.
stop :: Keeper -> IO ()
stop keeper = modifyMVar_ (keeperState keeper) (const (pure Over))

tell :: Keeper -> Code.SessionCode -> Text -> IO ()
tell keeper code message = atomically (Broadcast.publish (keeperSaid keeper) (Left (SessionError code message (keeperKbId keeper))))

-- | Persist an issued grant and own its rotating refresh callback. A person's
-- confirmation, when required, is the validate callback in SessionOptions.
fromIssuedSession :: Http.HttpOptions -> Maybe Storage.SessionStorage -> SessionOptions -> StoredSession -> IO OpenedSession
fromIssuedSession http storage options issued = do
  SignIn.keep (sessionKept options) issued
  openKept http storage options (Just (storedSessionAccess issued))

-- | Open the actual kept grant, renewing it only when due or refused. An
-- absent grant opens a signed-out session without manufacturing credentials.
fromKeptSession :: Http.HttpOptions -> Maybe Storage.SessionStorage -> SessionOptions -> IO OpenedSession
fromKeptSession http storage options = openKept http storage options Nothing

openKept :: Http.HttpOptions -> Maybe Storage.SessionStorage -> SessionOptions -> Maybe Text -> IO OpenedSession
openKept http storage options initial = do
  endpoint <- httpTarget options
  base <- either (\message -> throwIO (SessionError Code.SessionConstructFailed message (kbTargetId (sessionKb options)))) pure
    (Gateway.gatewayUrl endpoint)
  let issuer = Issuer.IssuerOptions (Http.httpClient http) (Http.httpTime http) (Http.httpTiming http)
      kept = sessionKept options
      actual = options { sessionInitialToken=initial,
        sessionRefresh=Just (\holding -> Issuer.refreshSession issuer kept holding (sessionWallNow options)) }
  opened <- fromHttp http { Http.httpBaseUrl=base } storage actual
  ready (openedSession opened) `onException` closeOpenedSession opened
  pure opened

-- | Signs out of a kept sign-in: its refresh token is revoked at the issuer where the sign-in names a revocation
-- endpoint, and the sign-in is forgotten however that went. Whether the issuer revoked it.
signOut :: Http.HttpOptions -> SignIn.KeptSignIn -> IO Bool
signOut http kept = do
  held <- SignIn.held kept
  revoked <- maybe (pure False) (Issuer.revokeStored (Issuer.IssuerOptions (Http.httpClient http) (Http.httpTime http) (Http.httpTiming http))) held
  SignIn.forget kept
  pure revoked

signInDevice :: Http.HttpOptions -> Maybe Storage.SessionStorage -> SessionOptions -> (DeviceCode -> IO ()) -> IO OpenedSession
signInDevice http storage options onCode = do
  endpoint <- httpTarget options
  let issuerOptions = Issuer.IssuerOptions (Http.httpClient http) (Http.httpTime http) (Http.httpTiming http)
  (issuer,issued) <- Issuer.signInWithDeviceGrant issuerOptions endpoint onCode
  let stored = StoredSession (issuedTokensAccess issued) Issuer.scriptClientId Nothing (issuedTokensRefresh issued)
        (issuerEndpointsRevocation issuer) (issuerEndpointsToken issuer) mempty
  fromIssuedSession http storage options stored

-- | An account proves itself to its issuer, and the gateway names that account.
-- This factory owns the credential callbacks; its ServiceToken remains borrowed.
-- Its sign-in is the session's own, and names no person, so it keeps nothing.
signInAgent :: Http.HttpOptions -> SessionOptions -> RetryBudget -> Service.ServiceToken -> IO OpenedSession
signInAgent http options budget service = Retry.retryWithBackoff (Http.httpTime http) budget accepts delay $ do
  endpoint <- httpTarget options
  base <- either (\message -> throwIO (SessionError Code.SessionConstructFailed message (kbTargetId (sessionKb options)))) pure
    (Gateway.gatewayUrl endpoint)
  access <- Service.token service
  ephemeral <- SignIn.newMemorySignIn
  refused <- newIORef Nothing
  let validateAgent owned credential = case Client.auth owned of
        Nothing -> throwIO (SessionError Code.SessionConstructFailed "The agent's client has no HTTP identity operation" (kbTargetId (sessionKb options)))
        Just auth -> do
          answer <- trySync (Auth.me auth (Just credential))
          case answer of
            Left failure -> writeIORef refused (Just failure) >> throwIO failure
            Right person -> pure (Just person)
      actual=options { sessionKept=ephemeral, sessionInitialToken=Just access,
        sessionRefresh=Just (\held -> Just <$> maybe (Service.token service) (Service.renew service) held),
        sessionValidate=Just validateAgent }
  opened <- fromHttp http { Http.httpBaseUrl=base } Nothing actual
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
  -> State.StateValue (Maybe Text) -> Broadcast.Broadcast (Either SessionError TransportError) -> IO Session
construct owned options time settings shared stream = mask $ \restore -> do
  lifetime <- Lifetime.newLifetime "Session is closed"
  person <- atomically (State.newStateValue Nothing)
  handed <- newTVarIO Nothing
  done <- newEmptyTMVarIO
  queue <- newTQueueIO
  flight <- newTVarIO Nothing
  generation <- newTVarIO 0
  detach <- restore (SignIn.subscribe (sessionKept options) $ \stored -> atomically $ do
    closed <- Lifetime.isClosed lifetime
    unless closed $ do
      modifyTVar' generation (+1)
      version <- readTVar generation
      State.update shared (storedSessionAccess <$> stored)
      writeTVar handed Nothing
      when (stored==Nothing) (State.update person Nothing)
      writeTQueue queue (Changed version stored)) `onException` Lifetime.close lifetime
  released <- newTVarIO False
  let detachOnce = do
        first <- atomically $ do
          previous <- readTVar released
          writeTVar released True
          pure (not previous)
        when first (maybe (pure ()) Prelude.id detach)
  unrelay <- atomically (Transport.relayErrors (Client.transport owned) (Broadcast.publish stream . Right))
  let session = Session options owned time settings lifetime shared handed person done queue flight generation detachOnce stream unrelay
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
    `onException` (unsubscribe session `finally` Lifetime.close lifetime `finally` atomically unrelay)
  pure session

-- | Refusal of an already replaced token returns the held token immediately,
-- in the same transaction that chooses whether a renewal must be queued.
-- Nothing requests a renewal without naming a refused token.
refresh :: Session -> Maybe Text -> IO (Maybe Text)
refresh session refused = Lifetime.run (life session) $ do
  answer <- atomically $ do
    closed <- Lifetime.isClosed (life session)
    when closed (throwSTM (BusRequestError Code.BusRequestClosed "Session is closed" Nothing))
    current <- State.current (token session)
    if isJust refused && refused/=current then pure (Left current) else do
      active <- readTVar (refusing session)
      pending <- case active of
        Just waiting -> pure waiting
        Nothing -> do
          waiting <- newEmptyTMVar
          writeTVar (refusing session) (Just waiting)
          writeTQueue (commands session) (Refusal current waiting)
          pure waiting
      pure (Right pending)
  case answer of
    Left current -> pure current
    Right pending -> atomically (readTMVar pending) >>= either throwIO pure

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
  Nothing -> pure NoGrant
  Just action -> do
    version <- readTVarIO (revision session)
    renewed <- atomically $ do
      current <- State.current (token session)
      maybe (readTVar (renewing session)) (pure . Just) current
    outcome <- trySync (action renewed)
    current <- readTVarIO (revision session)
    pure $ if current/=version then Superseded else case outcome of
      Right (Just value) -> Renewed value
      Right Nothing -> NoGrant
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
  stored <- SignIn.held (sessionKept (configuration session))
  case stored of
    Nothing -> forM_ current (\access -> validate session schedule access True True)
    Just value -> do
      now <- sessionWallNow (configuration session)
      let expired = Tokens.isTokenExpired (storedSessionAccess value) now
      if not expired then validate session schedule (storedSessionAccess value) False True else do
        atomically (writeTVar (renewing session) (Just (storedSessionAccess value)))
        outcome <- attempt session
        case outcome of
          Renewed access -> accept session schedule access >> validate session schedule access True True
          Superseded -> pure ()
          NoGrant -> forget session >> clear session schedule
          Unrenewed True -> forget session >> clear session schedule
          Unrenewed False -> do
            withhold session
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
          if justIssued then signedOut session schedule SessionEndReasonRefused Code.SessionCredentialRefused
            else void (renew session schedule True reportUnreachable)
        _ -> when reportUnreachable (report session Code.SessionAuthFailed "The gateway could not confirm the credential")

renew :: Session -> IORef Schedule -> Bool -> Bool -> IO (Maybe Text)
renew session schedule ask reportUnreachable = do
  hadToken <- (/=Nothing) <$> atomically (State.current (token session))
  hadPerson <- (/=Nothing) <$> atomically (State.current (user session))
  outcome <- attempt session
  case outcome of
    Superseded -> pure ()
    NoGrant -> do
      kept <- trySync (SignIn.held (sessionKept (configuration session)))
      case kept of
        Left _ -> unanswered
        Right Nothing -> do
          atomically (State.update (token session) Nothing >> State.update (user session) Nothing
            >> writeTVar (renewing session) Nothing)
          clear session schedule
        Right (Just _) -> signedOut session schedule SessionEndReasonExpired Code.SessionRefreshExhausted
    Renewed access -> do
      accept session schedule access
      when ask (validate session schedule access True reportUnreachable)
    Unrenewed terminal -> do
      stored <- trySync (SignIn.held (sessionKept (configuration session)))
      case stored of
        Left _ -> unanswered
        Right Nothing | not hadToken && not hadPerson -> do
          atomically (State.update (token session) Nothing >> writeTVar (renewing session) Nothing)
          clear session schedule
        _ | terminal -> signedOut session schedule SessionEndReasonExpired Code.SessionRefreshExhausted
        _ -> unanswered
  atomically (State.current (token session))
  where
    unanswered = do
      withhold session
      later session schedule
      report session Code.SessionRefreshExhausted "The issuer could not renew the credential"

-- | A renewal got no answer: no token is held, and the next renewal is for
-- the one this was for.
withhold :: Session -> IO ()
withhold session = atomically $ do
  current <- State.current (token session)
  forM_ current (writeTVar (renewing session) . Just)
  State.update (token session) Nothing

accept :: Session -> IORef Schedule -> Text -> IO ()
accept session schedule access = do
  clear session schedule
  atomically (modifyTVar' (revision session) (+1) >> State.update (token session) (Just access))
  scheduleToken session schedule access

forget :: Session -> IO ()
forget session = do
  SignIn.forget (sessionKept (configuration session))
  atomically (modifyTVar' (revision session) (+1) >> State.update (token session) Nothing >> State.update (user session) Nothing
    >> writeTVar (renewing session) Nothing)

signedOut :: Session -> IORef Schedule -> SessionEndReason -> Code.SessionCode -> IO ()
signedOut session schedule reason code = do
  clear session schedule
  forget session
  sessionOnAuthFailed (configuration session) reason
  report session code (case reason of SessionEndReasonExpired -> "The credential could not be renewed"; SessionEndReasonRefused -> "The gateway refused a newly issued credential")

report :: Session -> Code.SessionCode -> Text -> IO ()
report session code message = atomically (Broadcast.publish (said session) (Left (SessionError code message (kbTargetId (kb session)))))

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

-- | Ends the session's work, observations and errors stream. The client
-- stays its owner's: closed first, what its transport said, its close's
-- among it, is said before the errors end; still open, the errors end at once.
dispose :: Session -> IO ()
dispose session = halt session `finally` (closeTold session `finally` silence session)

halt :: Session -> IO ()
halt session = Lifetime.close (life session) `finally`
  (unsubscribe session `finally` atomically (State.complete (token session) >> State.complete (user session)))

-- | Once the client's transport is closed, waits until its failures end:
-- until its close has told what it met, which is then said on the session's
-- stream.
closeTold :: Session -> IO ()
closeTold session = do
  closed <- atomically ((== Transport.Closed) <$> State.current (streamState session))
  when closed (Transport.errors (Client.transport (client session)) Stream.effects)

-- | Says nothing more: the transport's failures are relayed no more, and the
-- errors stream ends, in one transaction.
silence :: Session -> IO ()
silence session = atomically (stopRelaying session >> Broadcast.close (said session))
