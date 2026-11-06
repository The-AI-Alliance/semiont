{-# LANGUAGE OverloadedStrings #-}
module FrameCases (frameCases) where

import Control.Concurrent.Async (withAsync, wait)
import Control.Concurrent.STM
import Control.Exception (SomeException, bracket, fromException, try)
import Control.Monad (forM_, unless, when)
import Data.Aeson (Value(..), eitherDecodeStrict', encode, toJSON)
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import Data.Foldable (toList)
import qualified Data.Set as Set
import Data.Text.Encoding (decodeUtf8)
import qualified Semiont.Bus as Bus
import Semiont.Channels hiding (BrowseResourceResult)
import qualified Semiont.Channels as Channel
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (TransportError(..), BusRequestError(..))
import qualified Semiont.Internal.Required as Required
import qualified Semiont.Internal.StreamFrame as Frame
import qualified Semiont.Transport as Transport
import Semiont.Types
import qualified Streaming.Prelude as Stream
import System.FilePath ((</>))
import System.Timeout (timeout)

require :: String -> Bool -> IO ()
require label value = unless value (ioError (userError label))

frameCases :: FilePath -> IO ()
frameCases root = do
  result <- timeout 5000000 (runCases root)
  require "frame cases did not settle their readers and requests" (result == Just ())
  putStrLn "PASS every shared stream frame, typed refusal, destination and pending-request case"

runCases :: FilePath -> IO ()
runCases root = do
  table <- Bytes.readFile (root </> "protocol/specs/src/bus/frame-cases.json") >>= either (ioError . userError) pure . eitherDecodeStrict'
  let member key (Object fields) = maybe (error ("missing frame case member " ++ show key)) id (KM.lookup key fields)
      member _ _ = error "frame case is not an object"
      rows = case member "cases" table of Array values -> toList values; _ -> error "frame cases is not an array"
  forM_ rows $ \row -> do
    fields <- case row of Object fields -> pure fields; _ -> ioError (userError "frame row is not an object")
    text <- case (KM.lookup "data" fields, KM.lookup "frame" fields) of
      (Just (String raw),Nothing) -> pure raw
      (Nothing,Just raw) -> pure (decodeUtf8 (Lazy.toStrict (encode raw)))
      _ -> ioError (userError "frame case must state frame or data")
    let parsed = Frame.readFrame text
        expectedRefusal = KM.lookup "refused" fields == Just (Bool True)
        verify told issue = do
          require "a valid stream frame was refused" expectedRefusal
          require "a frame refusal named the wrong member" (String (Required.member issue) == member "member" row)
          let reason = case Required.reason issue of Required.Lacks -> "lacks"; Required.Malformed -> "malformed"
          require "a frame refusal named the wrong reason" (String reason == member "reason" row)
          require "a frame refusal found the wrong reader" (String told == member "told" row)
        publish input = case parsed of
          Frame.Accepted frame -> Transport.receive input frame
          Frame.Refused refusal -> Transport.receiveRefusal input refusal
          Frame.Rejected _ -> ioError (userError "unnamed frame routed to readers")
    case parsed of
      Frame.Rejected issue -> verify "failure-report" issue
      Frame.Accepted frame | not expectedRefusal ->
        require "a stream frame changed on reading" (toJSON frame == member "frame" row)
      _ -> do
        let raw = member "frame" row
            channel = member "channel" raw
        asked <- newEmptyTMVarIO
        bracket (Transport.newTransport (Transport.TransportOptions "local://frame-cases" (Set.fromList channelNames)
          (\_ -> atomically (putTMVar asked ()) >> pure Nothing) (pure ())))
          (Transport.dispose . fst) $ \(transport,input) -> do
            Transport.setState input Transport.Connecting
            Transport.setState input Transport.Open
            clock <- newTVarIO 0
            let bus = Bus.newBus (Bus.BusOptions (readTVarIO clock)
                  (\deadline -> atomically (readTVar clock >>= check . (>= deadline))) (pure "c-1")) transport
                inspect values = do
                  publish input
                  heard <- Stream.head_ values
                  refusal <- case heard of Just (Bus.Refused value) -> pure value; _ -> ioError (userError "typed reader lost a refused frame")
                  verify "readers" (Bus.fault refusal)
                  require "refusal lost its raw payload" (Transport.refusedPayload refusal == (case raw of Object value -> KM.lookup "payload" value; _ -> Nothing))
                  require "refusal carried the wrong correlation id" (fmap String (Transport.refusedCorrelationId refusal) == KM.lookup "correlationId" fields)
            if channel == String (channelName BeckonFocus)
              then Bus.frames bus BeckonFocus NoScope inspect
              else if channel == String (channelName Channel.BrowseResourceResult)
                then Bus.frames bus Channel.BrowseResourceResult NoScope inspect
                else ioError (userError "unread typed channel in frame cases")
            forM_ (KM.lookup "request" fields) $ \expected -> do
              resource <- either (ioError . userError) pure (mkResourceId "res-1")
              let action = try (Bus.request bus BrowseResourceRequestedOperation (BrowseResourceRequest resource mempty) 100)
                    :: IO (Either SomeException BrowseResourceResult)
              withAsync action $ \pending -> do
                atomically (takeTMVar asked)
                publish input
                when (expected == String "waits") (atomically (writeTVar clock 100000000))
                answer <- wait pending
                case (expected,answer) of
                  (String "fails",Left problem) | Just failure <- fromException problem -> do
                    let issue = Required.Fault (case member "member" row of String value -> value; _ -> error "nontext fault")
                          (case member "reason" row of String "lacks" -> Required.Lacks; String "malformed" -> Required.Malformed; _ -> error "unknown reason")
                    require "request did not fail with its frame refusal" (failure == TransportError Code.TransportError
                      ("a frame on browse:resource-result is not that channel's: " <> Required.faultSaid issue) Nothing Nothing)
                  (String "waits",Left problem) | Just failure <- fromException problem ->
                    require "a reply without a readable correlation id reached the request" (busRequestErrorCode failure == Code.BusRequestTimeout)
                  _ -> ioError (userError "unread request outcome in frame cases")
