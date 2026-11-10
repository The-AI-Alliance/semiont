{-# LANGUAGE OverloadedStrings, RankNTypes, ScopedTypeVariables #-}
-- | protocol/specs/src/session/cache-cases.json, run through each kept query's
-- own persister over an in-memory storage, under the keys session/stored.json
-- gives.
module CacheDocumentCases (cacheDocumentCases) where

import Control.Concurrent.STM (atomically, retry)
import Control.Monad (forM, forM_, unless)
import Data.Aeson (FromJSON, ToJSON, Result(..), Value(..), eitherDecodeStrict', encode, fromJSON, parseJSON, toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import Data.Foldable (toList)
import qualified Data.Map.Strict as Map
import Data.Proxy (Proxy(..))
import Data.Scientific (floatingOrInteger)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (decodeUtf8, encodeUtf8)
import qualified Semiont.Cache as Cache
import qualified Semiont.Internal.Coupled as Coupled
import qualified Semiont.Internal.Persistence as Persistence
import Semiont.Internal.Generated.CachePersistence (KeptQuery(..), Whole, keptQueryName)
import qualified Semiont.Internal.Generated.CacheRefresh as Fact
import qualified Semiont.Internal.Kept as Kept
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types (AnnotationId, ResourceId, resourceIdValue)
import System.FilePath ((</>))

type Using result = forall key value. (ToJSON key, FromJSON key, ToJSON value, FromJSON value, Eq value)
  => Proxy key -> Proxy value -> IO result

-- | What each kept query's cache is keyed by and holds.
kept :: KeptQuery -> Using result -> IO result
kept Resource use = use (Proxy :: Proxy ResourceId) (Proxy :: Proxy Fact.ResourceValue)
kept Annotations use = use (Proxy :: Proxy ResourceId) (Proxy :: Proxy Fact.AnnotationsValue)
kept Annotation use = use (Proxy :: Proxy AnnotationId) (Proxy :: Proxy Fact.AnnotationValue)
kept EntityTypes use = use (Proxy :: Proxy Whole) (Proxy :: Proxy Fact.EntityTypesValue)
kept TagSchemas use = use (Proxy :: Proxy Whole) (Proxy :: Proxy Fact.TagSchemasValue)

kb, person :: Text
kb = "kb-cases"
person = "person-cases"

failure :: Text -> String -> IO result
failure name reason = ioError (userError (Text.unpack name ++ ": " ++ reason))

member :: Text -> Text -> Value -> IO Value
member name key (Object fields) = maybe (failure name ("states no " ++ Text.unpack key)) pure (KM.lookup (Key.fromText key) fields)
member name _ _ = failure name "is no object"

textOf :: Text -> Value -> IO Text
textOf _ (String value) = pure value
textOf name _ = failure name "names no text"

listOf :: Text -> Value -> IO [Value]
listOf _ (Array values) = pure (toList values)
listOf name _ = failure name "states no list"

decoded :: FromJSON value => Text -> Value -> IO value
decoded name value = case fromJSON value of
  Success parsed -> pure parsed
  Error reason -> failure name ("holds a value that is not the query's: " ++ reason)

-- | The text a case keeps under its key: `stored` as JSON, or `storedText` as it is.
storedText :: Text -> Value -> IO Text
storedText name (Object fields) = case (KM.lookup "stored" fields, KM.lookup "storedText" fields) of
  (Just value, Nothing) -> pure (decodeUtf8 (Lazy.toStrict (encode value)))
  (Nothing, Just (String value)) -> pure value
  _ -> failure name "states not exactly one of stored and storedText"
storedText name _ = failure name "is no object"

-- | Key and value pairs compared as a map, the key by its JSON text.
asMap :: [(Value, Value)] -> Map.Map Text Value
asMap pairs = Map.fromList [(decodeUtf8 (Lazy.toStrict (encode key)), value) | (key, value) <- pairs]

pairsOf :: Text -> Value -> IO [(Value, Value)]
pairsOf name entries = listOf name entries >>= traverse (\entry -> do
  parts <- listOf name entry
  case parts of
    [key, value] -> pure (key, value)
    _ -> failure name "states an entry that is not a key and a value")

-- | The case's query, and the key its document is kept under, by the case's own name for it.
queryOf :: Text -> Value -> IO (KeptQuery, Text)
queryOf name row = do
  queryName <- member name "query" row >>= textOf name
  case [query | query <- [minBound .. maxBound], keptQueryName query == queryName] of
    [query] -> pure (query, Kept.cacheKey kb person query)
    _ -> failure name ("names " ++ Text.unpack queryName ++ ", no kept query")

-- | The persister the client gives a kept query; its host's clock is not in whole milliseconds.
persisterOf :: (ToJSON key, FromJSON key, ToJSON value, FromJSON value)
  => Storage.SessionStorage -> KeptQuery -> IO (Cache.CachePersister key value)
persisterOf storage query = do
  coupled <- Coupled.newCoupled storage (Kept.lastEventIdKey kb person)
  Persistence.persister (Persistence.CachePersistence storage kb person (pure 1800000000000.6)) coupled
    Timing.protocolSettings query (\key _ -> parseJSON key)

loadCase :: Value -> IO ()
loadCase row = do
  name <- member "a load case" "name" row >>= textOf "a load case"
  (query, key) <- queryOf name row
  storage <- Storage.newMemoryStorage
  storedText name row >>= Storage.set storage key
  loaded <- kept query (\(_ :: Proxy key) (_ :: Proxy value) -> do
    persister <- persisterOf storage query :: IO (Cache.CachePersister key value)
    entries <- Cache.load persister
    pure [(toJSON identity, toJSON value) | (identity, value) <- entries])
  expected <- member name "kept" row >>= pairsOf name
  unless (asMap loaded == asMap expected) (failure name ("kept " ++ show loaded))

writeCase :: Value -> IO ()
writeCase row = do
  name <- member "a write case" "name" row >>= textOf "a write case"
  (query, key) <- queryOf name row
  storage <- Storage.newMemoryStorage
  held <- member name "held" row >>= pairsOf name
  kept query (\(_ :: Proxy key) (_ :: Proxy value) -> do
    persister <- persisterOf storage query :: IO (Cache.CachePersister key value)
    values <- forM held (\(identity, value) -> (,) <$> decoded name identity <*> decoded name value) :: IO [(key, value)]
    cache <- Cache.newCache (\_ -> failure name "asked the wire")
      (Cache.CacheOptions (pure 0) (const (atomically retry)) 0 (Just persister) (const (pure (pure ()))))
    forM_ values (uncurry (Cache.set cache))
    Cache.dispose cache)
  raw <- Storage.get storage key >>= maybe (failure name "wrote no document") pure
  document <- either (failure name) pure (eitherDecodeStrict' (encodeUtf8 raw) :: Either String Value)
  written <- member name "written" row
  version <- member name "version" document
  expectedVersion <- member name "version" written
  unless (version == expectedVersion) (failure name ("wrote version " ++ show version))
  entries <- member name "entries" document >>= listOf name
  writtenPairs <- forM entries $ \entry -> do
    parts <- listOf name entry
    case parts of
      [identity, value, Number stamp] | Right at <- (floatingOrInteger stamp :: Either Double Integer), at >= 0 -> pure (identity, value)
      _ -> failure name ("wrote an entry that is not a key, a value and a whole-number stamp of at least 0: " ++ show entry)
  expected <- member name "entries" written >>= pairsOf name
  unless (asMap writtenPairs == asMap expected) (failure name ("wrote " ++ show writtenPairs))

placesCase :: Value -> IO ()
placesCase row = do
  name <- member "a places case" "name" row >>= textOf "a places case"
  storage <- Storage.newMemoryStorage
  storedText name row >>= Storage.set storage (Kept.lastEventIdKey kb person)
  coupled <- Coupled.newCoupled storage (Kept.lastEventIdKey kb person)
  loaded <- Coupled.loadPositions coupled
  expected <- member name "kept" row >>= \value -> case value of
    Object fields -> forM (KM.toList fields) (\(scope, place) -> (,) (Key.toText scope) <$> textOf name place)
    _ -> failure name "keeps no object"
  let held = Map.fromList [(resourceIdValue scope, place) | (scope, place) <- Map.toList loaded]
  unless (held == Map.fromList expected) (failure name ("kept " ++ show held))

cacheDocumentCases :: FilePath -> IO ()
cacheDocumentCases root = do
  table <- Bytes.readFile (root </> "protocol/specs/src/session/cache-cases.json")
    >>= either (ioError . userError) pure . eitherDecodeStrict'
  loads <- member "the cache table" "cases" table >>= listOf "the cache table"
  writes <- member "the cache table" "writes" table >>= listOf "the cache table"
  places <- member "the cache table" "places" table >>= listOf "the cache table"
  mapM_ loadCase loads
  mapM_ writeCase writes
  mapM_ placesCase places
  putStrLn ("PASS " ++ show (length loads + length writes + length places) ++ " shared cache document, write and places cases")
