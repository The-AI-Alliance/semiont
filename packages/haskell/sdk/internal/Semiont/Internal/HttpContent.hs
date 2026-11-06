{-# LANGUAGE GADTs, OverloadedStrings #-}
module Semiont.Internal.HttpContent (newContent) where

import Control.Concurrent.STM
import Control.Exception (bracket_, throwIO)
import Control.Monad (unless, when)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson (Value(..), encode, eitherDecodeStrict', toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import Data.Char (ord)
import Data.Int (Int64)
import Numeric (showHex)
import Data.IORef
import qualified Data.Text as Text
import qualified Data.UUID.Types as UUID
import Data.Text.Encoding (encodeUtf8, decodeUtf8With)
import Data.Text.Encoding.Error (lenientDecode)
import Network.HTTP.Client (RequestBody(..), responseBody, responseHeaders, brRead, brConsume)
import qualified Semiont.Content as Content
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors
import Semiont.Http.Routes
import Semiont.Internal.Http
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.Internal.Telemetry as Telemetry
import OpenTelemetry.Attributes (toAttribute)
import qualified OpenTelemetry.Trace.Core as Trace
import qualified Semiont.Timing.Settings as Settings
import Semiont.Types
import qualified Streaming.Prelude as Stream

newContent :: Http -> IO Content.ContentTransport
newContent http = do
  life <- Lifetime.newLifetime "HTTP transport is closed"
  let owned :: IO result -> IO result
      owned = Lifetime.run life
      stream :: Bool -> ResourceId -> (Text.Text -> Stream.Stream (Stream.Of Bytes.ByteString) IO () -> IO result) -> IO result
      stream streaming resource consume = owned $ report http $ Telemetry.withSpan Trace.Client "content.get"
        (("resource.id", toAttribute (resourceIdValue resource)) : [("content.stream", toAttribute True) | streaming]) $ exchange http GetResourceRepresentation (Just resource) (pure (RequestBodyBS Bytes.empty)) Nothing False [] $ \response -> do
        media <- maybe (throwIO (TransportError Code.TransportError "Content response has no media type" Nothing Nothing)) pure
          (lookup "Content-Type" (responseHeaders response))
        active <- newTVarIO True
        let chunks = do
              bytes <- liftIO $ do
                available <- atomically ((&&) <$> readTVar active <*> (not <$> Lifetime.isClosed life))
                unless available (throwIO (TransportError Code.TransportError "Content reader is outside its response scope" Nothing Nothing))
                brRead (responseBody response)
              unless (Bytes.null bytes) (Stream.yield bytes >> chunks)
        bracket_ (pure ()) (atomically (writeTVar active False)) (consume (decodeUtf8With lenientDecode media) chunks)
      upload metadata source progress = owned $ report http $ do
        high <- newIORef (0 :: Integer)
        Telemetry.withUpload (resourceUploadMetadataFormat metadata) (maybe (readIORef high) (pure . toInteger) (Content.bodyLength source)) $ do
          _ <- checked metadata
          when (maybe False (< 0) (Content.bodyLength source))
            (throwIO (TransportError Code.TransportBadRequest "Negative upload length" Nothing Nothing))
          key <- UUID.toText <$> httpNewId (options http)
          boundary <- UUID.toText <$> httpNewId (options http)
          unless (Text.all (\c -> c >= ' ' && c <= '~') (resourceUploadMetadataFormat metadata) && not (Text.null (resourceUploadMetadataFormat metadata)))
            (throwIO (TransportError Code.TransportBadRequest "Invalid multipart header value" Nothing Nothing))
          let quoted = encodeUtf8 . Text.concatMap (\c -> if c < ' ' || c `elem` ['\DEL', '\r', '\n', '\\', '\"', '%']
                then let hex = showHex (ord c) "" in "%" <> Text.pack (if length hex == 1 then '0' : hex else hex) else Text.singleton c)
              marker = encodeUtf8 boundary
              part name value = "--" <> marker <> "\r\nContent-Disposition: form-data; name=\"" <> quoted name <> "\"\r\n\r\n" <> value <> "\r\n"
          fields <- case toJSON metadata of Object fields -> pure fields; _ -> throwIO (TransportError Code.TransportBadRequest "Upload metadata is not an object" Nothing Nothing)
          when (KM.member "file" fields) (throwIO (TransportError Code.TransportBadRequest "Upload metadata includes the file part" Nothing Nothing))
          let prefix = Bytes.concat [part (Key.toText name) (case value of String text -> encodeUtf8 text; _ -> Lazy.toStrict (encode value)) | (name,value) <- KM.toList fields]
                <> "--" <> marker <> "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" <> quoted (resourceUploadMetadataName metadata)
                <> "\"\r\nContent-Type: " <> encodeUtf8 (resourceUploadMetadataFormat metadata) <> "\r\n\r\n"
              suffix = "\r\n--" <> marker <> "--\r\n"
              total = maybe 0 fromIntegral (Content.bodyLength source)
          when (maybe False (\size -> toInteger size + toInteger (Bytes.length prefix + Bytes.length suffix) > toInteger (maxBound :: Int64)) (Content.bodyLength source))
            (throwIO (TransportError Code.TransportBadRequest "Upload length exceeds the HTTP body's range" Nothing Nothing))
          progress (Content.UploadProgress 0 total)
          let give consume = Content.openBody source $ \popper -> do
                stage <- newIORef (0 :: Int)
                count <- newIORef (0 :: Integer)
                let next = do
                      step <- readIORef stage
                      case step of
                        0 -> writeIORef stage 1 >> pure prefix
                        1 -> do
                          chunk <- popper
                          if Bytes.null chunk then do
                            actual <- readIORef count
                            when (Content.bodyLength source /= Nothing && actual /= total)
                              (throwIO (TransportError Code.TransportBadRequest "Upload length differs from its source" Nothing Nothing))
                            writeIORef stage 2
                            pure suffix
                          else do
                            actual <- atomicModifyIORef' count (\n -> let value = n + fromIntegral (Bytes.length chunk) in (value,value))
                            when (Content.bodyLength source /= Nothing && actual > total)
                              (throwIO (TransportError Code.TransportBadRequest "Upload length differs from its source" Nothing Nothing))
                            previous <- readIORef high
                            when (actual > previous) (writeIORef high actual >> progress (Content.UploadProgress actual total))
                            pure chunk
                        _ -> pure Bytes.empty
                consume next
              body = case Content.bodyLength source of
                Nothing -> RequestBodyStreamChunked give
                Just size -> RequestBodyStream (size + fromIntegral (Bytes.length prefix + Bytes.length suffix)) give
          let uploadRoute = UploadResource :: HttpRoute ResourceUpload CreateResourceResponse
          media <- case routeRequestMediaType uploadRoute of
            Just value | value == "multipart/form-data" -> pure value
            _ -> throwIO (TransportError Code.TransportBadRequest "Upload route no longer accepts multipart" Nothing Nothing)
          exchange http uploadRoute Nothing (pure body) (Just key) True [("Content-Type", media <> "; boundary=" <> marker)] $ \response -> do
            bytes <- deadline http (Settings.httpRequestTimeoutMs (httpTiming (options http))) (Bytes.concat <$> brConsume (responseBody response))
            either (const (throwIO (TransportError Code.TransportError "Upload answer is not its declared schema" Nothing Nothing)))
              (pure . createResourceResponseResourceId) (eitherDecodeStrict' bytes)
  pure Content.ContentTransport
    { Content.putBinary = upload
    , Content.getBinaryStream = stream True
    , Content.getBinary = \resource -> stream False resource (\media chunks -> deadline http (Settings.httpRequestTimeoutMs (httpTiming (options http))) (Content.BinaryContent media . Bytes.concat <$> Stream.toList_ chunks))
    , Content.getResourceGraph = \resource -> owned (Telemetry.withSpan Trace.Client "content.get_graph" [("resource.id", toAttribute (resourceIdValue resource))] (json http GetResourceJsonLd (Just resource) ()))
    , Content.getAnnotations = \resource -> owned (Telemetry.withSpan Trace.Client "content.get_annotations" [("resource.id", toAttribute (resourceIdValue resource))] (json http GetResourceAnnotations (Just resource) ()))
    , Content.getAnchoredText = \resource -> owned (Telemetry.withSpan Trace.Client "content.get_anchored_text" [("resource.id", toAttribute (resourceIdValue resource))] (json http GetResourceAnchoredText (Just resource) ()))
    , Content.dispose = Lifetime.close life
    }
