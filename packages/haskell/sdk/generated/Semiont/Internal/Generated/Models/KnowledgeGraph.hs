-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KnowledgeGraph
  ( KnowledgeGraph(..)
  , KnowledgeGraphEdgesItem(..)
  , KnowledgeGraphEdgesItemMetadata(..)
  , KnowledgeGraphNodesItem(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.GraphAnnotationNode
import Semiont.Internal.Generated.Models.GraphResourceNode
data KnowledgeGraph = KnowledgeGraph { knowledgeGraphEdges :: [KnowledgeGraphEdgesItem], knowledgeGraphNodes :: [KnowledgeGraphNodesItem], knowledgeGraphTruncated :: Maybe (Bool), knowledgeGraphAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON KnowledgeGraph where
  parseJSON = checked "KnowledgeGraph" $ withObject "KnowledgeGraph" (\fields -> KnowledgeGraph <$> fields .: "edges" <*> fields .: "nodes" <*> optional fields "truncated" <*> traverse parseJSON (withoutFields ["edges", "nodes", "truncated"] fields))
instance ToJSON KnowledgeGraph where toJSON value = Object (KM.fromList (concat [[("edges", toJSON (knowledgeGraphEdges value))], [("nodes", toJSON (knowledgeGraphNodes value))], optionalPair "truncated" (knowledgeGraphTruncated value)]) <> fmap toJSON (withoutFields ["edges", "nodes", "truncated"] (knowledgeGraphAdditionalProperties value)))

data KnowledgeGraphEdgesItem = KnowledgeGraphEdgesItem { knowledgeGraphEdgesItemBidirectional :: Maybe (Bool), knowledgeGraphEdgesItemMetadata :: Maybe (KnowledgeGraphEdgesItemMetadata), knowledgeGraphEdgesItemSource :: Text, knowledgeGraphEdgesItemTarget :: Text, knowledgeGraphEdgesItemType :: Text, knowledgeGraphEdgesItemAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON KnowledgeGraphEdgesItem where
  parseJSON = checked "KnowledgeGraphEdgesItem" $ withObject "KnowledgeGraphEdgesItem" (\fields -> KnowledgeGraphEdgesItem <$> optional fields "bidirectional" <*> optional fields "metadata" <*> fields .: "source" <*> fields .: "target" <*> fields .: "type" <*> traverse parseJSON (withoutFields ["bidirectional", "metadata", "source", "target", "type"] fields))
instance ToJSON KnowledgeGraphEdgesItem where toJSON value = Object (KM.fromList (concat [optionalPair "bidirectional" (knowledgeGraphEdgesItemBidirectional value), optionalPair "metadata" (knowledgeGraphEdgesItemMetadata value), [("source", toJSON (knowledgeGraphEdgesItemSource value))], [("target", toJSON (knowledgeGraphEdgesItemTarget value))], [("type", toJSON (knowledgeGraphEdgesItemType value))]]) <> fmap toJSON (withoutFields ["bidirectional", "metadata", "source", "target", "type"] (knowledgeGraphEdgesItemAdditionalProperties value)))

data KnowledgeGraphEdgesItemMetadata = KnowledgeGraphEdgesItemMetadata { knowledgeGraphEdgesItemMetadataAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON KnowledgeGraphEdgesItemMetadata where
  parseJSON = checked "KnowledgeGraphEdgesItemMetadata" $ withObject "KnowledgeGraphEdgesItemMetadata" (\fields -> KnowledgeGraphEdgesItemMetadata <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON KnowledgeGraphEdgesItemMetadata where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (knowledgeGraphEdgesItemMetadataAdditionalProperties value)))

data KnowledgeGraphNodesItem = KnowledgeGraphNodesItemBranch1 (GraphResourceNode) | KnowledgeGraphNodesItemBranch2 (GraphAnnotationNode) deriving (Eq, Show)
instance FromJSON KnowledgeGraphNodesItem where
  parseJSON = checked "KnowledgeGraphNodesItem" $ \value -> (KnowledgeGraphNodesItemBranch1 <$> parseJSON value) <|> (KnowledgeGraphNodesItemBranch2 <$> parseJSON value)
instance ToJSON KnowledgeGraphNodesItem where
  toJSON (KnowledgeGraphNodesItemBranch1 value) = toJSON value
  toJSON (KnowledgeGraphNodesItemBranch2 value) = toJSON value
