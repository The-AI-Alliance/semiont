{-# LANGUAGE OverloadedStrings #-}

module Semiont.Internal.Transport
  ( Transport, TransportInput, TransportOptions(..), Frame(..), EventBus
  , newTransport, baseUrl, emit, frames, stream, on, state, errors, isSubscribed
  , subscribeToResource, trackReply, bridgeInto, dispose
  , receiveSTM, receive, setState, subscriptions, reportError, withPendingReply
  , ownAction, raiseTransportError
  , newEventBus, local, events, closeEventBus
  ) where

import Control.Concurrent (ThreadId, myThreadId)
import Control.Concurrent.Async (Async, asyncThreadId, cancel, waitCatch, waitCatchSTM)
import Control.Concurrent.STM
import Control.Exception (SomeAsyncException, SomeException, bracket, catch, finally, fromException, mask, mask_, onException, throwIO, try)
import Control.Monad (unless, void, when)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson (Object, Result(..), Value(..), fromJSON, toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.List (nub)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import OpenTelemetry.Context.ThreadLocal.Propagation (tracedAsync)
import qualified Semiont.Internal.Broadcast as Broadcast
import qualified Semiont.Internal.Delivery as Delivery
import qualified Semiont.Internal.StateValue as State
import Semiont.Internal.Generated.Schemas (schemas)
import Semiont.Internal.Schema (validateProperty)
import Semiont.ErrorCodes hiding (TransportError)
import qualified Semiont.ErrorCodes as Codes
import Semiont.Errors
import Semiont.Transport.Facts
import Semiont.Types (BusFrame(..), BusFramePayload(..), ResourceId, TraceCarrier)
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream

data Frame = Frame { wireFrame :: BusFrame, frameTrace :: Maybe TraceCarrier } deriving (Eq, Show)
newtype EventBus = EventBus (Delivery.Hub Frame) deriving (Eq)
data TransportOptions = TransportOptions
  { transportBaseUrl :: Text
  , receiveChannels :: Set.Set Text
  , sendFrame :: BusFrame -> IO (Maybe Integer)
  , closeDriver :: IO ()
  }
newtype Transport = Transport Runtime
newtype TransportInput = TransportInput Runtime
data Runtime = Runtime
  { options :: TransportOptions
  , received :: Delivery.Hub Frame
  , replies :: Delivery.Replies Frame
  , connection :: State.StateValue ConnectionState
  , failures :: Broadcast.Broadcast TransportError
  , scopes :: TVar (Map.Map ResourceId Integer)
  , tracked :: TVar (Map.Map Text Integer)
  , revision :: TVar Integer
  , bridges :: TVar (Map.Map Integer EventBus)
  , listeners :: TVar (Map.Map Integer (Async ()))
  , nextKey :: TVar Integer
  , closing :: TVar Bool
  , ownedThreads :: TVar (Map.Map ThreadId Integer)
  , closer :: TVar (Maybe ThreadId)
  , closed :: TMVar (Either SomeException ())
  }

frameChannel :: Frame -> Text
frameChannel = busFrameChannel . wireFrame

newTransport :: TransportOptions -> IO (Transport, TransportInput)
newTransport configuration = atomically $ do
  runtime <- Runtime configuration <$> Delivery.newHub frameChannel
    <*> Delivery.newReplies frameChannel (busFrameCorrelationId . wireFrame)
    <*> State.newStateValue Initial <*> Broadcast.newEvents
    <*> newTVar Map.empty <*> newTVar Map.empty <*> newTVar 0
    <*> newTVar Map.empty <*> newTVar Map.empty <*> newTVar 0
    <*> newTVar False <*> newTVar Map.empty <*> newTVar Nothing <*> newEmptyTMVar
  pure (Transport runtime, TransportInput runtime)

baseUrl :: Transport -> Text
baseUrl (Transport runtime) = transportBaseUrl (options runtime)

state :: Transport -> State.StateValue ConnectionState
state (Transport runtime) = connection runtime

isSubscribed :: Transport -> Text -> Bool
isSubscribed (Transport runtime) channel = Set.member channel (receiveChannels (options runtime))

ensureOpenLifetime :: Runtime -> STM ()
ensureOpenLifetime runtime = do
  over <- readTVar (closing runtime)
  when over (throwSTM (BusRequestError BusRequestClosed "transport is closed" Nothing))

emit :: Transport -> BusFrame -> IO (Maybe Integer)
emit (Transport runtime) frame = do
  atomically (ensureOpenLifetime runtime)
  case fromJSON (toJSON frame) :: Result BusFrame of
    Error _ -> raiseTransportError (Transport runtime) (TransportError Codes.TransportError "invalid bus envelope" Nothing Nothing)
    Success _ -> pure ()
  sendFrame (options runtime) frame `catch` \failure -> do
    raiseTransportError (Transport runtime) failure

raiseTransportError :: Transport -> TransportError -> IO result
raiseTransportError (Transport runtime) failure = atomically (Broadcast.publish (failures runtime) failure) >> throwIO failure

fromReader :: Broadcast.Subscription value -> Stream (Of value) IO ()
fromReader reader = do
  value <- liftIO (atomically (Broadcast.next reader))
  case value of Nothing -> pure (); Just item -> Stream.yield item >> fromReader reader

frames :: Transport -> Text -> (Stream (Of Frame) IO () -> IO result) -> IO result
frames transport@(Transport runtime) channel consume = do
  unless (isSubscribed transport channel) (throwIO (BusRequestError BusRequestUnsubscribed "transport does not receive this channel" Nothing))
  Delivery.withFrames (received runtime) channel (consume . fromReader)

stream :: Transport -> Text -> (Stream (Of Object) IO () -> IO result) -> IO result
stream transport channel consume = frames transport channel (consume . Stream.map (busFramePayloadAdditionalProperties . busFramePayload . wireFrame))

errors :: Transport -> (Stream (Of TransportError) IO () -> IO result) -> IO result
errors (Transport runtime) consume = Broadcast.withSubscription (failures runtime) (consume . fromReader)

freshKey :: Runtime -> STM Integer
freshKey runtime = do
  key <- readTVar (nextKey runtime)
  writeTVar (nextKey runtime) (key + 1)
  pure key

on :: Transport -> Text -> (Object -> IO ()) -> IO (IO ())
on transport@(Transport runtime) channel callback = mask $ \restore -> do
  unless (isSubscribed transport channel) (throwIO (BusRequestError BusRequestUnsubscribed "transport does not receive this channel" Nothing))
  key <- atomically (ensureOpenLifetime runtime >> freshKey runtime)
  start <- newEmptyTMVarIO
  ready <- newEmptyTMVarIO
  active <- newTVarIO True
  let pump values = do
        listening <- readTVarIO active
        when listening $ do
          item <- Stream.next values
          case item of
            Left () -> pure ()
            Right (frame, rest) -> callback (busFramePayloadAdditionalProperties (busFramePayload (wireFrame frame))) >> pump rest
  let work = (atomically (takeTMVar start) >> frames transport channel (\values -> do
        atomically (putTMVar ready ())
        restore (pump values)))
        `catch` callbackFailure
      callbackFailure :: SomeException -> IO ()
      callbackFailure exception = case fromException exception :: Maybe SomeAsyncException of
        Just _ -> throwIO exception
        Nothing -> atomically (Broadcast.publish (failures runtime) (TransportError Codes.TransportError "transport callback failed" Nothing Nothing))
  worker <- tracedAsync (work `finally` atomically (modifyTVar' (listeners runtime) (Map.delete key)))
  accepted <- atomically $ do
    over <- readTVar (closing runtime)
    if over then pure False else do
      modifyTVar' (listeners runtime) (Map.insert key worker)
      putTMVar start ()
      pure True
  let release = do
        atomically (writeTVar active False)
        thread <- myThreadId
        unless (thread == asyncThreadId worker) (cancel worker)
  if not accepted then cancel worker >> throwIO (BusRequestError BusRequestClosed "transport is closed" Nothing) else do
    let ended = do
          outcome <- waitCatchSTM worker
          over <- readTVar (closing runtime)
          if over then throwSTM (BusRequestError BusRequestClosed "transport closed during attachment" Nothing)
            else either throwSTM (const (throwSTM (BusRequestError BusRequestClosed "listener ended before attachment" Nothing))) outcome
    restore (atomically (takeTMVar ready `orElse` ended))
      `onException` release
    pure release

subscriptions :: TransportInput -> STM (Integer, [ResourceId], [Text], Bool)
subscriptions (TransportInput runtime) = (,,,) <$> readTVar (revision runtime)
  <*> (Map.keys <$> readTVar (scopes runtime)) <*> (Map.keys <$> readTVar (tracked runtime)) <*> readTVar (closing runtime)

hold :: Ord key => Runtime -> TVar (Map.Map key Integer) -> key -> IO (IO ())
hold runtime cell key = mask_ $ do
  active <- atomically $ do
    ensureOpenLifetime runtime
    counts <- readTVar cell
    let count = Map.findWithDefault 0 key counts
    writeTVar cell (Map.insert key (count + 1) counts)
    when (count == 0) (modifyTVar' (revision runtime) (+ 1))
    newTVar True
  pure $ atomically $ do
    held <- readTVar active
    when held $ do
      writeTVar active False
      counts <- readTVar cell
      case Map.lookup key counts of
        Just count | count > 1 -> writeTVar cell (Map.insert key (count - 1) counts)
        Just _ -> writeTVar cell (Map.delete key counts) >> modifyTVar' (revision runtime) (+ 1)
        Nothing -> pure ()

subscribeToResource :: Transport -> ResourceId -> IO (IO ())
subscribeToResource (Transport runtime) = hold runtime (scopes runtime)

trackReply :: Transport -> Text -> IO (IO ())
trackReply transport@(Transport runtime) correlation = do
  case validateProperty schemas "BusFrame" "correlationId" (String correlation) of
    Left _ -> raiseTransportError transport (TransportError Codes.TransportError "invalid correlation id" Nothing Nothing)
    Right () -> hold runtime (tracked runtime) correlation

withPendingReply :: Transport -> Text -> Set.Set Text -> (STM (Maybe Frame) -> IO result) -> IO result
withPendingReply transport@(Transport runtime) correlation channels action =
  (bracket (trackReply transport correlation) id $ \_ ->
    Delivery.withReply (replies runtime) correlation channels (action . Delivery.awaitReply))
    `catch` \Delivery.CorrelationConflict -> raiseTransportError transport
      (TransportError Codes.TransportConflict "correlation id is already pending" Nothing Nothing)

newEventBus :: IO EventBus
newEventBus = atomically $ EventBus <$> Delivery.newHub frameChannel

local :: EventBus -> Frame -> IO ()
local (EventBus hub) = atomically . Delivery.publish hub

events :: EventBus -> Text -> (Stream (Of Frame) IO () -> IO result) -> IO result
events (EventBus hub) channel consume = Delivery.withFrames hub channel (consume . fromReader)

closeEventBus :: EventBus -> IO ()
closeEventBus (EventBus hub) = atomically (Delivery.closeHub hub)

bridgeInto :: Transport -> EventBus -> IO (IO ())
bridgeInto (Transport runtime) bus = mask_ $ do
  key <- atomically $ do
    ensureOpenLifetime runtime
    key <- freshKey runtime
    modifyTVar' (bridges runtime) (Map.insert key bus)
    pure key
  pure (atomically (modifyTVar' (bridges runtime) (Map.delete key)))

receive :: TransportInput -> BusFrame -> IO ()
receive source = atomically . receiveSTM source

receiveSTM :: TransportInput -> BusFrame -> STM ()
receiveSTM (TransportInput runtime) raw = do
  over <- readTVar (closing runtime)
  unless over $ do
    let payload = busFramePayloadAdditionalProperties (busFramePayload raw)
        carrier = case KM.lookup (Key.fromText traceField) payload of
          Nothing -> Nothing
          Just value -> case fromJSON value of Success value' -> Just value'; Error _ -> Nothing
        frame = Frame (raw { busFramePayload = BusFramePayload (KM.delete (Key.fromText traceField) payload) }) carrier
    targets <- nub . Map.elems <$> readTVar (bridges runtime)
    Delivery.deliver (received runtime : [hub | EventBus hub <- targets]) (replies runtime) frame

setState :: TransportInput -> ConnectionState -> IO ()
setState (TransportInput runtime) next = do
  if next == Closed then dispose (Transport runtime) else atomically $ do
    before <- State.current (connection runtime)
    unless (next == before || next `elem` connectionTransitions before)
      (throwSTM (TransportError Codes.TransportError "invalid connection-state transition" Nothing Nothing))
    when (next /= before) (State.update (connection runtime) next)

reportError :: TransportInput -> TransportError -> IO ()
reportError (TransportInput runtime) = atomically . Broadcast.publish (failures runtime)

dispose :: Transport -> IO ()
dispose (Transport runtime) = mask $ \restore -> do
  thread <- myThreadId
  (startClose, owned) <- atomically $ do
    already <- readTVar (closing runtime)
    active <- Map.elems <$> readTVar (listeners runtime)
    threads <- readTVar (ownedThreads runtime)
    owner <- readTVar (closer runtime)
    unless already $ do
      writeTVar (closing runtime) True
      State.update (connection runtime) Closed
      State.complete (connection runtime)
      Delivery.closeHub (received runtime)
      Delivery.closeReplies (replies runtime)
      writeTVar (scopes runtime) Map.empty
      writeTVar (tracked runtime) Map.empty
      writeTVar (bridges runtime) Map.empty
      modifyTVar' (revision runtime) (+ 1)
    pure (not already, Map.member thread threads || owner == Just thread || any ((== thread) . asyncThreadId) active)
  when startClose $ void $ tracedAsync $ do
    identity <- myThreadId
    atomically (writeTVar (closer runtime) (Just identity))
    outcome <- try $ closeDriver (options runtime) `finally` do
      active <- atomically (Map.elems <$> readTVar (listeners runtime))
      mapM_ cancel active
      mapM_ waitCatch active
    atomically $ do
      case outcome of
        Left exception -> case fromException exception of Just failure -> Broadcast.publish (failures runtime) failure; Nothing -> pure ()
        Right () -> pure ()
      Broadcast.close (failures runtime)
      putTMVar (closed runtime) outcome
  unless owned $ restore (atomically (readTMVar (closed runtime))) >>= either throwIO pure

ownAction :: Transport -> IO result -> IO result
ownAction (Transport runtime) action = do
  thread <- myThreadId
  bracket
    (atomically (ensureOpenLifetime runtime >> modifyTVar' (ownedThreads runtime) (Map.insertWith (+) thread 1)))
    (\() -> atomically (modifyTVar' (ownedThreads runtime) (Map.update (\count -> if count > 1 then Just (count - 1) else Nothing) thread)))
    (const action)
