{-# LANGUAGE DataKinds, GADTs, OverloadedStrings #-}

module Semiont.Internal.Bus
  ( Bus(..), BusOptions(..), newBus, emit, frames, request, requestDelivered
  , Delivered(..), FrameRefusal(..), Heard(..), decoded
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
import qualified Data.Set as Set
import OpenTelemetry.Context.ThreadLocal.Propagation (propagateContext)
import Semiont.Channels
import Semiont.ErrorCodes hiding (TransportError)
import qualified Semiont.ErrorCodes as Codes
import Semiont.Errors
import Semiont.Internal.Generated.Schemas (schemas)
import Semiont.Internal.Required (missingRequired)
import qualified Semiont.Internal.StateValue as State
import qualified Semiont.Internal.Transport as Transport
import Semiont.Transport.Facts (ConnectionState(..), userField)
import Semiont.Types (BusFrame(..), BusFramePayload(..), CommandError(..), ResourceId, UserId)
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
data FrameRefusal = FrameRefusal
  { refusedFrame :: Transport.Frame
  , lacks :: Maybe Text
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

decoded :: Channel scope payload -> Transport.Frame -> Heard payload
decoded channel frame =
  let raw = busFramePayloadAdditionalProperties (busFramePayload (Transport.wireFrame frame))
      identity = case KM.lookup (Key.fromText userField) raw of
        Nothing -> Right Nothing
        Just value -> case fromJSON value of Success user -> Right (Just user); Error _ -> Left ()
  in case (decodePayload channel (Object raw), identity) of
    (Right payload, Right user) -> Heard (Delivered payload frame user)
    _ -> Refused (FrameRefusal frame (missingRequired schemas (channelSchema channel) (Object raw)))

frames :: Bus -> Channel scope payload -> ScopeArg scope -> (Stream (Of (Heard payload)) IO () -> IO result) -> IO result
frames (Bus _ transport) channel scope consume = Transport.frames transport (channelName channel) $ \wire ->
  let values = Stream.map (decoded channel) (Stream.filter (\frame -> maybe True (\resource -> busFrameScope (Transport.wireFrame frame) == Just resource) (scopeValue scope)) wire)
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
          frame <- maybe (throwIO (BusRequestError BusRequestClosed "transport closed before reply" Nothing)) pure reply
          if busFrameChannel (Transport.wireFrame frame) == channelName result then
            case decoded result frame of
              Heard delivered -> pure delivered
              Refused refusal -> rejectReply refusalMode transport (TransportError Codes.TransportError
                ("reply payload is not its channel's" <> maybe "" (": missing " <>) (lacks refusal)) Nothing Nothing)
          else do
            let fields = busFramePayloadAdditionalProperties (busFramePayload (Transport.wireFrame frame))
            code <- case KM.lookup "code" fields of
              Nothing -> pure Nothing
              Just (String value) -> pure (Just value)
              _ -> rejectReply refusalMode transport (TransportError Codes.TransportError "failure reply has a non-string code" Nothing Nothing)
            case fromJSON (Object (KM.delete "code" fields)) :: Result CommandError of
              Error _ -> rejectReply refusalMode transport (TransportError Codes.TransportError "failure reply is not its channel's" Nothing Nothing)
              Success answered -> throwIO (BusRequestError (busRequestCodeFromWire code) (commandErrorMessage answered) (Just fields))
  inheritedWork <- propagateContext work
  inheritedWait <- propagateContext (requestWaitUntil options (now + timeoutMs * 1000000))
  outcome <- race inheritedWork (race inheritedWait
    (atomically (State.current (Transport.state transport) >>= check . (== Closed))))
  case outcome of
    Left value -> pure value
    Right (Left ()) -> timedOut
    Right (Right ()) -> throwIO (BusRequestError BusRequestClosed "transport closed during request" Nothing)
