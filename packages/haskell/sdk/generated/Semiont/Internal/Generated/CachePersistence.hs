-- Generated from cache-persister.ts and namespaces/browse.ts; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.CachePersistence where
import Data.Aeson (Value, FromJSON(..), ToJSON(..), withObject, object, (.:), (.=))
import Data.Scientific (Scientific)
import Data.Text (Text)
data StoredDocument = StoredDocument { storedVersion :: Scientific, storedWrittenAt :: Scientific, storedEntries :: [(Value,Value,Scientific)] } deriving (Eq, Show)
instance FromJSON StoredDocument where
  parseJSON = withObject "StoredDocument" (\fields -> StoredDocument <$> fields .: "version" <*> fields .: "writtenAt" <*> fields .: "entries")
instance ToJSON StoredDocument where
  toJSON value = object ["version" .= storedVersion value, "writtenAt" .= storedWrittenAt value, "entries" .= storedEntries value]
data PersistedQuery = Resource | Annotations | AnnotationDetail | EntityTypes | TagSchemas deriving (Eq, Ord, Show, Enum, Bounded)
persistedQueryName :: PersistedQuery -> Text
persistedQueryName Resource = "resource"
persistedQueryName Annotations = "annotations"
persistedQueryName AnnotationDetail = "annotation-detail"
persistedQueryName EntityTypes = "entity-types"
persistedQueryName TagSchemas = "tag-schemas"
persistenceVersion :: Integer
persistenceVersion = 1
entityTypesKey :: Text
entityTypesKey = "_"
tagSchemasKey :: Text
tagSchemasKey = "_"
