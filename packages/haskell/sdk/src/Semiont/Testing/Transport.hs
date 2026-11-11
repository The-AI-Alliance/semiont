{-# LANGUAGE GADTs, OverloadedStrings #-}
-- | A real native carrier over scripted answers and faults. Unscripted
-- operations fail by name; a lost reply still consumes its queued answer.
module Semiont.Testing.Transport
  ( FaultAction(..), FaultyTransport, RequestLogEntry(..), Respond
  , newFaultyTransport, carrier, queueReply, refuseWhen, requestLog, deliver
  , retryKeyOf, refuseUnscriptedOperation
  ) where

import Control.Concurrent.STM
import Control.Exception (throwIO)
import Control.Monad (forM_, when)
import Data.Aeson (Object, Value(..))
import Data.Foldable (toList)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.Map.Strict as Map
import Data.Set (Set)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Data.Set as Set
import Data.Text.Encoding (decodeUtf8)
import qualified Semiont.Channels as Channels
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (TransportError(..))
import qualified Semiont.Internal.Cache as Canonical
import qualified Semiont.Internal.StateTasks as Tasks
import Semiont.Internal.Generated.Schemas (schemas)
import Semiont.Internal.Generated.Testing
import Semiont.Retry (RetryOptions(..))
import qualified Semiont.Transport as Transport
import Semiont.Transport.Facts (traceField,userField)
import Semiont.Types

retryKeyOf :: Text -> Object -> Text
retryKeyOf channel payload=channel<>" "<>decodeUtf8 (Lazy.toStrict (Canonical.canonical (Object
  (KM.delete (Key.fromText traceField) (KM.delete (Key.fromText userField) payload)))))
refuseUnscriptedOperation :: Respond
refuseUnscriptedOperation channel _=throwIO (TransportError Code.TransportError ("No response scripted for bus operation "<>channel) Nothing Nothing)

-- | Carries the global channels it is given, @Semiont.Channels.globalChannels@
-- for a full client, and the resource-scoped channels in the scopes it holds,
-- as the HTTP transport does: it delivers a frame on no other.
newFaultyTransport :: RetryOptions -> [FaultAction] -> Respond -> Set Text -> IO FaultyTransport
newFaultyTransport clock schedule respond channels=do
  forM_ schedule $ \action -> case action of
    Delay ms -> when (ms<0) (ioError (userError "fault delay must be nonnegative"))
    Deliver -> pure ()
    DropReply -> pure ()
    DuplicateReply -> pure ()
    RejectEmit -> pure ()
  tasks <- Tasks.newTasks "scripted transport is closed"
  entries <- newTVarIO []
  replies <- newTVarIO Map.empty
  refusal <- newTVarIO (\_ _ -> pure Nothing)
  inputCell <- newEmptyTMVarIO
  let scoped=Set.fromList Channels.scopedChannels
      carries input name scope
        | Set.member name channels=pure True
        | Set.member name scoped=case scope of
            Nothing->pure False
            Just resource->atomically ((\(_,held,_,_)->resource `elem` held) <$> Transport.subscriptions input)
        | otherwise=pure False
      arriving input frame=do
        carried <- carries input (busFrameChannel frame) (busFrameScope frame)
        when carried (Transport.receive input frame)
      choose index=case schedule of []->Deliver; first:rest->(first:rest) !! (index `mod` length schedule)
      send frame=do
        let name=busFrameChannel frame
            payload=busFramePayloadAdditionalProperties (busFramePayload frame)
            operations=[Channels.SomeOperation operation|Channels.SomeOperation operation<-Channels.allOperations
              ,let (request,_,_)=Channels.operationChannels operation,Channels.channelName request==name]
        input <- atomically (readTMVar inputCell)
        case operations of
          []->arriving input frame
          [Channels.SomeOperation operation]->do
            action <- atomically $ do
              logged <- readTVar entries
              let action=choose (length logged)
              writeTVar entries (logged++[RequestLogEntry name action (busFrameCorrelationId frame) (retryKeyOf name payload) payload])
              pure action
            when (action==RejectEmit) (throwIO (TransportError Code.TransportError ("Scripted emit rejected for "<>name) Nothing Nothing))
            refused <- readTVarIO refusal >>= (\answer -> answer name payload)
            let (_,success,failure)=Channels.operationChannels operation
            (channel,answer) <- case refused of
              Just reason->pure (Channels.channelName failure,reason)
              Nothing->do
                queued <- atomically $ do
                  allReplies <- readTVar replies
                  case Map.findWithDefault [] name allReplies of
                    []->pure Nothing
                    next:rest->writeTVar replies (Map.insert name rest allReplies) >> pure (Just next)
                response <- maybe (respond name payload) pure queued
                envelope <- successPayload (Channels.channelSchema success) payload response
                case Channels.decodePayload success (Object envelope) of
                  Left diagnostic->throwIO (TransportError Code.TransportError ("Scripted response is not its channel's: "<>name<>" "<>Text.pack diagnostic) Nothing Nothing)
                  Right _->pure ()
                pure (Channels.channelName success,envelope)
            arriving input frame
            let arrive copies = Tasks.fork tasks $ forM_ [1..copies::Int] $ \_ ->
                  arriving input (BusFrame channel (busFrameCorrelationId frame) (BusFramePayload answer) Nothing)
            case action of
              DropReply -> pure ()
              Deliver -> arrive 1
              DuplicateReply -> arrive 2
              Delay ms -> Tasks.fork tasks $ do
                now <- retryNow clock
                retryWaitUntil clock (now+ms*1000000)
                arriving input (BusFrame channel (busFrameCorrelationId frame) (BusFramePayload answer) Nothing)
              RejectEmit -> ioError (userError "rejected emit reached reply delivery")
          _->ioError (userError "duplicate generated bus operation")
        pure (Just 1)
  (over,input) <- Transport.newTransport (Transport.TransportOptions "faulty://simulator" (Set.union channels scoped) send (Tasks.dispose tasks))
  atomically (putTMVar inputCell input)
  Transport.setState input Transport.Connecting
  Transport.setState input Transport.Open
  pure (FaultyTransport over
    (\name values->atomically (modifyTVar' replies (Map.insertWith (flip (++)) name values)))
    (atomically . writeTVar refusal) (readTVarIO entries)
    (\carried -> do
      heard <- carries input (Transport.carriedChannel carried) (Transport.carriedScope carried)
      when heard $ case carried of
        Transport.Arrived frame -> Transport.receive input (Transport.wireFrame frame)
        Transport.FrameRejected refusalValue -> Transport.receiveRefusal input refusalValue))

successPayload :: Text -> Object -> Maybe Value -> IO Object
successPayload name asked response=do
  schema <- maybe (ioError (userError "missing generated scripted-reply schema")) pure (Map.lookup name schemas)
  case schema of
    Object fields->do
      required <- case KM.lookup "required" fields of
        Just (Array names)->traverse (\value -> case value of String key->pure (Key.fromText key); _->ioError (userError "invalid required reply name")) names
        Nothing->pure mempty
        _->ioError (userError "invalid required reply vocabulary")
      named <- traverse (\key -> if key=="response" then pure Nothing else
        maybe (ioError (userError "scripted reply names a field its request did not state")) (pure . Just . (key,)) (KM.lookup key asked)) required
      pure (KM.fromList [pair|Just pair<-toList named] <> maybe mempty (KM.singleton "response") response)
    _->ioError (userError "scripted reply schema is not an object")
