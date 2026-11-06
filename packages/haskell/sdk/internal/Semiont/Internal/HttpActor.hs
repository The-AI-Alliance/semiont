{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module Semiont.Internal.HttpActor (runActor) where

import OpenTelemetry.Context.ThreadLocal (getContext)
import Control.Concurrent.Async (Async, cancel, waitCatchSTM)
import Control.Concurrent.STM
import Control.Exception (SomeAsyncException, SomeException(..), catch, finally, fromException, onException, throwIO, try)
import Control.Monad (forM_, unless, void, when)
import Data.Aeson (Result(..), Value(..), fromJSON)
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Char8 as Char8
import Data.Char (toLower, isSpace)
import Data.Foldable (toList)
import Data.Maybe (isNothing)
import qualified Data.Map.Strict as Map
import Data.Sequence (Seq, (|>))
import qualified Data.Sequence as Seq
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Typeable (typeOf)
import Network.HTTP.Client (responseHeaders, responseStatus, responseBody, brRead)
import Network.HTTP.Types (statusCode)
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors
import Semiont.Channels (scopedChannels)
import Semiont.Http.Routes
import Semiont.Internal.Http
import qualified Semiont.Internal.Sse as SSE
import qualified Semiont.Internal.StreamFrame as StreamFrame
import qualified Semiont.Internal.Required as Required
import qualified Semiont.Internal.StateValue as State
import qualified Semiont.Internal.Transport as Transport
import qualified Semiont.Internal.Telemetry as Telemetry
import qualified Semiont.Internal.BusLog as BusLog
import qualified Semiont.Retry as Retry
import qualified Semiont.Timing.Settings as Settings
import Semiont.Transport.Facts (ConnectionState(..))
import Semiont.Types

data Connection = Connection (Async ()) (TMVar (Either HttpFailure ()))

done :: Connection -> STM ()
done (Connection worker _) = void (waitCatchSTM worker)

stop :: Connection -> IO ()
stop (Connection worker _) = cancel worker

runActor :: Http -> IO ()
runActor http = do
  seen <- newTVarIO (Seq.empty :: Seq Text)
  let reportFatal exception@(SomeException cause) = case fromException exception :: Maybe SomeAsyncException of
        Just _ -> throwIO exception
        Nothing -> Transport.reportError (input http) (TransportError Code.TransportError
          ("HTTP stream owner failed (" <> Text.pack (show (typeOf cause)) <> ")") Nothing Nothing)
  loop seen Nothing Nothing (Settings.reconnectMs (httpTiming (options http))) Nothing False
    `catch` reportFatal
    `finally` Transport.dispose (transport http)
  where
    transition next = do
      before <- atomically (State.current (Transport.state (transport http)))
      when (before == Open && next /= Open && next /= Closed) (Transport.setState (input http) Reconnecting)
      when (next == Open && before `elem` [Reconnecting, Degraded, Unauthenticated, Initial])
        (Transport.setState (input http) Connecting)
      Transport.setState (input http) next
    snapshot = atomically $ do
      (_, scopes, pending, _) <- Transport.subscriptions (input http)
      pure (scopes, pending)
    now = Retry.retryNow (httpTime (options http))
    loop seen live retiring cap outage renewedOutage = do
      token <- currentToken http
      (scopes, pending) <- snapshot
      if token == Nothing then do
        forM_ live stop
        forM_ retiring cancel
        transition Unauthenticated
        pause http (Settings.reconnectMs (httpTiming (options http)))
        loop seen Nothing Nothing (Settings.reconnectMs (httpTiming (options http))) Nothing renewedOutage
      else if Set.null (httpGlobalChannels (options http)) && null scopes then do
        forM_ live stop
        forM_ retiring cancel
        case live of Just _ -> transition Reconnecting; Nothing -> pure ()
        atomically $ do
          (_, desired, _, _) <- Transport.subscriptions (input http)
          check (not (null desired))
        loop seen Nothing Nothing cap outage renewedOutage
      else do
        before <- atomically (State.current (Transport.state (transport http)))
        case live of Nothing -> unless (before == Connecting) (transition Connecting); Just _ -> pure ()
        saved <- readTVarIO (positions http)
        let body = BusSubscribeRequest (clientId http) (Just (Set.toAscList (httpGlobalChannels (options http)))) (Just pending)
              (Just [BusSubscribeRequestScopedItem scopedChannels (Map.lookup scope saved) scope | scope <- scopes])
        connection <- connect seen token body
        let awaitOpen = case connection of
              Connection worker opened -> atomically (readTMVar opened `orElse` do
                outcome <- waitCatchSTM worker
                case outcome of
                  Left exception -> throwSTM exception
                  Right () -> throwSTM (HttpFailure (TransportError Code.TransportError "HTTP stream ended before attachment" Nothing Nothing) False))
        outcome <- case live of
          Nothing -> awaitOpen
          Just current -> do
            raced <- raceOwned http awaitOpen (atomically (done current))
            case raced of
              Left opened -> pure opened
              Right () -> transition Reconnecting >> awaitOpen
        case outcome of
          Left problem -> do
            stop connection
            forM_ (httpStatus (failure problem)) (const (Transport.reportError (input http) (failure problem)))
            active <- case live of
              Nothing -> pure Nothing
              Just current -> do
                ended <- atomically ((done current >> pure True) `orElse` pure False)
                pure (if ended then Nothing else live)
            if transportErrorCode (failure problem) == Code.TransportUnauthorized then do
              forM_ active stop
              forM_ retiring cancel
              forM_ token (quarantine http)
              unless renewedOutage (forM_ token (void . renew http))
              transition Unauthenticated
              loop seen Nothing Nothing (Settings.reconnectMs (httpTiming (options http))) outage True
            else do
              case active of Nothing -> transition Reconnecting; Just _ -> pure ()
              started <- maybe now pure outage
              elapsed <- now
              when (isNothing active && elapsed - started >= (Settings.degradedThresholdMs (httpTiming (options http))) * 1000000) (transition Degraded)
              (nextLive, nextOutage) <- recover active cap (retryAfterMs (failure problem)) (if isNothing active then Just started else Nothing)
              loop seen nextLive retiring (min (Settings.maxReconnectMs (httpTiming (options http))) (cap * 2)) nextOutage renewedOutage
          Right () -> do
            forM_ retiring cancel
            draining <- case live of
              Nothing -> pure Nothing
              Just current -> Just <$> spawn http (pause http (Settings.lingerMs (httpTiming (options http))) `finally` stop current)
            transition Open
            let changed = atomically $ do
                  (_, actual, _, _) <- Transport.subscriptions (input http)
                  check (actual /= scopes)
                  pure actual
                waitForChange = do
                  actual <- changed
                  pause http (if any (`notElem` scopes) actual then (Settings.reconnectDebounceMs (httpTiming (options http))) else (Settings.lazyRemoveMs (httpTiming (options http))))
            result <- raceOwned http (atomically (done connection)) waitForChange
            case result of
              Left () -> do
                transition Reconnecting
                started <- now
                _ <- recover Nothing (Settings.reconnectMs (httpTiming (options http))) Nothing (Just started)
                loop seen Nothing draining (min (Settings.maxReconnectMs (httpTiming (options http))) ((Settings.reconnectMs (httpTiming (options http))) * 2)) (Just started) False
              Right () -> loop seen (Just connection) draining (Settings.reconnectMs (httpTiming (options http))) Nothing False

    recover live cap floorDelay outage = do
      draw <- Retry.retryRandom (httpTime (options http))
      unless (draw >= 0 && draw <= 1) (throwIO Retry.InvalidJitter)
      began <- now
      let due = began + 1000000 * max (ceiling (fromInteger cap * (1 + toRational draw) / 2)) (maybe 0 id floorDelay)
          waitUntil = Retry.retryWaitUntil (httpTime (options http))
          withoutLive started = do
            elapsed <- raceOwned http (waitUntil due) (waitUntil (started + (Settings.degradedThresholdMs (httpTiming (options http))) * 1000000))
            case elapsed of Left () -> pure (); Right () -> transition Degraded >> waitUntil due
            pure (Nothing, Just started)
      case live of
        Nothing -> withoutLive (maybe began id outage)
        Just current -> do
          result <- raceOwned http (waitUntil due) (atomically (done current))
          case result of
            Left () -> pure (live, Nothing)
            Right () -> transition Reconnecting >> now >>= withoutLive

    connect seen token body = do
      opened <- newEmptyTMVarIO
      worker <- spawn http $ do
        encoded <- jsonBody SubscribeToBus body
        asked <- request http SubscribeToBus Nothing token encoded
        let consume response = do
              when (statusCode (responseStatus response) /= routeStatus SubscribeToBus)
                (refusal http response >>= throwIO)
              let media = Char8.map toLower . Char8.dropWhileEnd isSpace . Char8.dropWhile isSpace . Char8.takeWhile (/= ';')
              unless (fmap media (lookup "Content-Type" (responseHeaders response)) == Just (routeMediaType SubscribeToBus))
                (throwIO (HttpFailure (TransportError Code.TransportError "HTTP subscribe did not return an event stream" (Just (routeStatus SubscribeToBus)) Nothing) False))
              atomically (putTMVar opened (Right ()))
              readChunks seen SSE.newParser response
        result <- try (openScoped http (Settings.streamOpenTimeoutMs (httpTiming (options http))) asked consume)
        case result of
          Left problem -> atomically (void (tryPutTMVar opened (Left problem)))
          Right () -> pure ()
      pure (Connection worker opened)

    readChunks seen parser response = do
      bytes <- brRead (responseBody response)
      unless (Bytes.null bytes) $ do
        let (next, messages) = SSE.feed parser bytes
        forM_ messages $ \message -> case message of
          SSE.Message event | SSE.eventType event == busEventName -> case StreamFrame.readFrame (SSE.eventData event) of
            StreamFrame.Rejected Nothing issue -> Transport.reportError (input http)
              (TransportError Code.TransportError ("the stream carried what is not a frame: " <> Required.faultSaid issue) Nothing Nothing)
            StreamFrame.Rejected (Just _) _ -> pure ()
            StreamFrame.Accepted frame -> do
              let identity = SSE.assignedId event >>= \value -> if Text.null value then Nothing else Just value
              claimed <- atomically $ do
                queue <- readTVar seen
                closed <- (== Closed) <$> State.current (Transport.state (transport http))
                if closed || maybe False (`elem` toList queue) identity then pure False else do
                  forM_ identity $ \value -> writeTVar seen (trim (queue |> value))
                  pure True
              when claimed $ do
                saved <- Telemetry.withReceived frame (do
                  BusLog.frame (logger http) "RECV" frame
                  context <- getContext
                  atomically $ do
                    closed <- (== Closed) <$> State.current (Transport.state (transport http))
                    if closed then pure Nothing else do
                      Transport.receiveContextSTM (Just context) (input http) frame
                      case (busFrameScope frame, identity) of
                        (Just scope, Just value) | isPosition scope value -> do
                          modifyTVar' (positions http) (Map.insert scope value)
                          pure (Just (scope, value))
                        _ -> pure Nothing)
                  `onException` atomically (forM_ identity $ \value -> modifyTVar' seen (Seq.filter (/= value)))
                forM_ saved (uncurry (httpSavePosition (options http)))
          _ -> pure ()
        readChunks seen next response
    trim queue = let keep = Settings.seenEventIdsCount (httpTiming (options http))
      in if toInteger (Seq.length queue) > keep then Seq.drop (Seq.length queue - fromInteger keep) queue else queue
    isPosition scope value = Text.isPrefixOf (persistedScopePrefix scope) value
      && case fromJSON (String value) :: Result PersistedEventId of Success _ -> True; Error _ -> False
