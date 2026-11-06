{-# LANGUAGE OverloadedStrings #-}

module Capabilities (cryptoProbe, telemetryProbe, simulationProbe) where

import Control.Concurrent.Async (async, wait)
import qualified Control.Monad.Class.MonadTime as SimTime
import qualified Control.Monad.Class.MonadTimer as SimTimer
import Control.Monad.IOSim (runSimOrThrow)
import Control.Exception (bracket)
import Control.Monad (unless, void)
import Crypto.Hash (Digest, SHA256, hash)
import Crypto.PubKey.RSA (generate)
import qualified Crypto.PubKey.RSA.PKCS15 as RSA
import Crypto.Random (getRandomBytes)
import qualified Data.ByteString as Bytes
import Data.IORef (atomicModifyIORef', newIORef, readIORef)
import qualified Data.Text as Text
import OpenTelemetry.Attributes (emptyAttributes)
import qualified OpenTelemetry.Context as Context
import OpenTelemetry.Context.ThreadLocal (attachContext, detachContext, getContext)
import OpenTelemetry.Metric.Core
import OpenTelemetry.Processor.Span
import OpenTelemetry.Propagator
import OpenTelemetry.Trace.Core

require :: String -> Bool -> IO ()
require label value = unless value (ioError (userError label))

simulationProbe :: IO ()
simulationProbe = do
  let elapsed = runSimOrThrow $ do
        before <- SimTime.getMonotonicTimeNSec
        SimTimer.threadDelay 5000000
        after <- SimTime.getMonotonicTimeNSec
        pure (after - before)
  require "simulated delay did not advance its clock" (elapsed == 5000000000)
  let expired = runSimOrThrow (SimTimer.timeout 1000 (SimTimer.threadDelay 5000000))
  require "simulated deadline did not cancel delayed work" (expired == Nothing)

cryptoProbe :: IO ()
cryptoProbe = do
  let digest = hash (Bytes.empty) :: Digest SHA256
  require "incorrect SHA-256" (show digest == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  secret <- getRandomBytes 32 :: IO Bytes.ByteString
  require "wrong CSPRNG byte count" (Bytes.length secret == 32)
  (public, private) <- generate 256 65537
  let messageDigest = hash ("probe" :: Bytes.ByteString) :: Digest SHA256
  signed <- RSA.signSaferDigest private messageDigest
  case signed of
    Left reason -> ioError (userError (show reason))
    Right signature -> do
      require "RSA signature did not verify" (RSA.verifyDigest public messageDigest signature)
      require "changed RSA message verified" (not (RSA.verifyDigest public (hash ("changed" :: Bytes.ByteString) :: Digest SHA256) signature))
  require "text offsets count bytes or graphemes" (Text.length "a\x1f600\&e\x0301" == 4)

telemetryProbe :: IO ()
telemetryProbe = do
  ended <- newIORef (0 :: Int)
  stopped <- newIORef False
  let processor = SpanProcessor
        { spanProcessorOnStart = \_ _ -> pure ()
        , spanProcessorOnEnd = \_ -> atomicModifyIORef' ended (\n -> (n + 1, ()))
        , spanProcessorShutdown = atomicModifyIORef' stopped (\_ -> (True, ShutdownSuccess))
        , spanProcessorForceFlush = pure FlushSuccess
        }
      hostPropagator = Propagator
        { propagatorFields = ["host-field"]
        , extractor = \carrier context -> if ("host-field", "probe") `elem` textMapToList carrier
            then pure context else ioError (userError "host propagation missing")
        , injector = \_ _ -> pure (textMapFromList [("host-field", "probe")])
        }
  provider <- createTracerProvider [processor] emptyTracerProviderOptions
    { tracerProviderOptionsPropagators = hostPropagator }
  let tracer = makeTracer provider "consumer-probe" tracerOptions
  parent <- createSpan tracer Context.empty "parent" defaultSpanArguments
  parentContext <- getSpanContext parent
  childContext <- bracket (attachContext (Context.insertSpan parent Context.empty)) detachContext $ \_ -> do
    captured <- getContext
    worker <- async $ bracket (attachContext captured) detachContext $ \_ -> do
      context <- getContext
      child <- createSpan tracer context "child" defaultSpanArguments
      actual <- getSpanContext child
      endSpan child Nothing
      pure actual
    wait worker
  require "child did not retain parent trace" (traceId parentContext == traceId childContext)
  require "child reused parent span" (spanId parentContext /= spanId childContext)
  endSpan parent Nothing
  readIORef ended >>= require "host processor did not receive both spans" . (== 2)
  carrier <- injector (getTracerProviderPropagators provider) Context.empty (textMapFromList [])
  void (extractor hostPropagator carrier Context.empty)
  total <- newIORef 0
  let hostMeter = (noopMeter "consumer-probe")
        { meterCreateCounterInt64 = \_ _ _ _ -> pure Counter
            { counterAdd = \amount _ -> atomicModifyIORef' total (\n -> (n + amount, ()))
            , counterEnabled = pure True
            }
        }
      hostMeters = noopMeterProvider { meterProviderGetMeter = \_ -> pure hostMeter }
  meter <- getMeter hostMeters "consumer-probe"
  counter <- meterCreateCounterInt64 meter "probe.count" Nothing Nothing defaultAdvisoryParameters
  counterAdd counter 2 emptyAttributes
  readIORef total >>= require "host meter did not receive measurement" . (== 2)
  readIORef stopped >>= require "library shut down host telemetry" . not
  result <- shutdownTracerProvider provider Nothing
  require "host could not shut down its provider" (result == ShutdownSuccess)
