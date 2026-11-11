{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Control.Applicative ((<|>))
import Control.Monad (forM, forM_, unless)
import Data.Aeson (FromJSON, Value(..), eitherDecodeStrict', parseJSON, toJSON)
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Either (isLeft)
import Data.Foldable (toList)
import Data.IORef (modifyIORef', newIORef, readIORef)
import Data.List (isSuffixOf, sortOn)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Vector as V
import Semiont.Internal.Generated.RoundTrip (roundTrip)
import Semiont.Internal.Generated.ChannelRoundTrip (roundTripChannel, channelMetadata, operationMetadata)
import qualified Semiont.Channels as Channels
import Semiont.Internal.Generated.ErrorRoundTrip (roundTripError)
import Semiont.Internal.Generated.TimingValues (timingValues)
import qualified Semiont.Internal.Generated.DiscoveryReasonRoundTrip as DiscoveryReasons
import qualified Semiont.ErrorCodes as Errors
import qualified Semiont.Retry as Retry
import qualified Semiont.Internal.Required as Required
import qualified Semiont.Timing.Settings as TimingSettings
import Semiont.Internal.Generated.Schemas (schemas)
import Semiont.Internal.Schema (normalize, validate, validateNamed)
import System.Directory (doesDirectoryExist, listDirectory)
import System.Environment (getArgs)
import System.IO (hSetBuffering, stdout, BufferMode(LineBuffering), utf8)
import GHC.IO.Encoding (setFileSystemEncoding)
import System.FilePath ((</>), takeBaseName)
import Runtime (runtimeCases)
import Discovery (discoveryCases)
import BusCases (busCases)
import HttpCases (httpCases)
import HttpDiscoveryCases (httpDiscoveryCases)
import AnnotationCases (annotationCases)
import IdentityCases (identityCases)
import BusLogCases (busLogCases)
import PersistenceCases (persistenceCases)
import CacheDocumentCases (cacheDocumentCases)
import PersistedCases (persistedCases)
import StateUnitCases (stateUnitCases)
import FlowCases (flowCases)
import ActorCases (actorCases)
import TestingCases (testingCases)
import RegistryCases (registryCases)
import OpenResourceCases (openResourceCases)
import RegistryErrorsCases (registryErrorsCases)
import RegistryRuntimeCases (registryRuntimeCases)
import LifetimeCases (lifetimeCases)
import CacheCases (cacheCases)
import WorkerCases (workerCases)
import GatewayCases (gatewayCases)
import HeldCases (heldCases, heldClockCases)
import SurfaceCases (surfaceCases)
import ClockCases (clockCensus, clientClockCases, jobPollClockCases, cacheClockCases, httpClockCases, discoveryClockCases)
import ResourceCases (resourceCases)
import FrameCases (frameCases)
import RefreshCases (refreshCases)
import TextCases (textCases)
import SignInStoreCases (signInStoreCases, storeWriter)
import ClientAssertionCases (clientAssertionCases)
import IssuerCases (issuerCases, serviceTokenCases, deviceClockCases)
import SessionCases (sessionCases, sessionClockCases)
import TokenStorageCases (tokenStorageCases)
import DelegationCases (delegationCases, followerClockCases)
import qualified SchemaCases

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))

readJSON :: FilePath -> IO Value
readJSON path = Bytes.readFile path >>= either (ioError . userError) pure . eitherDecodeStrict'

object :: Value -> KM.KeyMap Value
object (Object fields) = fields
object _ = KM.empty

array :: Value -> [Value]
array (Array values) = toList values
array _ = []

at :: Key.Key -> Value -> Value
at key value = maybe Null id (KM.lookup key (object value))

sample :: Int -> Value -> Either String Value
sample depth original
  | depth > 40 = Left "required schema recursion exceeds sample budget"
  | otherwise = do
      normalized <- normalize schemas original
      let fields = object normalized
          nested = sample (depth + 1)
          choose candidates = case filter (either (const False) (const True) . validate schemas normalized) candidates of
            value : _ -> Right value
            [] -> Left ("no valid generated sample for " ++ show normalized)
      case KM.lookup "$ref" fields of
        Just (String reference) -> case Map.lookup (T.pack (takeBaseName (T.unpack reference))) schemas of
          Just target -> nested target
          Nothing -> Left "sample reference has no schema"
        _ -> case KM.lookup "enum" fields of
          Just (Array values) -> choose (toList values)
          _ -> case KM.lookup "oneOf" fields <|> KM.lookup "anyOf" fields of
            Just (Array alternatives) -> choose [value | Right value <- map nested (toList alternatives)]
            _ -> case KM.lookup "type" fields of
              Just (String "string") -> do
                let width = case KM.lookup "minLength" fields of Just (Number n) -> ceiling n; _ -> 0
                choose [String text | text <- [T.replicate width "a", "a", "did:example:probe", "e-a", "e-a:b:c", "p-a-1", T.replicate 64 "a"]]
              Just (String "integer") -> choose [Number (case KM.lookup "minimum" fields of Just (Number n) -> fromInteger (ceiling n); _ -> 0)]
              Just (String "number") -> choose [Number (case KM.lookup "minimum" fields of Just (Number n) -> n; _ -> 0)]
              Just (String "boolean") -> Right (Bool False)
              Just (String "array") -> do
                let size = case KM.lookup "minItems" fields of Just (Number n) -> ceiling n; _ -> 0
                items <- mapM (const (nested (at "items" normalized))) [1 :: Int .. size]
                choose [Array (V.fromList items)]
              Just (String "object") -> do
                let properties = object (at "properties" normalized)
                required <- mapM (\key -> case key of
                  String name -> do
                    let member = Key.fromText name
                    definition <- maybe (Left "required field has no schema") Right (KM.lookup member properties)
                    (,) member <$> nested definition
                  _ -> Left "required name is not a string") (array (at "required" normalized))
                choose [Object (KM.fromList required)]
              Nothing -> Right Null
              _ -> Left "sample shape unsupported"

expectRoundTrip :: Text -> Value -> IO ()
expectRoundTrip name value = case roundTrip name value of
  Left reason -> ioError (userError (T.unpack name ++ ": " ++ reason))
  Right encoded -> require (T.unpack name ++ " lost JSON members: " ++ show value ++ " -> " ++ show encoded) (encoded == value)

schemaCases :: FilePath -> IO ()
schemaCases root = do
  files <- listDirectory (root </> "protocol/specs/src/components/schemas")
  forM_ [T.pack (takeBaseName file) | file <- files, ".json" `isSuffixOf` file] $ \name ->
    require ("missing generated schema: " ++ T.unpack name) (Map.member name schemas)
  forM_ (Map.toAscList schemas) $ \(name, definition) -> do
    value <- either (ioError . userError . ((T.unpack name ++ ": ") ++)) pure (sample 0 definition)
    expectRoundTrip name value
    normalized <- either (ioError . userError) pure (normalize schemas definition)
    let properties = object (at "properties" normalized)
        required = array (at "required" normalized)
    forM_ (KM.toList properties) $ \(key, field) -> do
      if at "nullable" field /= Bool True then pure () else do
        expectRoundTrip name (Object (KM.insert key Null (object value)))
        if String (Key.toText key) `elem` required then pure ()
          else expectRoundTrip name (Object (KM.delete key (object value)))
    case value of
      Object fields | at "type" normalized == String "object" && at "additionalProperties" normalized /= Bool False && at "maxProperties" normalized == Null -> do
        extra <- case at "additionalProperties" normalized of
          typed@(Object _) -> either (ioError . userError) pure (sample 0 typed)
          _ -> pure (Number 18446744073709551617)
        expectRoundTrip name (Object (KM.insert "__haskell_probe" extra fields))
      _ -> pure ()
    case at "enum" normalized of
      Array values -> do
        mapM_ (expectRoundTrip name) values
        let unknown candidate = if String candidate `V.elem` values then unknown (candidate <> "_") else candidate
        require (T.unpack name ++ " accepted an unknown enum member") (isLeft (roundTrip name (String (unknown "__haskell_unknown"))))
      _ -> pure ()

identifierCases :: FilePath -> IO ()
identifierCases root = do
  kinds <- readJSON (root </> "protocol/specs/src/identifiers/kinds.json")
  forM_ (array (at "kinds" kinds)) $ \kind -> case at "schema" kind of
    String name -> do
      forM_ (array (at "accepts" kind)) $ \entry -> expectRoundTrip name (at "id" entry)
      forM_ (array (at "refuses" kind)) $ \entry ->
        require (T.unpack name ++ " accepted " ++ show (at "id" entry)) (isLeft (roundTrip name (at "id" entry)))
    _ -> ioError (userError "identifier table has no schema name")

filesUnder :: FilePath -> IO [FilePath]
filesUnder directory = do
  names <- listDirectory directory
  fmap concat $ mapM (\name -> do
    let path = directory </> name
    nested <- doesDirectoryExist path
    if nested then filesUnder path else pure [path | ".json" `isSuffixOf` name]) names

corpusCases :: FilePath -> IO ()
corpusCases root = do
  registry <- readJSON (root </> "protocol/specs/src/bus/registry.json")
  let channels = Map.fromList [(name, channel) | channel <- array (at "channels" registry), String name <- [at "channel" channel]]
  held <- newIORef (0 :: Int)
  refused <- newIORef (0 :: Int)
  let resolve names value = case value of
        Object fields -> case KM.lookup "$var" fields of
          Just (String key) -> KM.lookup (Key.fromText key) names
          _ -> case KM.lookup "$join" fields of
            Just (Array parts) -> String . T.concat <$> traverse (\part -> case resolve names part of Just (String text) -> Just text; _ -> Nothing) (toList parts)
            _ -> Object <$> traverse (resolve names) fields
        Array values -> Array <$> traverse (resolve names) values
        String "_" -> Nothing
        _ -> Just value
      walk names value = case value of
        Object fields -> do
          let bindings = KM.mapMaybe (resolve names) (object (at "let" value))
              current = bindings <> names
          case (KM.lookup "channel" fields, KM.lookup "payload" fields) of
            (Just (String channel), Just raw) -> case (Map.lookup channel channels, resolve current raw) of
              (Just channelSchema, Just resolved) -> do
                let shape = at "shape" channelSchema
                    payload = if shape == String "envelope" then at "response" resolved else resolved
                    named = at (if shape == String "storedEvent" then "payload" else "schema") channelSchema
                case named of
                  String name | payload /= Null -> case validateNamed schemas name payload of
                    Left _ -> do
                      require "decoder accepted a schema-invalid corpus payload" (isLeft (roundTrip name payload))
                      modifyIORef' refused (+ 1)
                    Right () -> expectRoundTrip name payload >> modifyIORef' held (+ 1)
                  _ -> pure ()
              _ -> pure ()
            _ -> pure ()
          foldWalk current (map snd (KM.toList fields))
        Array values -> foldWalk names (toList values)
        _ -> pure names
      foldWalk names [] = pure names
      foldWalk names (value : rest) = walk names value >>= \next -> foldWalk next rest
  forM_ ["sdk/wire", "sdk/live", "worker"] $ \part -> do
    files <- filesUnder (root </> "protocol/conformance" </> part)
    forM_ files $ \path -> do
      value <- readJSON path
      let initial = KM.fromList [(Key.fromText key, String key) | key <- ["r1", "r2", "r3", "a1", "a2"]]
            <> KM.fromList [(Key.fromText key, String ("did:web:example.org:users:" <> key)) | key <- ["client", "participant"]]
      _ <- walk initial value
      pure ()
  count <- readIORef held
  failures <- readIORef refused
  require "corpus runner executed no payloads" (count > 0)
  putStrLn ("PASS corpus payloads: " ++ show count ++ " round-trips; " ++ show failures ++ " schema-invalid refusals")

channelCases :: FilePath -> IO ()
channelCases root = do
  registry <- readJSON (root </> "protocol/specs/src/bus/registry.json")
  let channels = array (at "channels" registry)
  require "registry declares no channels" (not (null channels))
  forM_ channels $ \channel -> do
    name <- case at "channel" channel of String value -> pure value; _ -> ioError (userError "channel name missing")
    named <- case at "shape" channel of
      String "schema" -> case at "schema" channel of String value -> pure value; _ -> ioError (userError "channel schema missing")
      String "storedEvent" -> pure (if at "enriched" channel == Bool True then "EnrichedResourceEvent" else "StoredEventResponse")
      String "envelope" -> case at "schema" channel of String value -> pure (value <> "BusEnvelope"); _ -> ioError (userError "envelope schema missing")
      String "empty" -> pure "EmptyBusPayload"
      String "void" -> pure "EmptyBusPayload"
      _ -> ioError (userError "unrecognized channel shape")
    require "channel metadata disagrees with the registry" (channelMetadata name == Right (name, named, String name `elem` array (at "scoped" (at "audience" registry))))
    schema <- maybe (ioError (userError ("missing generated channel schema: " ++ T.unpack named))) pure (Map.lookup named schemas)
    payload <- either (ioError . userError) pure (sample 0 schema)
    stamped <- case payload of
      Object fields -> pure (Object (KM.insert "__testStamp" (String "gateway-owned") fields))
      _ -> ioError (userError "channel payload is not an object")
    require ("channel decoder lost a declared stamp or retained an unknown one on " ++ T.unpack name)
      (roundTripChannel name stamped == Right payload)
    require "common channel shape disagrees with the typed codec" (Required.faultChannel name stamped == Nothing)
    require "channel accepted a non-object payload" (isLeft (roundTripChannel name Null))
  require "channel inventory disagrees with the registry" (map String Channels.channelNames == map (at "channel") channels)
  let operations = array (at "operations" registry)
      actualOperations = [(String asked, String result, String failure) | (asked, result, failure) <- operationMetadata]
  require "operation routing disagrees with the registry" (actualOperations == [(at "request" row, at "result" row, at "failure" row) | row <- operations])
  require "persisted event vocabulary disagrees with the registry" (map String Channels.persistedEventTypes == [value | row <- channels, let value = at "event" row, value /= Null])
  putStrLn ("PASS typed payload decoding and stamp handling for all " ++ show (length channels) ++ " registry channels")

factCases :: FilePath -> IO ()
factCases root = do
  errors <- readJSON (root </> "protocol/specs/src/errors/codes.json")
  let families = KM.delete "$comment" (object errors)
  require "no error families" (not (KM.null families))
  forM_ (KM.toList families) $ \(family, group) -> do
    let codes = array (at "codes" group)
    require "empty error family" (not (null codes))
    forM_ codes $ \row -> do
      let code = at "code" row
      require "error code codec changed its wire spelling" (roundTripError (Key.toText family) code == Right code)
    require "unknown error code was accepted" (isLeft (roundTripError (Key.toText family) (String "__unknown_test_code")))
  let transport = at "transport" errors
      statuses = array (at "codes" transport)
      exact status = [at "code" row | row <- statuses, at "status" row == Number (fromIntegral status)]
      ranges status = sortOn (negate . fst) [(floor', at "code" row) | row <- statuses, Number floor' <- [at "statusFrom" row], fromIntegral status >= floor']
      expected status = case exact status of
        code : _ -> code
        [] -> case ranges status of (_, code) : _ -> code; [] -> at "unclassified" transport
  forM_ [0 .. 600] $ \status ->
    require "HTTP status classifier differs from spec" (String (Errors.transportCode (Errors.transportCodeFromStatus status)) == expected status)
  timings <- readJSON (root </> "protocol/specs/src/client/timing.json")
  let expectedTiming = Map.fromList [(key, at "value" row) | row <- array (at "timing" timings), String key <- [at "name" row]]
  require "timing constants or retry budgets differ from spec" (not (Map.null expectedTiming) && expectedTiming == timingValues)
  require "configurable timings differ from the protocol constants"
    (toJSON TimingSettings.protocolSettings == Object (KM.fromList [(Key.fromText key,value) | (key,value) <- Map.toList expectedTiming]))
  forM_ (Map.toList expectedTiming) $ \(key,value) -> do
    let changed = case value of
          Number number -> Number (number + 1)
          Object fields -> Object (KM.mapWithKey (\member number -> case number of Number n | member == "attempts" -> Number (n + 1); other -> other) fields)
          other -> other
        overridden = TimingSettings.withOverrides (Object (KM.singleton (Key.fromText key) changed))
    require "a protocol timing cannot be overridden"
      (fmap toJSON overridden == Right (Object (KM.fromList [(Key.fromText name,if name == key then changed else original) | (name,original) <- Map.toList expectedTiming])))
  forM_ [Object (KM.singleton "unknown" (Number 1)), Object (KM.singleton "reconnectMs" (Number (-1))),
      Object (KM.singleton "emitRetry" (Object KM.empty)), Object (KM.singleton "reconnectMs" (Number 0.5))] $ \invalid ->
    require "malformed timing override was accepted" (isLeft (TimingSettings.withOverrides invalid))
  putStrLn "PASS every error vocabulary, wire/HTTP classifiers, timing constant and retry budget"
  discovery <- readJSON (root </> "protocol/specs/src/client/discovery-absent.json")
  forM_ (array (at "reasons" discovery)) $ \row -> do
    let reason = at "reason" row
    require "discovery reason differs from its authority"
      (DiscoveryReasons.roundTripError "discoveryAbsent" reason == Right reason)
  require "unknown discovery reason was accepted"
    (isLeft (DiscoveryReasons.roundTripError "discoveryAbsent" (String "__unknown_test_reason")))

retryCases :: FilePath -> IO ()
retryCases root = do
  table <- readJSON (root </> "protocol/specs/src/retry/cases.json")
  let rules = [minBound .. maxBound] :: [Retry.RetryRule]
      rows = array (at "rules" table)
      decode :: FromJSON value => Value -> IO value
      decode value = either (ioError . userError) pure (parseEither parseJSON value)
  names <- traverse (decode . at "rule") rows
  require "retry rule vocabulary differs from its authority"
    (Set.fromList names == Set.fromList (map Retry.ruleName rules))
  forM_ rows $ \row -> do
    require "retry table gained an unhandled fact" (all (`elem` ["why", "rule", "status", "method", "keyed", "retries"]) (KM.keys (object row)))
    name <- decode (at "rule" row)
    rule <- case filter ((== name) . Retry.ruleName) rules of
      [one] -> pure one
      _ -> ioError (userError "unknown retry rule")
    status <- decode (at "status" row)
    method <- decode (at "method" row)
    keyed <- decode (at "keyed" row)
    expected <- decode (at "retries" row)
    require ("retry decision differs from spec: " ++ show (at "why" row)) (Retry.retryable rule status method (keyed == Just True) == expected)
  forM_ (array (at "retryAfter" table)) $ \row -> do
    header <- decode (at "header" row)
    expected <- decode (at "ms" row)
    require "Retry-After differs from spec" (Retry.retryAfterMs header == expected)
  putStrLn "PASS all retry rules and Retry-After cases"

main :: IO ()
main = do
  setFileSystemEncoding utf8
  hSetBuffering stdout LineBuffering
  args <- getArgs
  case args of
    ["--store-writer",filename,key] -> storeWriter filename (T.pack key)
    [root] -> runCases root
    _ -> ioError (userError "expected repository root or a native store peer")

runCases :: FilePath -> IO ()
runCases root = do
  busLogCases root
  identityCases root
  annotationCases root
  stateUnitCases root
  flowCases root
  actorCases root
  runtimeCases
  lifetimeCases
  cacheCases
  saveClock <- cacheClockCases root
  httpClock <- httpClockCases root
  SchemaCases.schemaCases
  let noSpace = Object (KM.fromList [("type", String "string"), ("pattern", String "^\\S+$")])
      dot = Object (KM.fromList [("type", String "string"), ("pattern", String "^x.+z$")])
  forM_ ["\xa0", "\x2028", "\xfeff"] $ \separator ->
    require "ECMAScript whitespace accepted by non-space pattern" (isLeft (validate schemas noSpace (String ("x" <> separator))))
  forM_ ["\n", "\r", "\x2028", "\x2029"] $ \separator ->
    require "ECMAScript dot matched line terminator" (isLeft (validate schemas dot (String ("x" <> separator <> "z"))))
  schemaCases root
  specification <- readJSON (root </> "protocol/specs/src/openapi.json")
  forM_ (KM.keys (object (at "schemas" (at "components" specification)))) $ \key -> do
    let name = Key.toText key
    shape <- maybe (ioError (userError "missing native schema for common required-shape proof")) pure (Map.lookup name schemas)
    value <- either (ioError . userError) pure (sample 0 shape)
    require ("common required shape refused native sample: " ++ T.unpack name ++ " " ++ show (Required.faultOf name value))
      (Required.faultOf name value == Nothing)
  putStrLn "PASS common required-shape reader accepts every generated component sample"
  putStrLn "PASS generated schema samples, null presence, open members, exact numbers and enums"
  resourceCases root
  frameCases root
  textCases root
  tokenStorageCases root
  signInStoreCases root
  clientAssertionCases root
  identifierCases root
  putStrLn "PASS shared identifier acceptance/refusal cases"
  channelCases root
  factCases root
  retryCases root
  metadata <- either (ioError . userError) pure (sample 0 (Object (KM.singleton "$ref" (String "JobMetadata.json"))))
    >>= either (ioError . userError) pure . parseEither parseJSON
  workerCases root metadata
  gatewayCases root
  kb <- either (ioError . userError) pure (sample 0 (Object (KM.singleton "$ref" (String "DiscoveredKB.json"))))
    >>= either (ioError . userError) pure . parseEither parseJSON
  document <- either (ioError . userError) pure (sample 0 (Object (KM.singleton "$ref" (String "DiscoveryDocument.json"))))
    >>= either (ioError . userError) pure . parseEither parseJSON
  discoveryCases kb document
  httpDiscoveryCases document
  discoveryClock <- discoveryClockCases root kb
  command <- either (ioError . userError) pure (sample 0 (Object (KM.singleton "$ref" (String "FrameAddEntityTypeCommand.json"))))
    >>= either (ioError . userError) pure . parseEither parseJSON
  event <- either (ioError . userError) pure (sample 0 (Object (KM.singleton "$ref" (String "EnrichedResourceEvent.json"))))
  browse <- either (ioError . userError) pure (sample 0 (Object (KM.singleton "$ref" (String "BrowseResourceRequest.json"))))
    >>= either (ioError . userError) pure . parseEither parseJSON
  errorTable <- readJSON (root </> "protocol/specs/src/errors/codes.json")
  let busErrors = at "busRequest" errorTable
  fallback <- either (ioError . userError) pure (parseEither parseJSON (at "unrecognizedFailure" busErrors))
  failureRows <- forM [row | row <- array (at "codes" busErrors), String _ <- [at "wire" row]] $ \row -> do
    wire <- either (ioError . userError) pure (parseEither parseJSON (at "wire" row))
    code <- either (ioError . userError) pure (parseEither parseJSON (at "code" row))
    pure (Just wire, code, Just wire)
  busCases command browse event (failureRows ++ [(Nothing, fallback, Nothing), (Just "__unknown_test_code", fallback, Nothing)])
  fixtures <- traverse (either (ioError . userError) pure . sample 0) schemas
  registryRuntimeCases fixtures
  testingCases fixtures
  registryCases root fixtures
  openResourceCases root fixtures
  registryErrorsCases root fixtures
  persistenceCases fixtures
  cacheDocumentCases root
  persistedCases root fixtures
  issuerCases fixtures
  serviceTokenCases root
  deviceClock <- deviceClockCases root
  sessionCases root fixtures
  sessionClock <- sessionClockCases root fixtures
  delegationCases fixtures
  followerClock <- followerClockCases root fixtures
  surfaceCases root fixtures
  clientClock <- clientClockCases root fixtures
  jobPollClock <- jobPollClockCases root fixtures
  refreshCases fixtures
  heldCases fixtures
  heldClock <- heldClockCases root fixtures
  clockCensus root (concat [saveClock, httpClock, discoveryClock, deviceClock, sessionClock, followerClock, clientClock, jobPollClock, heldClock])
  httpCases root fixtures
  corpusCases root
