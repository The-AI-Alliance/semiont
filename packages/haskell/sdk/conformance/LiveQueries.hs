-- Generated from client/refresh.json; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module LiveQueries (LiveQuery(..)) where
import Data.Aeson (FromJSON(..), withText)
data LiveQuery = Resource | Annotations | Annotation | Events | ReferencedBy | Resources | MatchedResources | EntityTypes | TagSchemas | Engines deriving (Eq, Show)
instance FromJSON LiveQuery where
  parseJSON = withText "LiveQuery" $ \value -> case value of
    "resource" -> pure Resource
    "annotations" -> pure Annotations
    "annotation" -> pure Annotation
    "events" -> pure Events
    "referencedBy" -> pure ReferencedBy
    "resources" -> pure Resources
    "matchedResources" -> pure MatchedResources
    "entityTypes" -> pure EntityTypes
    "tagSchemas" -> pure TagSchemas
    "engines" -> pure Engines
    _ -> fail "unknown live query"
