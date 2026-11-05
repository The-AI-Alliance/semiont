-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GatheredContext
  ( GatheredContext(..)
  , GatheredContextFocus(..)
  , GatheredContextFocusBranch1Value(..)
  , GatheredContextFocusBranch1ValueKind(..)
  , GatheredContextFocusBranch1ValueSelected(..)
  , GatheredContextFocusBranch1ValueTargetContext(..)
  , GatheredContextFocusBranch2Value(..)
  , GatheredContextFocusBranch2ValueContent(..)
  , GatheredContextFocusBranch2ValueContentRelated(..)
  , GatheredContextFocusBranch2ValueKind(..)
  , GatheredContextMetadata(..)
  , GatheredContextMetadataEntityTypeFrequencies(..)
  , GatheredContextSemanticContext(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Annotation
import Semiont.Internal.Generated.Models.KnowledgeGraph
import Semiont.Internal.Generated.Models.ResourceDescriptor
import Semiont.Internal.Generated.Models.SemanticMatch
data GatheredContext = GatheredContext { gatheredContextFocus :: GatheredContextFocus, gatheredContextGraph :: KnowledgeGraph, gatheredContextInferredRelationshipSummary :: Maybe (Text), gatheredContextMetadata :: GatheredContextMetadata, gatheredContextSemanticContext :: Maybe (GatheredContextSemanticContext), gatheredContextAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatheredContext where
  parseJSON = checked "GatheredContext" $ withObject "GatheredContext" (\fields -> GatheredContext <$> fields .: "focus" <*> fields .: "graph" <*> optional fields "inferredRelationshipSummary" <*> fields .: "metadata" <*> optional fields "semanticContext" <*> traverse parseJSON (withoutFields ["focus", "graph", "inferredRelationshipSummary", "metadata", "semanticContext"] fields))
instance ToJSON GatheredContext where toJSON value = Object (KM.fromList (concat [[("focus", toJSON (gatheredContextFocus value))], [("graph", toJSON (gatheredContextGraph value))], optionalPair "inferredRelationshipSummary" (gatheredContextInferredRelationshipSummary value), [("metadata", toJSON (gatheredContextMetadata value))], optionalPair "semanticContext" (gatheredContextSemanticContext value)]) <> fmap toJSON (withoutFields ["focus", "graph", "inferredRelationshipSummary", "metadata", "semanticContext"] (gatheredContextAdditionalProperties value)))

data GatheredContextFocus = GatheredContextFocusBranch1 (GatheredContextFocusBranch1Value) | GatheredContextFocusBranch2 (GatheredContextFocusBranch2Value) deriving (Eq, Show)
instance FromJSON GatheredContextFocus where
  parseJSON = checked "GatheredContextFocus" $ \value -> (GatheredContextFocusBranch1 <$> parseJSON value) <|> (GatheredContextFocusBranch2 <$> parseJSON value)
instance ToJSON GatheredContextFocus where
  toJSON (GatheredContextFocusBranch1 value) = toJSON value
  toJSON (GatheredContextFocusBranch2 value) = toJSON value


data GatheredContextFocusBranch1Value = GatheredContextFocusBranch1Value { gatheredContextFocusBranch1ValueAnnotation :: Annotation, gatheredContextFocusBranch1ValueKind :: GatheredContextFocusBranch1ValueKind, gatheredContextFocusBranch1ValueSelected :: Maybe (GatheredContextFocusBranch1ValueSelected), gatheredContextFocusBranch1ValueSourceResource :: ResourceDescriptor, gatheredContextFocusBranch1ValueTargetContext :: Maybe (GatheredContextFocusBranch1ValueTargetContext), gatheredContextFocusBranch1ValueTargetResource :: Maybe (ResourceDescriptor), gatheredContextFocusBranch1ValueUserHint :: Maybe (Text), gatheredContextFocusBranch1ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatheredContextFocusBranch1Value where
  parseJSON = checked "GatheredContextFocusBranch1Value" $ withObject "GatheredContextFocusBranch1Value" (\fields -> GatheredContextFocusBranch1Value <$> fields .: "annotation" <*> fields .: "kind" <*> optional fields "selected" <*> fields .: "sourceResource" <*> optional fields "targetContext" <*> optional fields "targetResource" <*> optional fields "userHint" <*> traverse parseJSON (withoutFields ["annotation", "kind", "selected", "sourceResource", "targetContext", "targetResource", "userHint"] fields))
instance ToJSON GatheredContextFocusBranch1Value where toJSON value = Object (KM.fromList (concat [[("annotation", toJSON (gatheredContextFocusBranch1ValueAnnotation value))], [("kind", toJSON (gatheredContextFocusBranch1ValueKind value))], optionalPair "selected" (gatheredContextFocusBranch1ValueSelected value), [("sourceResource", toJSON (gatheredContextFocusBranch1ValueSourceResource value))], optionalPair "targetContext" (gatheredContextFocusBranch1ValueTargetContext value), optionalPair "targetResource" (gatheredContextFocusBranch1ValueTargetResource value), optionalPair "userHint" (gatheredContextFocusBranch1ValueUserHint value)]) <> fmap toJSON (withoutFields ["annotation", "kind", "selected", "sourceResource", "targetContext", "targetResource", "userHint"] (gatheredContextFocusBranch1ValueAdditionalProperties value)))

data GatheredContextFocusBranch1ValueKind = GatheredContextFocusBranch1ValueKindAnnotation deriving (Eq, Show)
instance FromJSON GatheredContextFocusBranch1ValueKind where
  parseJSON = checked "GatheredContextFocusBranch1ValueKind" $ \value -> if value == (String "annotation") then pure GatheredContextFocusBranch1ValueKindAnnotation else fail "unknown enumeration member"
instance ToJSON GatheredContextFocusBranch1ValueKind where
  toJSON GatheredContextFocusBranch1ValueKindAnnotation = String "annotation"


data GatheredContextFocusBranch1ValueSelected = GatheredContextFocusBranch1ValueSelected { gatheredContextFocusBranch1ValueSelectedAfter :: Maybe (Text), gatheredContextFocusBranch1ValueSelectedBefore :: Maybe (Text), gatheredContextFocusBranch1ValueSelectedText :: Text, gatheredContextFocusBranch1ValueSelectedAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatheredContextFocusBranch1ValueSelected where
  parseJSON = checked "GatheredContextFocusBranch1ValueSelected" $ withObject "GatheredContextFocusBranch1ValueSelected" (\fields -> GatheredContextFocusBranch1ValueSelected <$> optional fields "after" <*> optional fields "before" <*> fields .: "text" <*> traverse parseJSON (withoutFields ["after", "before", "text"] fields))
instance ToJSON GatheredContextFocusBranch1ValueSelected where toJSON value = Object (KM.fromList (concat [optionalPair "after" (gatheredContextFocusBranch1ValueSelectedAfter value), optionalPair "before" (gatheredContextFocusBranch1ValueSelectedBefore value), [("text", toJSON (gatheredContextFocusBranch1ValueSelectedText value))]]) <> fmap toJSON (withoutFields ["after", "before", "text"] (gatheredContextFocusBranch1ValueSelectedAdditionalProperties value)))

data GatheredContextFocusBranch1ValueTargetContext = GatheredContextFocusBranch1ValueTargetContext { gatheredContextFocusBranch1ValueTargetContextContent :: Text, gatheredContextFocusBranch1ValueTargetContextSummary :: Maybe (Text), gatheredContextFocusBranch1ValueTargetContextAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatheredContextFocusBranch1ValueTargetContext where
  parseJSON = checked "GatheredContextFocusBranch1ValueTargetContext" $ withObject "GatheredContextFocusBranch1ValueTargetContext" (\fields -> GatheredContextFocusBranch1ValueTargetContext <$> fields .: "content" <*> optional fields "summary" <*> traverse parseJSON (withoutFields ["content", "summary"] fields))
instance ToJSON GatheredContextFocusBranch1ValueTargetContext where toJSON value = Object (KM.fromList (concat [[("content", toJSON (gatheredContextFocusBranch1ValueTargetContextContent value))], optionalPair "summary" (gatheredContextFocusBranch1ValueTargetContextSummary value)]) <> fmap toJSON (withoutFields ["content", "summary"] (gatheredContextFocusBranch1ValueTargetContextAdditionalProperties value)))

data GatheredContextFocusBranch2Value = GatheredContextFocusBranch2Value { gatheredContextFocusBranch2ValueContent :: Maybe (GatheredContextFocusBranch2ValueContent), gatheredContextFocusBranch2ValueKind :: GatheredContextFocusBranch2ValueKind, gatheredContextFocusBranch2ValueResource :: ResourceDescriptor, gatheredContextFocusBranch2ValueSuggestedReferences :: Maybe ([Text]), gatheredContextFocusBranch2ValueSummary :: Maybe (Text), gatheredContextFocusBranch2ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatheredContextFocusBranch2Value where
  parseJSON = checked "GatheredContextFocusBranch2Value" $ withObject "GatheredContextFocusBranch2Value" (\fields -> GatheredContextFocusBranch2Value <$> optional fields "content" <*> fields .: "kind" <*> fields .: "resource" <*> optional fields "suggestedReferences" <*> optional fields "summary" <*> traverse parseJSON (withoutFields ["content", "kind", "resource", "suggestedReferences", "summary"] fields))
instance ToJSON GatheredContextFocusBranch2Value where toJSON value = Object (KM.fromList (concat [optionalPair "content" (gatheredContextFocusBranch2ValueContent value), [("kind", toJSON (gatheredContextFocusBranch2ValueKind value))], [("resource", toJSON (gatheredContextFocusBranch2ValueResource value))], optionalPair "suggestedReferences" (gatheredContextFocusBranch2ValueSuggestedReferences value), optionalPair "summary" (gatheredContextFocusBranch2ValueSummary value)]) <> fmap toJSON (withoutFields ["content", "kind", "resource", "suggestedReferences", "summary"] (gatheredContextFocusBranch2ValueAdditionalProperties value)))

data GatheredContextFocusBranch2ValueContent = GatheredContextFocusBranch2ValueContent { gatheredContextFocusBranch2ValueContentMain :: Maybe (Text), gatheredContextFocusBranch2ValueContentRelated :: Maybe (GatheredContextFocusBranch2ValueContentRelated), gatheredContextFocusBranch2ValueContentAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatheredContextFocusBranch2ValueContent where
  parseJSON = checked "GatheredContextFocusBranch2ValueContent" $ withObject "GatheredContextFocusBranch2ValueContent" (\fields -> GatheredContextFocusBranch2ValueContent <$> optional fields "main" <*> optional fields "related" <*> traverse parseJSON (withoutFields ["main", "related"] fields))
instance ToJSON GatheredContextFocusBranch2ValueContent where toJSON value = Object (KM.fromList (concat [optionalPair "main" (gatheredContextFocusBranch2ValueContentMain value), optionalPair "related" (gatheredContextFocusBranch2ValueContentRelated value)]) <> fmap toJSON (withoutFields ["main", "related"] (gatheredContextFocusBranch2ValueContentAdditionalProperties value)))

data GatheredContextFocusBranch2ValueContentRelated = GatheredContextFocusBranch2ValueContentRelated { gatheredContextFocusBranch2ValueContentRelatedAdditionalProperties :: KM.KeyMap (Text) } deriving (Eq, Show)
instance FromJSON GatheredContextFocusBranch2ValueContentRelated where
  parseJSON = checked "GatheredContextFocusBranch2ValueContentRelated" $ withObject "GatheredContextFocusBranch2ValueContentRelated" (\fields -> GatheredContextFocusBranch2ValueContentRelated <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON GatheredContextFocusBranch2ValueContentRelated where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (gatheredContextFocusBranch2ValueContentRelatedAdditionalProperties value)))

data GatheredContextFocusBranch2ValueKind = GatheredContextFocusBranch2ValueKindResource deriving (Eq, Show)
instance FromJSON GatheredContextFocusBranch2ValueKind where
  parseJSON = checked "GatheredContextFocusBranch2ValueKind" $ \value -> if value == (String "resource") then pure GatheredContextFocusBranch2ValueKindResource else fail "unknown enumeration member"
instance ToJSON GatheredContextFocusBranch2ValueKind where
  toJSON GatheredContextFocusBranch2ValueKindResource = String "resource"


data GatheredContextMetadata = GatheredContextMetadata { gatheredContextMetadataEntityTypeFrequencies :: Maybe (GatheredContextMetadataEntityTypeFrequencies), gatheredContextMetadataEntityTypes :: Maybe ([Text]), gatheredContextMetadataLanguage :: Maybe (Text), gatheredContextMetadataResourceType :: Maybe (Text), gatheredContextMetadataAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatheredContextMetadata where
  parseJSON = checked "GatheredContextMetadata" $ withObject "GatheredContextMetadata" (\fields -> GatheredContextMetadata <$> optional fields "entityTypeFrequencies" <*> optional fields "entityTypes" <*> optional fields "language" <*> optional fields "resourceType" <*> traverse parseJSON (withoutFields ["entityTypeFrequencies", "entityTypes", "language", "resourceType"] fields))
instance ToJSON GatheredContextMetadata where toJSON value = Object (KM.fromList (concat [optionalPair "entityTypeFrequencies" (gatheredContextMetadataEntityTypeFrequencies value), optionalPair "entityTypes" (gatheredContextMetadataEntityTypes value), optionalPair "language" (gatheredContextMetadataLanguage value), optionalPair "resourceType" (gatheredContextMetadataResourceType value)]) <> fmap toJSON (withoutFields ["entityTypeFrequencies", "entityTypes", "language", "resourceType"] (gatheredContextMetadataAdditionalProperties value)))

data GatheredContextMetadataEntityTypeFrequencies = GatheredContextMetadataEntityTypeFrequencies { gatheredContextMetadataEntityTypeFrequenciesAdditionalProperties :: KM.KeyMap (Integer) } deriving (Eq, Show)
instance FromJSON GatheredContextMetadataEntityTypeFrequencies where
  parseJSON = checked "GatheredContextMetadataEntityTypeFrequencies" $ withObject "GatheredContextMetadataEntityTypeFrequencies" (\fields -> GatheredContextMetadataEntityTypeFrequencies <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON GatheredContextMetadataEntityTypeFrequencies where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (gatheredContextMetadataEntityTypeFrequenciesAdditionalProperties value)))

data GatheredContextSemanticContext = GatheredContextSemanticContext { gatheredContextSemanticContextExcludedEntityTypes :: Maybe ([Text]), gatheredContextSemanticContextSimilar :: [SemanticMatch], gatheredContextSemanticContextAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatheredContextSemanticContext where
  parseJSON = checked "GatheredContextSemanticContext" $ withObject "GatheredContextSemanticContext" (\fields -> GatheredContextSemanticContext <$> optional fields "excludedEntityTypes" <*> fields .: "similar" <*> traverse parseJSON (withoutFields ["excludedEntityTypes", "similar"] fields))
instance ToJSON GatheredContextSemanticContext where toJSON value = Object (KM.fromList (concat [optionalPair "excludedEntityTypes" (gatheredContextSemanticContextExcludedEntityTypes value), [("similar", toJSON (gatheredContextSemanticContextSimilar value))]]) <> fmap toJSON (withoutFields ["excludedEntityTypes", "similar"] (gatheredContextSemanticContextAdditionalProperties value)))

