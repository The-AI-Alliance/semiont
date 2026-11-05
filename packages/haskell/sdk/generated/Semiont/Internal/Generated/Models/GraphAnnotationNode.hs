-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GraphAnnotationNode
  ( GraphAnnotationNode(..)
  , GraphAnnotationNodeMetadata(..)
  , GraphAnnotationNodeType(..)
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
import Semiont.Internal.Generated.Models.AnnotationId
data GraphAnnotationNode = GraphAnnotationNode { graphAnnotationNodeAnnotation :: Annotation, graphAnnotationNodeEntityTypes :: Maybe ([Text]), graphAnnotationNodeId :: AnnotationId, graphAnnotationNodeLabel :: Text, graphAnnotationNodeMetadata :: Maybe (GraphAnnotationNodeMetadata), graphAnnotationNodeType :: GraphAnnotationNodeType, graphAnnotationNodeAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GraphAnnotationNode where
  parseJSON = checked "GraphAnnotationNode" $ withObject "GraphAnnotationNode" (\fields -> GraphAnnotationNode <$> fields .: "annotation" <*> optional fields "entityTypes" <*> fields .: "id" <*> fields .: "label" <*> optional fields "metadata" <*> fields .: "type" <*> traverse parseJSON (withoutFields ["annotation", "entityTypes", "id", "label", "metadata", "type"] fields))
instance ToJSON GraphAnnotationNode where toJSON value = Object (KM.fromList (concat [[("annotation", toJSON (graphAnnotationNodeAnnotation value))], optionalPair "entityTypes" (graphAnnotationNodeEntityTypes value), [("id", toJSON (graphAnnotationNodeId value))], [("label", toJSON (graphAnnotationNodeLabel value))], optionalPair "metadata" (graphAnnotationNodeMetadata value), [("type", toJSON (graphAnnotationNodeType value))]]) <> fmap toJSON (withoutFields ["annotation", "entityTypes", "id", "label", "metadata", "type"] (graphAnnotationNodeAdditionalProperties value)))

data GraphAnnotationNodeMetadata = GraphAnnotationNodeMetadata { graphAnnotationNodeMetadataAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GraphAnnotationNodeMetadata where
  parseJSON = checked "GraphAnnotationNodeMetadata" $ withObject "GraphAnnotationNodeMetadata" (\fields -> GraphAnnotationNodeMetadata <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON GraphAnnotationNodeMetadata where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (graphAnnotationNodeMetadataAdditionalProperties value)))

data GraphAnnotationNodeType = GraphAnnotationNodeTypeAnnotation deriving (Eq, Show)
instance FromJSON GraphAnnotationNodeType where
  parseJSON = checked "GraphAnnotationNodeType" $ \value -> if value == (String "annotation") then pure GraphAnnotationNodeTypeAnnotation else fail "unknown enumeration member"
instance ToJSON GraphAnnotationNodeType where
  toJSON GraphAnnotationNodeTypeAnnotation = String "annotation"


