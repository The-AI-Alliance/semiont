{-# LANGUAGE GADTs, OverloadedStrings #-}
module Semiont.Internal.Local (signal, signalWithCorrelation, events) where

import Control.Concurrent.STM (STM, throwSTM)
import Data.Aeson (Value(..))
import Data.Text (Text)
import qualified Data.Text as T
import Semiont.Channels
import qualified Semiont.ErrorCodes as Codes
import Semiont.Errors (TransportError(..))
import Semiont.Internal.Bus (Heard, decoded)
import qualified Semiont.Internal.Transport as Local
import Semiont.Types (BusFrame(..), BusFramePayload(..), ResourceId)
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream

scopeOf :: ScopeArg scope -> Maybe ResourceId
scopeOf NoScope = Nothing
scopeOf (InScope resource) = Just resource

signal :: Local.EventBus -> Channel scope payload -> payload -> ScopeArg scope -> STM ()
signal bus channel payload scope = signalWithCorrelation bus channel payload scope Nothing

signalWithCorrelation :: Local.EventBus -> Channel scope payload -> payload -> ScopeArg scope -> Maybe Text -> STM ()
signalWithCorrelation bus channel payload scope correlation = case encodePayload channel payload of
  Object fields -> case decodePayload channel (Object fields) of
    Right _ -> Local.localSTM bus (Local.Frame (BusFrame (channelName channel) correlation (BusFramePayload fields) (scopeOf scope)) Nothing)
    Left reason -> invalid (T.pack reason)
  _ -> invalid "local payload is not an object"
  where invalid :: Text -> STM ()
        invalid reason = throwSTM (TransportError Codes.TransportError reason Nothing Nothing)

events :: Local.EventBus -> Channel scope payload -> ScopeArg scope
  -> (Stream (Of (Heard payload)) IO () -> IO result) -> IO result
events bus channel scope consume = Local.events bus (channelName channel) $ \frames ->
  consume (Stream.map (decoded channel) (Stream.filter matches frames))
  where matches frame = maybe True (\resource -> busFrameScope (Local.wireFrame frame) == Just resource) (scopeOf scope)
