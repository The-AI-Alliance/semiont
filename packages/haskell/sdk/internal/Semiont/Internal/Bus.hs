{-# LANGUAGE DataKinds, GADTs, OverloadedStrings #-}

module Semiont.Internal.Bus
  ( Bus(..), BusOptions(..), newBus, emit, frames, request, requestDelivered
  , Delivered(..), FrameRefusal(..), Heard(..), Carried(..), Fault(..), FaultReason(..), decoded
  , replyChannelsFor, unsubscribed, persistedEventTypes
  ) where

import Control.Concurrent.Async (race)
import Control.Concurrent.STM
import Control.Exception (bracket, throwIO)
import Control.Monad (forM_, unless, when)
import Data.Aeson (Result(..), Value(..), fromJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.List (nub)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Data.Set as Set
import OpenTelemetry.Context.ThreadLocal.Propagation (propagateContext)
import Semiont.Channels
import Semiont.ErrorCodes hiding (TransportError)
import qualified Semiont.ErrorCodes as Codes
import Semiont.Errors
import Semiont.Internal.Required (Fault(..), FaultReason(..))
import qualified Semiont.Internal.Generated.OperationFailure as OperationFailure
import qualified Semiont.Internal.Required as Required
import qualified Semiont.Internal.StateValue as State
import qualified Semiont.Internal.Transport as Transport
import Semiont.Internal.Transport (FrameRefusal(..), Carried(..))
import Semiont.Transport.Facts (ConnectionState(..), userField)
import Semiont.Types (BusFrame(..), BusFramePayload(..), ResourceId, UserId)
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream

data BusOptions = BusOptions
  { requestNow :: IO Integer
  -- ^ Monotonic nanoseconds in the wait's coordinate system.
  , requestWaitUntil :: Integer -> IO ()
  -- ^ Interruptible wait to an absolute monotonic nanosecond deadline.
  , nextCorrelationId :: IO Text
  -- ^ A fresh unique id for every request on the transport, including settled requests.
  }
data Bus = Bus BusOptions Transport.Transport
data Delivered payload = Delivered
  { deliveredPayload :: payload
  , deliveredFrame :: Transport.Frame
  , emittedBy :: Maybe UserId
  } deriving (Eq, Show)
data Heard payload = Heard (Delivered payload) | Refused FrameRefusal deriving (Eq, Show)

newBus :: BusOptions -> Transport.Transport -> Bus
newBus = Bus

scopeValue :: ScopeArg scope -> Maybe ResourceId
scopeValue NoScope = Nothing
scopeValue (InScope resource) = Just resource

emit :: Bus -> Channel scope payload -> payload -> ScopeArg scope -> Maybe Text -> IO (Maybe Integer)
emit (Bus _ transport) channel payload scope correlation = case encodePayload channel payload of
  Object fields -> case decodePayload channel (Object fields) of
    Left _ -> Transport.raiseTransportError transport (TransportError Codes.TransportError "outgoing payload is not its channel's" Nothing Nothing)
    Right _ -> Transport.emit transport (BusFrame (channelName channel) correlation (BusFramePayload fields) (scopeValue scope))
  _ -> Transport.raiseTransportError transport (TransportError Codes.TransportError "channel payload is not an object" Nothing Nothing)

decoded :: Channel scope payload -> Transport.Carried -> Heard payload
decoded _ (Transport.FrameRejected refusal) = Refused refusal
decoded channel (Transport.Arrived frame) =
  let raw = busFramePayloadAdditionalProperties (busFramePayload (Transport.wireFrame frame))
      identity = case KM.lookup (Key.fromText userField) raw of
        Nothing -> Right Nothing
        Just value -> case fromJSON value of Success user -> Right (Just user); Error _ -> Left ()
  in case (decodePayload channel (Object raw), identity) of
    (Right payload, Right user) -> Heard (Delivered payload frame user)
    _ -> let issue = case Required.faultChannel (channelName channel) (Object raw) of
               Just value -> value
               Nothing -> case identity of Left () -> Fault userField Malformed; Right _ -> Required.undecoded
             way = if Required.member issue == "" then "payload" else "payload." <> Required.member issue
         in Refused (FrameRefusal (channelName channel) (Just (Object raw)) (busFrameScope (Transport.wireFrame frame))
              (busFrameCorrelationId (Transport.wireFrame frame)) (issue { Required.member = way }))

frames :: Bus -> Channel scope payload -> ScopeArg scope -> (Stream (Of (Heard payload)) IO () -> IO result) -> IO result
frames (Bus _ transport) channel scope consume = Transport.frames transport (channelName channel) $ \wire ->
  let values = Stream.map (decoded channel) (Stream.filter (\frame -> maybe True (\resource -> Transport.carriedScope frame == Just resource) (scopeValue scope)) wire)
  in case scope of
    NoScope -> consume values
    InScope resource -> bracket (Transport.subscribeToResource transport resource) id (const (consume values))

unsubscribed :: Text -> BusRequestError
unsubscribed channel = BusRequestError BusRequestUnsubscribed ("transport does not receive " <> channel) Nothing

replyChannelsFor :: [SomeOperation] -> [Text]
replyChannelsFor operations = nub (concatMap names operations)
  where names (SomeOperation operation) = let (_, result, failure) = operationChannels operation in [channelName result, channelName failure]

request :: Bus -> Operation input output failure -> input -> Integer -> IO output
request bus operation input timeoutMs = deliveredPayload <$> requestReply PublishRefusal bus operation input timeoutMs

requestDelivered :: Bus -> Operation input output failure -> input -> Integer -> IO (Delivered output)
requestDelivered = requestReply ReturnRefusal

payloadRefusalSaid :: FrameRefusal -> Text
payloadRefusalSaid refusal = "a payload on " <> refusedChannel refusal <> " is not that channel's: " <>
  Required.faultSaid ((fault refusal) { Required.member = if Required.member (fault refusal) == "payload" then "" else Text.drop 8 (Required.member (fault refusal)) })

data ReplyRefusal = PublishRefusal | ReturnRefusal

rejectReply :: ReplyRefusal -> Transport.Transport -> TransportError -> IO result
rejectReply PublishRefusal transport = Transport.raiseTransportError transport
rejectReply ReturnRefusal _ = throwIO

requestReply :: ReplyRefusal -> Bus -> Operation input output failure -> input -> Integer -> IO (Delivered output)
requestReply refusalMode bus@(Bus options transport) operation input timeoutMs = do
  let (asked, result, failure) = operationChannels operation
      replyChannels = [channelName result, channelName failure]
      timedOut = throwIO (BusRequestError BusRequestTimeout "bus request deadline expired" Nothing)
  forM_ replyChannels $ \channel -> unless (Transport.isSubscribed transport channel) (throwIO (unsubscribed channel))
  connectionBefore <- atomically (State.current (Transport.state transport))
  when (connectionBefore == Closed) (throwIO (BusRequestError BusRequestClosed "transport is closed" Nothing))
  now <- requestNow options
  when (timeoutMs <= 0) timedOut
  let work = do
        atomically $ do
          connection <- State.current (Transport.state transport)
          case connection of
            Open -> pure ()
            Closed -> throwSTM (BusRequestError BusRequestClosed "transport closed before emit" Nothing)
            _ -> retry
        correlation <- nextCorrelationId options
        Transport.withPendingReply transport correlation (Set.fromList replyChannels) $ \awaitReply -> do
          _ <- emit bus asked input NoScope (Just correlation)
          reply <- atomically awaitReply
          carried <- maybe (throwIO (BusRequestError BusRequestClosed "transport closed before reply" Nothing)) pure reply
          frame <- case carried of
            Transport.Arrived value -> pure value
            Transport.FrameRejected refusal -> rejectReply refusalMode transport
              (TransportError Codes.TransportError (Transport.refusalSaid refusal) Nothing Nothing)
          if busFrameChannel (Transport.wireFrame frame) == channelName result then
            case decoded result (Transport.Arrived frame) of
              Heard delivered -> pure delivered
              Refused refusal -> rejectReply refusalMode transport (TransportError Codes.TransportError
                (payloadRefusalSaid refusal) Nothing Nothing)
          else do
            -- A failure is held to its channel's shape before it is read, as a result is: one with a
            -- fault is refused, naming the fault, and one without words is never given any. The
            -- table holds the code to no list, so the typed failure, whose code is closed, is read
            -- without it, and the code is classified on its own: one the wire does not list is a
            -- rejection in the failure's own words.
            let wireFrame = Transport.wireFrame frame
                fields = busFramePayloadAdditionalProperties (busFramePayload wireFrame)
                refuse issue = rejectReply refusalMode transport (TransportError Codes.TransportError
                  ("a payload on " <> channelName failure <> " is not that channel's: " <> Required.faultSaid issue) Nothing Nothing)
                code = case KM.lookup "code" fields of Just (String value) -> Just value; _ -> Nothing
                diagnostic = frame { Transport.wireFrame = wireFrame { busFramePayload = BusFramePayload (KM.delete "code" fields) } }
            case Required.faultChannel (channelName failure) (Object fields) of
              Just issue -> refuse issue
              Nothing -> case decoded failure (Transport.Arrived diagnostic) of
                Refused _ -> refuse Required.undecoded
                Heard delivered -> throwIO (BusRequestError (busRequestCodeFromWire code)
                  (OperationFailure.message operation (deliveredPayload delivered)) (Just fields))
  inheritedWork <- propagateContext work
  inheritedWait <- propagateContext (requestWaitUntil options (now + timeoutMs * 1000000))
  outcome <- race inheritedWork (race inheritedWait
    (atomically (State.current (Transport.state transport) >>= check . (== Closed))))
  case outcome of
    Left value -> pure value
    Right (Left ()) -> timedOut
    Right (Right ()) -> throwIO (BusRequestError BusRequestClosed "transport closed during request" Nothing)
