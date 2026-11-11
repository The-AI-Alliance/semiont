-- Generated from session/stored.json and client/refresh.json; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.CachePersistence (KeptQuery(..), keptQueryName, Whole(..), CacheDocument(..), lastEventIds) where
import Control.Monad (unless)
import Data.Aeson (FromJSON(..), ToJSON(..), Result(..), Value(..), fromJSON, object, withObject, withText, (.:), (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import Numeric.Natural (Natural)
import Semiont.Internal.Generated.Models.PersistedEventId (PersistedEventId)
import Semiont.Internal.Generated.Models.ResourceId (ResourceId)
-- | The queries a client keeps across a restart, by their names in client/refresh.json.
data KeptQuery = Resource | Annotations | Annotation | EntityTypes | TagSchemas deriving (Eq, Ord, Show, Enum, Bounded)
keptQueryName :: KeptQuery -> Text
keptQueryName Resource = "resource"
keptQueryName Annotations = "annotations"
keptQueryName Annotation = "annotation"
keptQueryName EntityTypes = "entityTypes"
keptQueryName TagSchemas = "tagSchemas"
-- | The key a kept query per nothing keeps its one entry under.
data Whole = Whole deriving (Eq, Ord, Show)
instance ToJSON Whole where toJSON Whole = String "_"
instance FromJSON Whole where
  parseJSON = withText "Whole" (\key -> if key == "_" then pure Whole else fail "not the whole key")
-- | What a client keeps of one query: each entry's key, value and stamp. A document of another
-- version, or one whose entries are not each a key, a value and a stamp, does not decode.
newtype CacheDocument = CacheDocument [(Value, Value, Natural)] deriving (Eq, Show)
instance FromJSON CacheDocument where
  parseJSON = withObject "CacheDocument" $ \fields -> do
    version <- fields .: "version"
    unless (version == (1 :: Integer)) (fail "a cache document of another version")
    CacheDocument <$> fields .: "entries"
instance ToJSON CacheDocument where
  toJSON (CacheDocument entries) = object ["version" .= (1 :: Integer), "entries" .= entries]
-- | Where a stream was: a pair that is not a ResourceId and a PersistedEventId is skipped, and a value that is no object is none.
lastEventIds :: Value -> Map.Map ResourceId PersistedEventId
lastEventIds (Object fields) = Map.fromList
  [(named, value) | (key, raw) <- KM.toList fields, Success named <- [fromJSON (String (Key.toText key))], Success value <- [fromJSON raw]]
lastEventIds _ = Map.empty
