{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Telemetry (withSpan, withUpload, sending, withReceived, outgoingHeaders) where

import Control.Exception (bracket, finally)
import Data.Aeson (Value(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.HashMap.Strict as HashMap
import qualified Data.CaseInsensitive as CI
import Data.Int (Int64)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8)
import Data.Version (showVersion)
import OpenTelemetry.Attributes (Attribute, toAttribute)
import qualified OpenTelemetry.Attributes as Attributes
import OpenTelemetry.Context.ThreadLocal (getContext, attachContext, detachContext)
import Network.HTTP.Types (RequestHeaders)
import qualified OpenTelemetry.Metric.Core as Metric
import qualified OpenTelemetry.Propagator as Propagator
import qualified OpenTelemetry.Trace.Core as Trace
import Paths_semiont (version)
import Semiont.Transport.Facts (traceField, traceCarrierFields)
import Semiont.Types

scope :: Trace.InstrumentationLibrary
scope = Trace.instrumentationLibrary "semiont" (Text.pack (showVersion version))

-- The shared wire telemetry corpus holds these calls to every declared span,
-- kind and attribute in protocol/specs/src/sdk-telemetry/telemetry.json.
withSpan :: Trace.SpanKind -> Text -> [(Text, Attribute)] -> IO result -> IO result
withSpan kind name attributes action = do
  provider <- Trace.getGlobalTracerProvider
  tracer <- Trace.getTracer provider scope Trace.tracerOptions
  Trace.inSpan'' tracer name Trace.defaultSpanArguments
    { Trace.kind = kind, Trace.attributes = HashMap.fromList attributes } (const action)

withUpload :: Text -> IO Integer -> IO result -> IO result
withUpload format size action = do
  provider <- Trace.getGlobalTracerProvider
  tracer <- Trace.getTracer provider scope Trace.tracerOptions
  Trace.inSpan'' tracer "content.put" Trace.defaultSpanArguments
    { Trace.kind = Trace.Client, Trace.attributes = HashMap.singleton "content.format" (toAttribute format) } $ \activeSpan ->
      action `finally` (size >>= Trace.addAttribute activeSpan "content.size_bytes" . sizeAttribute)
  where
    sizeAttribute value
      | value >= toInteger (minBound :: Int64) && value <= toInteger (maxBound :: Int64) = toAttribute (fromInteger value :: Int64)
      | otherwise = toAttribute (Text.pack (show value))

sending :: BusFrame -> IO result -> IO result
sending frame action = do
  sent frame
  withSpan Trace.Producer ("bus.emit:" <> busFrameChannel frame) (busAttributes frame) action

sent :: BusFrame -> IO ()
sent frame = do
  provider <- Metric.getGlobalMeterProvider
  meter <- Metric.getMeter provider scope
  counter <- Metric.meterCreateCounterInt64 meter "semiont.bus.sent" Nothing Nothing Metric.defaultAdvisoryParameters
  Metric.counterAdd counter 1 (Attributes.addAttributes Attributes.defaultAttributeLimits Attributes.emptyAttributes (HashMap.fromList (busAttributes frame)))

busAttributes :: BusFrame -> [(Text, Attribute)]
busAttributes frame = ("bus.channel", toAttribute (busFrameChannel frame)) :
  maybe [] (\resource -> [("bus.scope", toAttribute (resourceIdValue resource))]) (busFrameScope frame)

withReceived :: BusFrame -> IO result -> IO result
withReceived frame action = do
  parent <- getContext
  propagator <- Propagator.getGlobalTextMapPropagator
  let fields = busFramePayloadAdditionalProperties (busFramePayload frame)
      carrier = case KM.lookup (Key.fromText traceField) fields of
        Just (Object values) -> Propagator.textMapFromList [(Key.toText key,value) | (key,String value) <- KM.toList values, Key.toText key `elem` traceCarrierFields]
        _ -> Propagator.emptyTextMap
  context <- Propagator.extract propagator carrier parent
  bracket (attachContext context) detachContext $ \_ ->
    withSpan Trace.Consumer ("bus.recv:" <> busFrameChannel frame) (busAttributes frame) action

outgoingHeaders :: IO RequestHeaders
outgoingHeaders = do
  propagator <- Propagator.getGlobalTextMapPropagator
  context <- getContext
  injected <- Propagator.inject propagator context Propagator.emptyTextMap
  pure [(CI.mk (encodeUtf8 key),encodeUtf8 value) | (key,value) <- Propagator.textMapToList injected]
